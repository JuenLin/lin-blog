// 第 9 批「收藏」探针：A 幂等语义（与 like 刻意相反）/ B 收藏列表 / C 换账号不串号 / D UI 卡片星标
//
// 与 probe-like.mjs 的分工（两个都测「文章 × 用户」的关系，但语义相反）：
//   • probe-like.mjs    → 点赞：重复 409、取消未赞 404（**报错式**语义）；
//   • 本文件            → 收藏：重复 / 取消未收藏**都 200 幂等**（与 follow 同族，
//                         用户 2026-10-18 拍板，docs/API.md「收藏与阅读量」已写明）。
// 本探针的 A 组就是把这两条差异钉死的回归：断言「是 200 且 code=0」的同时，
// detail 里显式对照 like 的 409 / 404，将来有人「统一」两个语义时会立刻红。
//
// 与其他 Chrome 探针同一套规矩：
//   - 一次性 pwprobe 账号（A / B 两个，C 组验串号），不碰真实用户的收藏数据；
//   - 靶子文章全部是探针自造的，真实文章的 bookmarkCount 全程不受影响；
//   - finally 按收藏 → 文章 → 用户清理（bookmarks 双外键 RESTRICT，反序会被 1452 拦）；
//   - 自己起的 Chrome 自己关；
//   - 前置失败 exit 2、有 FAIL 或清理失败 exit 1、全绿 exit 0。
//
// ⚠️ 铁律（踩过两次）：
//   1) 验语法绝不能用 import() —— 会真的把探针跑一遍留下脏数据。语法交给 vite build。
//   2) 别用 `| head -N` / `| grep` 截断本脚本输出 —— 管道关闭会掐死 node，
//      finally 不跑，会留下 pwprobe 账号（已经发生过一次）。一律 `> 文件` 再 grep 那个文件。
//
// 用法：node scripts/acceptance/probe-bookmark.mjs
import path from 'node:path';
import { CONFIG, sleep, requireCjs, BACKEND, BACKEND_MODULES, ensureDirs } from './lib/config.mjs';
import { cleanupProbeAccounts } from './lib/tmp-account.mjs';
import { attach, cdpAlive } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';

/* ============================ 结果收集 ============================ */

const results = [];
let chromeChild = null;
let session = null;

function check(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} | ${desc} | ${detail}`);
}

function sectionSummary() {
  const groups = {};

  for (const r of results) {
    const g = r.id.charAt(0);
    if (!groups[g]) groups[g] = { pass: 0, fail: 0 };
    groups[g][r.pass ? 'pass' : 'fail'] += 1;
  }

  console.log('\n---- 分组小计 ----');
  for (const [g, s] of Object.entries(groups)) {
    console.log(`${g}组: PASS ${s.pass} / FAIL ${s.fail}`);
  }
}

/* ============================ HTTP 小工具 ============================ */

async function api(method, urlPath, { token = null, body = null } = {}) {
  const res = await fetch(`${CONFIG.api}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const json = await res.json().catch(() => null);

  return {
    status: res.status,
    code: json && json.code,
    message: json && json.message,
    data: json && json.data,
  };
}

const bookmark = (id, token) => api('POST', `/articles/${id}/bookmark`, { token });
const unbookmark = (id, token) => api('DELETE', `/articles/${id}/bookmark`, { token });

/* ============================ Prisma（仅供排序造数与清理） ============================ */

let prismaClient = null;
async function getPrisma() {
  if (prismaClient) return prismaClient;

  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));

  prismaClient = new PrismaClient();

  return prismaClient;
}

/* ============================ 前置检查 ============================ */

async function preflight() {
  const health = await api('GET', '/health');
  if (health.status !== 200) {
    console.error(`后端不可用（${CONFIG.api}/health → ${health.status}），先起后端再跑探针`);
    process.exit(2);
  }

  const front = await fetch(CONFIG.frontend)
    .then((r) => r.status)
    .catch(() => 0);
  if (front !== 200) {
    console.error(`前端不可用（${CONFIG.frontend} → ${front}），先起前端再跑探针（必须是 5173）`);
    process.exit(2);
  }
}

/* ============================ 主流程 ============================ */

const stamp = Date.now();

// A：主账号（语义 / 列表 / UI 全用它）；B：仅 C 组验「换账号不串号」用。
const A = { username: `pwprobe${stamp}a`, password: `probe${stamp}a`, token: null, userId: null };
const B = { username: `pwprobe${stamp}b`, password: `probe${stamp}b`, token: null, userId: null };

// 三篇靶子文章，分工明确：
//   artDel —— A 组语义 + 软删 404（跑完就删，不进列表组）；
//   art1 / art2 —— B 组收藏列表（分页 / 排序 / bookmarkedAt）与 C 组串号。
const artDel = { value: null };
const art1 = { value: null, createdAt: null };
const art2 = { value: null, createdAt: null };

async function registerAndLogin(acc) {
  const reg = await api('POST', '/auth/register', {
    body: { username: acc.username, password: acc.password, nickname: acc.username },
  });

  if (reg.status !== 201 && reg.status !== 200) {
    throw new Error(`注册失败 ${acc.username}：${reg.status} ${reg.message}`);
  }

  const login = await api('POST', '/auth/login', {
    body: { username: acc.username, password: acc.password },
  });

  if (!login.data || !login.data.token) {
    throw new Error(`登录失败 ${acc.username}：${login.status} ${login.message}`);
  }

  acc.token = login.data.token;
  acc.userId = login.data.user ? login.data.user.id : null;
}

async function createArticle(token, title) {
  const created = await api('POST', '/articles', {
    token,
    body: {
      title,
      summary: '探针自造靶子文章，跑完即物理删除',
      content: '仅供 probe-bookmark.mjs 使用。'.repeat(5),
      category: '未分类',
    },
  });

  if (!created.data || !created.data.id) {
    throw new Error(`造靶子文章失败：${created.status} ${created.message}`);
  }

  return created;
}

/* ============================ 页面小工具（D 组） ============================ */

async function waitFor(expression, timeout = 8000, interval = 200) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const raw = await session.evaluate(
      `(() => { try { return String(!!(${expression})); } catch (e) { return 'false'; } })()`
    );

    if (raw === 'true') return true;

    await sleep(interval);
  }

  return false;
}

/** 注入登录态并整页重进（AppHeader 的 onMounted 是拉收藏集合的入口，SPA 跳转不重走）。 */
async function gotoAs(token, urlPath) {
  await session.goto(`${CONFIG.frontend}${urlPath}`);

  if (token) {
    await session.evaluate(`localStorage.setItem('token', ${JSON.stringify(token)}); 'ok'`);
  } else {
    await session.evaluate(`localStorage.removeItem('token'); 'ok'`);
  }

  await session.goto(`${CONFIG.frontend}${urlPath}`);
}

/**
 * 读当前页面卡片的收藏态。
 * bookmarked 取 .article-bookmark 有没有 is-bookmarked 类 —— 这是星标的唯一判据
 * （对镜 probe-card-liked.mjs 的 readCards，那里读 .article-like 的 is-liked）。
 */
async function readCards() {
  const raw = await session.evaluate(`(() => {
    const cards = document.querySelectorAll('.article-card');
    return JSON.stringify(Array.from(cards).map((el) => {
      const m = /\\/article\\/(\\d+)/.exec(el.getAttribute('href') || '');
      const star = el.querySelector('.article-bookmark');
      return { id: m ? m[1] : '', bookmarked: star ? star.classList.contains('is-bookmarked') : null };
    }));
  })()`);

  return JSON.parse(raw || '[]');
}

/** 按文章 id 点星标（不用序号：首页排序一变 index 0 就不是靶子，会得到「测的是别人」的假绿）。 */
async function clickBookmarkButtonOf(articleId) {
  return session.evaluate(`(() => {
    const target = '/article/${articleId}';
    const card = Array.from(document.querySelectorAll('.article-card')).find((el) => el.getAttribute('href') === target);
    if (!card) return 'no-card';
    const star = card.querySelector('.article-bookmark');
    if (!star) return 'no-button';
    star.click();
    return 'ok';
  })()`);
}

/* ============================ 主流程 ============================ */

async function main() {
  await preflight();
  ensureDirs();

  console.log('\n[前置] 注册 A / B 两个探针账号');
  await registerAndLogin(A);
  await registerAndLogin(B);
  console.log(`A id=${A.userId} / B id=${B.userId}`);

  /* ---------- 造三篇靶子文章 ---------- */

  const del = await createArticle(A.token, `bookmark 语义靶子 ${stamp}`);
  artDel.value = del.data.id;

  const one = await createArticle(A.token, `bookmark 列表靶子 1 ${stamp}`);
  art1.value = one.data.id;
  art1.createdAt = one.data.createdAt;

  const two = await createArticle(A.token, `bookmark 列表靶子 2 ${stamp}`);
  art2.value = two.data.id;
  art2.createdAt = two.data.createdAt;

  console.log(`靶子文章：artDel=${artDel.value} art1=${art1.value} art2=${art2.value}\n`);

  /* ================= A 组：幂等语义（与 like 刻意相反） ================= */

  const a1 = await bookmark(artDel.value, A.token);
  check(
    'A1',
    '首次收藏 → 200 / code 0，bookmarked=true，bookmarkCount=1',
    a1.status === 200 && a1.code === 0 && a1.data && a1.data.bookmarked === true && a1.data.bookmarkCount === 1,
    `HTTP ${a1.status} code=${a1.code} ${JSON.stringify(a1.data)}`
  );

  // A2 是本探针的核心差异断言：点赞的重复是 40900，收藏的重复是**幂等 200**。
  // 显式写「不是 409」，将来有人把两个语义「统一」时会立刻红。
  const a2 = await bookmark(artDel.value, A.token);
  check(
    'A2',
    '重复收藏 → 200 幂等（与 like 的 409 刻意相反）',
    a2.status === 200 && a2.code === 0 && a2.data && a2.data.bookmarked === true && a2.data.bookmarkCount === 1,
    `HTTP ${a2.status} code=${a2.code}（若为 409 说明被「统一」成了点赞语义） ${JSON.stringify(a2.data)}`
  );

  const a3 = await unbookmark(artDel.value, A.token);
  check(
    'A3',
    '取消收藏 → 200 / code 0，bookmarked=false，bookmarkCount=0',
    a3.status === 200 && a3.code === 0 && a3.data && a3.data.bookmarked === false && a3.data.bookmarkCount === 0,
    `HTTP ${a3.status} code=${a3.code} ${JSON.stringify(a3.data)}`
  );

  // A4 同 A2：取消没收藏过的，点赞是 40400，收藏是**幂等 200**。
  const a4 = await unbookmark(artDel.value, A.token);
  check(
    'A4',
    '取消没收藏过的 → 200 幂等（与 like 的 404 刻意相反）',
    a4.status === 200 && a4.code === 0 && a4.data && a4.data.bookmarked === false,
    `HTTP ${a4.status} code=${a4.code}（若为 404 说明被「统一」成了点赞语义） ${JSON.stringify(a4.data)}`
  );

  // A5：查询接口只回 { bookmarked }，**不带 bookmarkCount** —— 与 GET /:id/liked 同纪律
  // （计数唯一来源是文章接口，同一个值两个口径将来无法判断哪个对）。
  const a5 = await api('GET', `/articles/${artDel.value}/bookmarked`, { token: A.token });
  check(
    'A5',
    'GET /articles/:id/bookmarked 只回 { bookmarked: false }，不带 bookmarkCount 键',
    a5.status === 200 &&
      a5.data &&
      typeof a5.data.bookmarked === 'boolean' &&
      a5.data.bookmarked === false &&
      !('bookmarkCount' in a5.data),
    `HTTP ${a5.status} ${JSON.stringify(a5.data)}`
  );

  /* ---------- A 组：未登录 / 非法 token → 401 ---------- */

  const a6 = await bookmark(artDel.value, null);
  check(
    'A6',
    '未登录收藏 → 401 / 40100',
    a6.status === 401 && a6.code === 40100,
    `HTTP ${a6.status} code=${a6.code} msg="${a6.message}"`
  );

  const a7 = await unbookmark(artDel.value, null);
  check(
    'A7',
    '未登录取消收藏 → 401 / 40100',
    a7.status === 401 && a7.code === 40100,
    `HTTP ${a7.status} code=${a7.code} msg="${a7.message}"`
  );

  const a8 = await api('GET', `/articles/${artDel.value}/bookmarked`);
  check(
    'A8',
    '未登录查询收藏态 → 401 / 40100',
    a8.status === 401 && a8.code === 40100,
    `HTTP ${a8.status} code=${a8.code} msg="${a8.message}"`
  );

  const a9 = await bookmark(artDel.value, 'not-a-real-token');
  check(
    'A9',
    'token 非法 → 401 / 40100',
    a9.status === 401 && a9.code === 40100,
    `HTTP ${a9.status} code=${a9.code} msg="${a9.message}"`
  );

  /* ---------- A 组：软删文章 → 三接口全 404 ---------- */

  const delRes = await api('DELETE', `/articles/${artDel.value}`, { token: A.token });
  check(
    'A10',
    '靶子文章软删成功（404 组前置）',
    delRes.status === 200,
    `HTTP ${delRes.status} ${delRes.message}`
  );

  const a11 = await bookmark(artDel.value, A.token);
  const a12 = await unbookmark(artDel.value, A.token);
  const a13 = await api('GET', `/articles/${artDel.value}/bookmarked`, { token: A.token });
  check(
    'A11',
    '软删文章：收藏 / 取消 / 查询 三接口全部 404 / 40400',
    a11.status === 404 &&
      a11.code === 40400 &&
      a12.status === 404 &&
      a12.code === 40400 &&
      a13.status === 404 &&
      a13.code === 40400,
    `POST=${a11.status}/${a11.code} DELETE=${a12.status}/${a12.code} GET=${a13.status}/${a13.code}`
  );

  /* ================= B 组：收藏列表 /users/me/bookmarks ================= */

  // 先收藏 art1，**睡 1.1s 再收藏 art2**：
  // 让 art2 的 bookmarkedAt 严格晚于 art1，B1 的「默认 desc」与 B3 的分页顺序
  // 才是确定性的（不依赖两篇恰好不在同一毫秒被收藏）。
  await bookmark(art1.value, A.token);
  await sleep(1100);
  await bookmark(art2.value, A.token);

  // ⚠️ 下面每个列表请求都必须带 A.token：/users/me/* 仅本人，漏 token 会吃 401
  // （B 组曾经整组忘带 token，6 条全红 —— 断言失败先查请求本身再怀疑产品）。
  const b1 = await api('GET', '/users/me/bookmarks', { token: A.token });
  const b1List = b1.data && Array.isArray(b1.data.list) ? b1.data.list : [];
  const b1Ids = b1List.map((a) => a.id);
  const b1First = b1List[0] || null;

  check(
    'B1',
    '收藏列表：total=2，默认 bookmarkedAt desc（art2 在前）',
    b1.status === 200 && b1.data && b1.data.total === 2 && b1Ids.length === 2 && b1First && b1First.id === art2.value,
    `HTTP ${b1.status} total=${b1.data && b1.data.total} 顺序=${JSON.stringify(b1Ids)}（期望 [${art2.value}, ${art1.value}]）`
  );

  // B2：bookmarkedAt 与文章自己的 createdAt 是两个时间（收藏时间 vs 发布时间），
  // 断言「存在且不相等且更晚」—— 平铺字段名对镜 likedAt，拿错就是这个探针要拦的 bug。
  const art1Row = b1List.find((a) => a.id === art1.value) || null;
  const bookmarkedAt = art1Row ? art1Row.bookmarkedAt : null;
  check(
    'B2',
    '列表项带平铺 bookmarkedAt，且与文章 createdAt 是不同的两个时间',
    Boolean(bookmarkedAt) &&
      Boolean(art1.createdAt) &&
      bookmarkedAt !== art1.createdAt &&
      new Date(bookmarkedAt).getTime() > new Date(art1.createdAt).getTime(),
    `art1 createdAt=${art1.createdAt} bookmarkedAt=${bookmarkedAt}`
  );

  // B3：真后端分页。pageSize=1 时第 1 页应是 art2（最新收藏）、第 2 页是 art1。
  const b3p1 = await api('GET', '/users/me/bookmarks?page=1&pageSize=1', { token: A.token });
  const b3p2 = await api('GET', '/users/me/bookmarks?page=2&pageSize=1', { token: A.token });
  const p1Ids = (b3p1.data && b3p1.data.list ? b3p1.data.list : []).map((a) => a.id);
  const p2Ids = (b3p2.data && b3p2.data.list ? b3p2.data.list : []).map((a) => a.id);
  check(
    'B3',
    '分页：pageSize=1 共 2 页，第 1 页 art2、第 2 页 art1',
    b3p1.data &&
      b3p1.data.totalPages === 2 &&
      p1Ids.length === 1 &&
      p1Ids[0] === art2.value &&
      p2Ids.length === 1 &&
      p2Ids[0] === art1.value,
    `totalPages=${b3p1.data && b3p1.data.totalPages} 第1页=${JSON.stringify(p1Ids)} 第2页=${JSON.stringify(p2Ids)}`
  );

  // B4 / B5：排序白名单 bookmarkedAt / createdAt / likeCount 合法，越界 400/40000（大小写敏感）。
  const b4 = await api('GET', '/users/me/bookmarks?sortBy=createdAt&order=asc', { token: A.token });
  const b5 = await api('GET', '/users/me/bookmarks?sortBy=notExist', { token: A.token });
  check(
    'B4',
    'sortBy=createdAt（白名单内）→ 200',
    b4.status === 200,
    `HTTP ${b4.status} msg="${b4.message}"`
  );
  check(
    'B5',
    'sortBy=notExist（越界）→ 400 / 40000',
    b5.status === 400 && b5.code === 40000,
    `HTTP ${b5.status} code=${b5.code} msg="${b5.message}"`
  );

  // B6：列表项与文章列表同形（同一个 toArticleListItem），viewCount / likeCount 都在。
  const b6Row = b1List[0] || {};
  check(
    'B6',
    '列表项与文章列表同形：带 viewCount / likeCount 字段',
    typeof b6Row.viewCount === 'number' && typeof b6Row.likeCount === 'number' && typeof b6Row.title === 'string',
    `首项字段：viewCount=${b6Row.viewCount} likeCount=${b6Row.likeCount} title=${JSON.stringify(b6Row.title)}`
  );

  /* ================= C 组：换账号不串号（API 层） ================= */

  // C1：B 从没收藏过，他的列表必须是空的 —— A 收藏的两篇不能出现在 B 的清单里。
  const c1 = await api('GET', '/users/me/bookmarks', { token: B.token });
  const c1Ids = (c1.data && c1.data.list ? c1.data.list : []).map((a) => a.id);
  check(
    'C1',
    'B 的收藏列表为空（A 收藏的文章不串到 B 名下）',
    c1.status === 200 && c1.data && c1.data.total === 0 && c1Ids.length === 0,
    `HTTP ${c1.status} total=${c1.data && c1.data.total} ids=${JSON.stringify(c1Ids)}`
  );

  // C2：bookmarkCount 是**全站该文章**的总收藏数，不是「我的收藏数」——
  // A 已收藏 art1，B 再收藏同一篇，计数应变成 2。
  const c2 = await bookmark(art1.value, B.token);
  check(
    'C2',
    'B 收藏 A 已收藏的 art1 → 200，bookmarkCount=2（全站口径，非「我的」）',
    c2.status === 200 && c2.data && c2.data.bookmarked === true && c2.data.bookmarkCount === 2,
    `HTTP ${c2.status} ${JSON.stringify(c2.data)}`
  );

  const c3 = await api('GET', '/users/me/bookmarks', { token: B.token });
  check(
    'C3',
    'B 的列表现在只有 art1（total=1，互不污染）',
    c3.status === 200 && c3.data && c3.data.total === 1 && c3.data.list[0] && c3.data.list[0].id === art1.value,
    `HTTP ${c3.status} total=${c3.data && c3.data.total} ids=${JSON.stringify((c3.data && c3.data.list ? c3.data.list : []).map((a) => a.id))}`
  );

  /* ================= D 组：UI 卡片星标 ================= */

  if (!(await cdpAlive())) {
    chromeChild = (await launchChrome()).child;
    await sleep(1500);
  }

  session = await attach();
  await session.send('Network.enable');

  const requests = [];
  session.onEvent((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      requests.push({ url: msg.params.request.url, method: msg.params.request.method });
    }
  });

  const countBookmarksReq = () =>
    requests.filter((r) => r.method === 'GET' && r.url.includes('/users/me/bookmarks')).length;

  // D0：未登录访问首页，既不打收藏清单，也不被踢去登录页。
  await gotoAs(null, '/');
  const d0Cards = await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  await sleep(1200);
  const d0Path = await session.evaluate(`location.pathname`);
  check(
    'D0',
    '未登录访问首页：不发 /users/me/bookmarks，也没被踢到登录页',
    d0Cards && countBookmarksReq() === 0 && d0Path === '/',
    `卡片渲染=${d0Cards}，/users/me/bookmarks 请求数=${countBookmarksReq()}，path=${d0Path}`
  );

  // D1：登录后只拉一次（AppHeader.ensureLoaded）。若将来改成每卡一次，这里立刻变 N。
  requests.length = 0;
  await gotoAs(A.token, '/');
  const d1Ready = await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  await sleep(1500);
  check(
    'D1',
    '登录进入首页：GET /users/me/bookmarks 恰好 1 次（一次性，非每卡一次）',
    d1Ready && countBookmarksReq() === 1,
    `/users/me/bookmarks=${countBookmarksReq()} 次`
  );

  // D2：**核心回归** —— 刷新之后收藏过的卡片仍应是金色星标。
  // 对镜 probe-card-liked 的 A3（点赞刷新后仍红）：公开列表不返回 bookmarked，
  // 认不出刷新就是 likedStore 方案要解决的那个现象。
  const d2Cards = await readCards();
  const d2One = d2Cards.find((c) => c.id === String(art1.value));
  const d2Two = d2Cards.find((c) => c.id === String(art2.value));
  check(
    'D2',
    '刷新后收藏过的卡片仍是金色 ★（art1 / art2 两张都认得出）',
    Boolean(d2One) && d2One.bookmarked === true && Boolean(d2Two) && d2Two.bookmarked === true,
    d2One && d2Two
      ? `art1 is-bookmarked=${d2One.bookmarked}，art2 is-bookmarked=${d2Two.bookmarked}`
      : `首页没找到靶子（卡片 ${d2Cards.length} 张：${JSON.stringify(d2Cards.map((c) => c.id))}）`
  );

  // D3：用户主页「收藏」Tab —— 清单里的卡片应全部带星标，且顺序与
  // 接口默认排序一致（art2 最新收藏在前）。
  //
  // ⚠️ 顺序在 D3a/D3b（点星标往返）**之前**跑：D3b 会重新收藏 art1，
  // 把它的 bookmarkedAt 刷新成最新，那时顺序就变成 [art1, art2] 了 ——
  // 那是正确行为，不是回归，但会把「验默认排序」的断言变成偶然通过。
  await gotoAs(A.token, `/user/${A.userId}`);
  const d3TabReady = await waitFor(
    `Array.from(document.querySelectorAll('.el-tabs__item')).some((e) => e.textContent.trim() === '收藏')`,
    8000
  );
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '收藏');
    if (tab) tab.click();
    return 'ok';
  })()`);
  const d3CardsReady = await waitFor(`document.querySelectorAll('.article-card').length > 0`, 10000);
  await sleep(1200);

  const d3Cards = await readCards();
  const d3Ids = d3Cards.map((c) => c.id);
  check(
    'D3',
    '收藏 Tab：清单里卡片全部带星标，且 art2 在 art1 前（默认 bookmarkedAt desc）',
    d3TabReady &&
      d3CardsReady &&
      d3Cards.length === 2 &&
      d3Cards.every((c) => c.bookmarked === true) &&
      d3Ids[0] === String(art2.value) &&
      d3Ids[1] === String(art1.value),
    `Tab就绪=${d3TabReady} 卡片=${JSON.stringify(d3Cards.map((c) => ({ id: c.id, star: c.bookmarked })))}`
  );

  /* ---------- D4：点星标往返（必须只切收藏态、不跳详情页） ---------- */

  await gotoAs(A.token, '/');
  await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  await sleep(1200);

  // 卡片整块是 <a>，只写 .stop 拦不住原生导航 —— 这条就是 @click.prevent.stop 的
  // 直接回归测试（对镜 probe-like.mjs 的 E4）。
  const d4Before = await session.evaluate(`location.pathname`);
  await clickBookmarkButtonOf(art1.value);
  const d4Off = await waitFor(
    `(() => { const el = document.querySelector('.article-card[href="/article/${art1.value}"] .article-bookmark'); return Boolean(el) && !el.classList.contains('is-bookmarked'); })()`,
    6000
  );
  const d4AfterUrl = await session.evaluate(`location.pathname`);
  check(
    'D4a',
    '点星标：is-bookmarked 消失且不跳详情页（.prevent.stop 生效）',
    d4Off && d4AfterUrl === d4Before,
    `路径 ${d4Before} → ${d4AfterUrl}，星标关闭=${d4Off}`
  );

  // 再点一次恢复（幂等按钮的完整往返）。
  await clickBookmarkButtonOf(art1.value);
  const d4On = await waitFor(
    `(() => { const el = document.querySelector('.article-card[href="/article/${art1.value}"] .article-bookmark'); return Boolean(el) && el.classList.contains('is-bookmarked'); })()`,
    6000
  );
  check(
    'D4b',
    '再点一次星标：恢复 is-bookmarked（完整往返）',
    d4On,
    `星标恢复=${d4On}`
  );
}

/* ============================ 收尾 ============================ */

function summarize() {
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;

  console.log(`\n合计 ${results.length} 条：PASS ${pass} / FAIL ${fail}`);

  if (fail > 0) {
    console.log('\n失败项：');
    results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.id} ${r.desc} → ${r.detail}`));
  }

  return fail === 0 ? 0 : 1;
}

let exitCode = 2; // 默认按「前置失败」处理，正常进到 main 末尾会被 summarize 覆盖

try {
  await main();

  if (results.length === 0) {
    console.error('\n零断言：main 没跑到第一组就退出了');
    exitCode = 2;
  } else {
    exitCode = summarize();
  }
} catch (error) {
  console.error('\n探针异常终止：', error && error.message ? error.message : error);
  sectionSummary();
  exitCode = 1;
} finally {
  sectionSummary();

  if (session) {
    session.offEvent(() => {});
    session.close();
  }

  if (chromeChild) {
    await stopChrome(chromeChild);
  }

  // 清理：走 tmp-account 的统一通道（notifications → bookmarks → likes → follows
  // → comments → articles → users）。B 收藏过 A 的靶子文章，按 articleId 双侧清理，
  // 不会漏；只删 pwprobe 前缀账号，绝不误伤真实用户。
  try {
    const users = await cleanupProbeAccounts([A.username, B.username]);
    console.log(`\n清理：删除探针账号 ${users} 个（含其自造文章与全部收藏关系）`);
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
