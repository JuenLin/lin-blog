// 列表卡片「已点赞态」同步探针（likedStore 缓存方案）
//
// ── 本探针 vs probe-liked.mjs 的分工（务必分清，两个都叫 liked 但测的不是一回事）──
//   • probe-liked.mjs      → 验【详情页】那颗按钮的态：走 `GET /api/articles/:id/liked`
//                            接口，断言刷新后按钮还原成 is-liked、aria-pressed 同步、按文章 id 重拉。
//   • probe-card-liked.mjs（本文件） → 验【列表卡片】那颗爱心的态：走前端 likedStore
//                            缓存（登录后拉 `GET /api/users/me/likes`，命中即红），断言刷新后仍红、
//                            广场/文章Tab/点赞Tab 三处都认得、换账号不串号。
//   一句话：probe-liked 管「点开详情后按钮对不对」，本探针管「没点开详情、在列表里一眼看到的红心对不对」。
//
// 背景：列表类接口都是公开接口，按 docs/API.md 通用约定不返回 liked。
// 改之前 ArticleCard 的 liked 只是一个组件内的 ref，刷新就没了 ——
// 表现为「已经点过赞的，一开始不显示红色，点了之后才弹『你已经点过赞了』」。
//
// 方案：登录后拉一次 GET /api/users/me/likes，把「我赞过的文章 id」缓存在
// frontend/src/stores/liked.js，卡片渲染时查集合，命中即红。具体设计见那个文件的顶部注释。
//
// A 组：请求纪律 + 核心回归（刷新后仍红 —— 用户报的那个现象）
// B 组：三处列表点位都要生效（广场 / 文章 Tab / 点赞 Tab）
// C 组：写回与登出边界
// D 组：**跨账号串号防线**（最容易出的真 bug）
// E 组：401 路径永久回归（认证态清空：localStorage.token 被清 + likedStore.Set 清空 + 头部退回登录按钮）
//
// 与其他 Chrome 探针同一套规矩：
//   - 一次性 pwprobe 账号 + 探针自造文章，finally 清理，不碰真实用户数据；
//   - 清理顺序 likes → comments → articles → users（外键 RESTRICT，反序会被 1452 拦）；
//   - 自己起的 Chrome 自己关；
//   - 前置失败 exit 2、有 FAIL 或清理失败 exit 1、全绿 exit 0。
//
// ⚠️ 铁律（踩过两次）：
//   1) 验语法**绝不能用 import()** —— 会真的把探针跑一遍留下脏数据。语法交给 vite build。
//   2) 别用 `| head -N` / `| grep` 截断本脚本输出 —— 管道关闭会掐死 node，
//      finally 不跑，会留下 pwprobe 账号（已经发生过一次）。一律 `> 文件` 再 grep 那个文件。
//
// 用法：node scripts/acceptance/probe-card-liked.mjs
import path from 'node:path';
import { CONFIG, sleep, requireCjs, BACKEND, BACKEND_MODULES, ensureDirs } from './lib/config.mjs';
import { attach } from './lib/cdp.mjs';
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

  // 取首字母当组名：断言编号是 'A1' / 'D2' 这种没有分隔符的形式，
  // 按 '-' 切会把每条都当成独立一组（曾经输出「A1组: PASS 1」这种无意义的小计）。
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

/* ============================ 页面小工具 ============================ */

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

/**
 * 注入登录态并重新进页面。
 * 用 goto 而不是原地 push：AppHeader 的 onMounted 是拉集合的入口，
 * 只有整页重载才会重新走一遍（SPA 路由跳转不会重挂载 AppHeader）。
 */
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
 * 读当前页面上的卡片状态。
 * id 取 href 末段（.article-card 是 router-link 渲染的真实 <a href="/article/123">），
 * liked 取 .article-like 有没有 is-liked 类 —— 这是 ArticleCard 里红心的唯一判据。
 */
async function readCards() {
  const raw = await session.evaluate(`(() => {
    const cards = document.querySelectorAll('.article-card');
    return JSON.stringify(Array.from(cards).map((el) => {
      const m = /\\/article\\/(\\d+)/.exec(el.getAttribute('href') || '');
      const like = el.querySelector('.article-like');
      return { id: m ? m[1] : '', liked: like ? like.classList.contains('is-liked') : null };
    }));
  })()`);

  return JSON.parse(raw || '[]');
}

/**
 * 点某张卡的点赞按钮。**按文章 id 定位**，不用序号 ——
 * 首页排序一变，index 0 就不再是靶子文章，用序号会得到「看起来通过但测的是别人」的假绿。
 */
async function clickLikeButtonOf(articleId) {
  return session.evaluate(`(() => {
    const target = '/article/${articleId}';
    const card = Array.from(document.querySelectorAll('.article-card')).find((el) => el.getAttribute('href') === target);
    if (!card) return 'no-card';
    const like = card.querySelector('.article-like');
    if (!like) return 'no-button';
    like.click();
    return 'ok';
  })()`);
}

/* ============================ Prisma（仅供清理） ============================ */

let prismaClient = null;

async function getPrisma() {
  if (prismaClient) return prismaClient;

  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  const mod = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));

  prismaClient = new mod.PrismaClient();

  return prismaClient;
}

/* ============================ 前置：服务与账号 ============================ */

const stamp = Date.now();

const A = { username: `pwprobe${stamp}a`, password: `probe${stamp}a`, token: null, userId: null };
const B = { username: `pwprobe${stamp}b`, password: `probe${stamp}b`, token: null, userId: null };

const targetArticleId = { value: null };

async function healthCheck() {
  const back = await fetch(`${CONFIG.api}/health`)
    .then((r) => r.status)
    .catch(() => 0);

  if (back !== 200) {
    console.error(`后端不可用（${CONFIG.api}/health → ${back}），先起后端再跑探针`);
    return false;
  }

  const front = await fetch(CONFIG.frontend)
    .then((r) => r.status)
    .catch(() => 0);

  if (front !== 200) {
    console.error(`前端不可用（${CONFIG.frontend} → ${front}），先起前端再跑（必须是 5173）`);
    return false;
  }

  return true;
}

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

/* ============================ 主流程 ============================ */

async function main() {
  if (!(await healthCheck())) return;

  ensureDirs();

  console.log('\n[前置] 注册 A / B 两个探针账号');
  await registerAndLogin(A);
  await registerAndLogin(B);
  console.log(`A id=${A.userId} / B id=${B.userId}`);

  /* ---- A 造一篇靶子文章并点赞（后面全部断言围绕它） ---- */
  const created = await api('POST', '/articles', {
    token: A.token,
    body: {
      title: `liked-sync 靶子 ${stamp}`,
      summary: '探针自造，用于验证卡片上的红心是否与后端同步',
      content: '正文。'.repeat(20),
      category: '未分类',
    },
  });

  if (!created.data || !created.data.id) {
    throw new Error(`造靶子文章失败：${created.status} ${created.message}`);
  }

  targetArticleId.value = created.data.id;
  console.log(`靶子文章 id=${targetArticleId.value}`);

  await api('POST', `/articles/${targetArticleId.value}/like`, { token: A.token });

  /* ---------- 起 Chrome ---------- */

  chromeChild = await launchChrome();
  session = await attach();

  await session.send('Network.enable');

  const requests = [];
  session.onEvent((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      requests.push({ url: msg.params.request.url, method: msg.params.request.method });
    }
  });

  const countLikesReq = () =>
    requests.filter((r) => r.method === 'GET' && r.url.includes('/users/me/likes')).length;

  /* ================= A 组：请求纪律 + 核心回归 ================= */

  await gotoAs(null, '/');
  const a1Cards = await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  await sleep(1200);

  const a1Path = await session.evaluate(`location.pathname`);
  check(
    'A1',
    '未登录访问首页：不发 /users/me/likes，也没被踢到登录页',
    a1Cards && countLikesReq() === 0 && a1Path === '/',
    `卡片渲染=${a1Cards}，/users/me/likes 请求数=${countLikesReq()}，path=${a1Path}`
  );

  // A2：登录后只拉一次。整页重载会重走 AppHeader.onMounted，所以每次 goto 预期恰好 1 条；
  // 若将来改成在 ArticleCard 里按文章查（每个约会 N 次），这里立刻变 N —— 与
  // probe-like.mjs 的 E1「列表只发 1 次 GET /api/articles」是同类的 N+1 防线。
  requests.length = 0;
  await gotoAs(A.token, '/');
  const a2Ready = await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  await sleep(1500);

  const a2Count = countLikesReq();
  const a2All = requests.filter((r) => r.method === 'GET' && r.url.includes('/api/')).map((r) =>
    r.url.replace(CONFIG.api, '')
  );

  check(
    'A2',
    '登录进入首页：GET /users/me/likes 恰好 1 次（一次性，非每卡一次）',
    a2Ready && a2Count === 1,
    `/users/me/likes=${a2Count} 次；本段全部 GET=${JSON.stringify(a2All)}`
  );

  // A3：**核心回归** —— 刷新之后靶子文章那张卡仍应是红的。
  // 改之前刷新会让红心回到空心，用户再点一次才拿到 409「已点赞过这篇文章」。
  const afterRefresh = await readCards();
  const target = afterRefresh.find((c) => c.id === String(targetArticleId.value));

  check(
    'A3',
    '刷新后卡片仍是红色 ♥（用户报的现象：点了才说已赞过）',
    Boolean(target) && target.liked === true,
    target
      ? `靶子 id=${target.id} is-liked=${target.liked}`
      : `首页没找到靶子卡片（卡片 ${afterRefresh.length} 张：${JSON.stringify(afterRefresh.map((c) => c.id))}）`
  );

  /* ================= B 组：三处列表点位都要生效 ================= */

  const plaza = await readCards();
  const plazaLiked = plaza.filter((c) => c.liked);
  const plazaRest = plaza.filter((c) => c.id !== String(targetArticleId.value));

  // B1 同时验证两件事：赞过的红、没赞过的灰。同一列表内两态共存，
  // 才说明 liked 是按 props.article.id 各自求值（computed），不是整页一个开关。
  check(
    'B1',
    '广场列表：己赞的红、其他人的灰（两态共存，证明按 id 分别求值）',
    plaza.length > 1 &&
      Boolean(target) &&
      target.liked === true &&
      plazaRest.length > 0 &&
      plazaRest.every((c) => c.liked === false),
    `卡片 ${plaza.length} 张，红色 ${plazaLiked.length} 张（应恰好 1），靶子 is-liked=${target ? target.liked : 'N/A'}`
  );

  // B2 用户主页的「文章」Tab：数据源换成了 GET /api/users/:id/articles，
  // 与广场是两个不同的接口，必须各自都认得红心。
  await gotoAs(A.token, `/user/${A.userId}`);
  const b2Ready = await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  await sleep(1200);

  const own = await readCards();
  const ownTarget = own.find((c) => c.id === String(targetArticleId.value));

  check(
    'B2',
    '用户主页文章 Tab：己赞的那篇仍是红的（另一套接口也认得）',
    b2Ready && Boolean(ownTarget) && ownTarget.liked === true,
    ownTarget
      ? `靶子 is-liked=${ownTarget.liked}，卡片 ${own.length} 张`
      : `文章 Tab 没找到靶子（卡片 ${own.length} 张：${JSON.stringify(own.map((c) => c.id))}）`
  );

  // B3 点赞 Tab：这一屏本来就是「我赞过」的清单，所以应该**全部**是红的。
  // 反过来如果这里有一张是灰的，说明 likedAt → Set 这条链路断了。
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '点赞');
    if (!tab) return 'no-tab';
    tab.click();
    return 'ok';
  })()`);
  const b3Ready = await waitFor(`document.querySelectorAll('.article-card').length > 0`, 10000);
  await sleep(1200);

  const likedTab = await readCards();

  check(
    'B3',
    '点赞 Tab：清单里的卡片全部是红的（数据本身即「我赞过」）',
    b3Ready && likedTab.length > 0 && likedTab.every((c) => c.liked === true),
    `卡片 ${likedTab.length} 张，红色 ${likedTab.filter((c) => c.liked).length} 张`
  );

  /* ================= C 组：写回与登出边界 ================= */

  // C1 取消点赞后必须即时变灰。
  // 这条同时覆盖「换到未赞的文章 / 同一张卡由赞变不赞时 computed 重算」——
  // liked 是从 Set 算出来的 computed（ArticleCard 里那行 `liked.value = false` 的
  // watch 已经删掉了），这里用真实渲染结果验证它确实会重算，不靠推理。
  await gotoAs(A.token, '/');
  await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  await sleep(1200);

  const targetSelector = `.article-card[href="/article/${targetArticleId.value}"] .article-like`;

  await clickLikeButtonOf(targetArticleId.value);
  await waitFor(
    `(() => { const el = document.querySelector('${targetSelector}'); return Boolean(el) && !el.classList.contains('is-liked'); })()`
  );
  await sleep(600);

  const afterUnlike = await readCards();
  const t2 = afterUnlike.find((c) => c.id === String(targetArticleId.value));

  check(
    'C1',
    '取消点赞后该卡片即时变灰（computed 随 Set 重算，非整页缓存）',
    Boolean(t2) && t2.liked === false,
    t2 ? `靶子 is-liked=${t2.liked}，同页红色 ${afterUnlike.filter((c) => c.liked).length} 张` : '未找到靶子卡片'
  );

  // C2 真 UI 登出（走 userStore.logout() → setToken('') → likedStore.reset()）：
  // 之后列表必须全灰，且不再给已登出的人打 /users/me/likes。
  await session.evaluate(`(() => {
    const trigger = document.querySelector('.user-dropdown');
    if (!trigger) return 'no-trigger';
    trigger.click();
    return 'ok';
  })()`);
  const menuUp = await waitFor(
    `Array.from(document.querySelectorAll('.el-dropdown-menu__item')).some((e) => e.textContent.trim() === '退出登录')`,
    6000
  );
  await session.evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.el-dropdown-menu__item')).find((e) => e.textContent.trim() === '退出登录');
    if (item) item.click();
    return 'ok';
  })()`);
  const backHome = await waitFor(`location.pathname === '/'`, 8000);
  await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  await sleep(1200);

  const afterLogout = await readCards();
  const logoutRed = afterLogout.filter((c) => c.liked);

  // 登出后再观察一段：不应再给「已登出的人」打 /users/me/likes。
  // AppHeader 的 watch(token) 此时会触发一次（token 由 A 的值变成空），
  // 但回调里 `if (!next) return` 会挡住 —— 这条就是挡住它的那道判断的回归测试。
  requests.length = 0;
  await sleep(1500);
  const afterLogoutReqs = countLikesReq();

  check(
    'C2',
    'UI 登出后：列表全灰 + 不再发 /users/me/likes（logout 会清 Set）',
    menuUp &&
      backHome &&
      afterLogout.length > 0 &&
      logoutRed.length === 0 &&
      afterLogoutReqs === 0,
    `菜单出现=${menuUp}，回到首页=${backHome}，卡片 ${afterLogout.length} 张，红色 ${logoutRed.length} 张，登出后新增请求 ${afterLogoutReqs} 条`
  );

  /* ================= D 组：跨账号串号防线 ================= */

  // D1 是本方案最容易出的真 bug：上一个账号赞过的文章，在下一个人首页上也显示红色。
  // 防线在 setToken() 里开关 —— 断言**最终渲染结果是灰的**，不是「reset 被调用过」。
  requests.length = 0;
  await gotoAs(B.token, '/');
  const d1Ready = await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  await sleep(1500);

  const bView = await readCards();
  const bTarget = bView.find((c) => c.id === String(targetArticleId.value));
  const bRed = bView.filter((c) => c.liked);

  check(
    'D1',
    '换账号：A 赞过的文章在 B 的首页上是灰的（不串号）',
    d1Ready && Boolean(bTarget) && bTarget.liked === false && bRed.length === 0,
    bTarget
      ? `靶子 id=${bTarget.id} is-liked=${bTarget.liked}；全页红色 ${bRed.length} 张（应 0）`
      : `B 的首页没找到靶子（卡片 ${bView.length} 张：${JSON.stringify(bView.map((c) => c.id))}）`
  );

  const d1Count = countLikesReq();
  check(
    'D2',
    '换账号后重新拉一次 B 的集合（恰好 1 次）',
    d1Count === 1,
    `/users/me/likes=${d1Count} 次（Reset 后应重拉）`
  );

  /* ================= E 组：401 路径永久回归（认证态清空） ================= */
  // 这是一次真 bug 修复的回归保护：request.js 401 分支只 removeItem + dispatchEvent('auth:cleared')，
  // 不调 setToken。若有人「优化」改回直接 import store，401 路径会悄悄退回 bug。
  // 取证法：造非法 token 写进 localStorage → 点别的卡的赞按钮触发 PUT /like → 401；
  // 在 auth:cleared 派发后的 nextTick 抓首页快照（此时 reset 已 flush、router 尚未跳转）。
  // E1 localStorage.token 被清 / E2 likedStore.Set 清空（靶子变灰、红卡=0）/ E3 头部退回登录按钮。

  // E0 前置：以 A 重新登录进首页，且把靶子重新点回赞（C1 把它取消了），
  // 这样靶子是红的、头部有下拉（已登录态）—— 给 E2 一个「红→灰」的真实起点。
  await api('POST', `/articles/${targetArticleId.value}/like`, { token: A.token });
  await gotoAs(A.token, '/');
  const e0Ready = await waitFor(`document.querySelectorAll('.article-card').length > 0`);
  const e0Red = await waitFor(`(() => {
    const el = document.querySelector('.article-card[href="/article/${targetArticleId.value}"] .article-like');
    return Boolean(el) && el.classList.contains('is-liked');
  })()`, 10000);
  await sleep(300);
  const e0Cards = await readCards();
  const e0Target = e0Cards.find((c) => c.id === String(targetArticleId.value));
  const e0Dropdown = await session.evaluate(`!!document.querySelector('.user-dropdown')`);
  check(
    'E0',
    'E 组前置：以 A 登录进首页，靶子红 + 头部有登录态（下拉存在）',
    e0Ready && Boolean(e0Target) && e0Target.liked === true && e0Dropdown,
    e0Target
      ? `靶子 is-liked=${e0Target.liked}，下拉存在=${e0Dropdown}`
      : `首页没找到靶子（卡片 ${e0Cards.length} 张）`
  );

  // 选一张非靶子的卡来点（其实任意卡都会因非法 token 先撞 401，但避开靶子更清晰）。
  const otherCard = e0Cards.find((c) => c.id !== String(targetArticleId.value)) || e0Target;

  // 注册 auth:cleared 快照监听：401 那一瞬间抓首页 DOM，nextTick 后读（确保 reset 已 flush）。
  await session.evaluate(`(() => {
    window.__authSnap = null;
    window.addEventListener('auth:cleared', () => {
      Promise.resolve().then(() => {
        const t = '/article/${targetArticleId.value}';
        const el = document.querySelector('.article-card[href="' + t + '"] .article-like');
        window.__authSnap = JSON.stringify({
          path: location.pathname,
          lsToken: localStorage.getItem('token'),
          targetLiked: el ? el.classList.contains('is-liked') : null,
          redCount: document.querySelectorAll('.article-card .article-like.is-liked').length
        });
      });
    }, { once: true });
    return 'ok';
  })()`);

  // 造非法 token 写进 localStorage（不重载页面 —— 请求拦截器每次从 localStorage 现读）。
  await session.evaluate(`localStorage.setItem('token', 'not.a.valid.jwt'); 'ok'`);

  // 触发 401：点另一张卡的赞按钮。
  const eTrigger = await clickLikeButtonOf(otherCard.id);

  // 等快照（nextTick 内同步写好，几乎瞬时；给 8s 兜底）。
  const eSnapReady = await waitFor(`window.__authSnap !== null`, 8000);
  const eSnapRaw = await session.evaluate(`window.__authSnap`);
  let eSnap = null;
  try {
    eSnap = eSnapRaw ? JSON.parse(eSnapRaw) : null;
  } catch {
    eSnap = null;
  }

  check(
    'E1',
    '401 后 localStorage.token 已被清（removeItem 生效）',
    eSnapReady && Boolean(eSnap) && eSnap.lsToken === null,
    eSnap ? `lsToken=${eSnap.lsToken}，触发=${eTrigger}` : `未抓到快照（触发=${eTrigger}）`
  );

  check(
    'E2',
    '401 后 likedStore.Set 已清空：靶子变灰 + 全页红卡=0（首页瞬间快照）',
    Boolean(eSnap) && eSnap.path === '/' && eSnap.targetLiked === false && eSnap.redCount === 0,
    eSnap
      ? `path=${eSnap.path}，靶子 is-liked=${eSnap.targetLiked}，红卡=${eSnap.redCount}`
      : '未抓到快照'
  );

  // E3：401 后头部退回「登录」按钮（isLogin=false → .user-dropdown 消失）。
  // 此时可能已跳到 /login，但登出态下头部都不该有 .user-dropdown。
  await waitFor(`!document.querySelector('.user-dropdown')`, 8000);
  const e3Dropdown = await session.evaluate(`!!document.querySelector('.user-dropdown')`);
  const e3LoginBtn = await session.evaluate(
    `Array.from(document.querySelectorAll('button')).some((b) => b.textContent.trim() === '登录')`
  );
  check(
    'E3',
    '401 后 AppHeader 退回「登录」按钮（下拉消失 / 出现登录按钮）',
    !e3Dropdown && e3LoginBtn,
    `下拉存在=${e3Dropdown}，登录按钮存在=${e3LoginBtn}`
  );
}

/* ============================ 清理 ============================ */

async function cleanup() {
  const prisma = await getPrisma();

  const accs = await prisma.user.findMany({
    where: { username: { in: [A.username, B.username] } },
    select: { id: true },
  });
  const ids = accs.map((u) => u.id);

  const stat = { likes: 0, comments: 0, articles: 0, users: 0 };

  if (ids.length) {
    // 顺序固定：likes → comments → articles → users（外键 RESTRICT，反序会被 MySQL 1452 拦）
    stat.likes = (await prisma.like.deleteMany({ where: { userId: { in: ids } } })).count;
    stat.comments = (await prisma.comment.deleteMany({ where: { authorId: { in: ids } } })).count;

    const arts = await prisma.article.findMany({
      where: { authorId: { in: ids } },
      select: { id: true },
    });
    const artIds = arts.map((a) => a.id);

    if (artIds.length) {
      // 别人给探针文章点的赞 / 评论也要先清，否则删文章时撞外键
      await prisma.like.deleteMany({ where: { articleId: { in: artIds } } });
      await prisma.comment.deleteMany({ where: { articleId: { in: artIds } } });
      stat.articles = (await prisma.article.deleteMany({ where: { id: { in: artIds } } })).count;
    }

    stat.users = (await prisma.user.deleteMany({ where: { id: { in: ids } } })).count;
  }

  return stat;
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

  try {
    const stat = await cleanup();
    console.log(
      `\n清理：likes ${stat.likes} / comments ${stat.comments} / articles ${stat.articles} / users ${stat.users}`
    );
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
