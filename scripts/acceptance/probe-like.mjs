// 第十批「点赞」探针：A 行为 / B 真并发 / C 未登录 / D 软删文章 / E 列表页（含 N+1）
//
// 与 probe-password / probe-profile-edit 同一套规矩：
//   - 用一次性 pwprobe 账号，不碰真实用户的点赞数据；
//   - A/B/D 组全用探针**自己发的文章**做靶子，真实文章的 likeCount 全程不受影响；
//   - finally 里按 likes → articles → user 的顺序清理（外键 RESTRICT，反序会被 1452 拦）；
//   - 自己起的浏览器自己关（契约 §13-17）。
//
// 用法：node scripts/acceptance/probe-like.mjs [--shots <dir>]
import path from 'node:path';
import { CONFIG, sleep, requireCjs, BACKEND, BACKEND_MODULES } from './lib/config.mjs';
import { cleanupProbeAccounts } from './lib/tmp-account.mjs';
import { cdpAlive, attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';

/* ============================ 结果收集 ============================ */

const results = [];
let chromeChild = null;
let session = null;

function check(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} | ${desc} | ${detail}`);
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

  return { status: res.status, code: json && json.code, message: json && json.message, data: json && json.data };
}

const like = (id, token) => api('POST', `/articles/${id}/like`, { token });
const unlike = (id, token) => api('DELETE', `/articles/${id}/like`, { token });

/* ============================ Prisma（仅供清理） ============================ */

let prismaClient = null;
async function getPrisma() {
  if (prismaClient) return prismaClient;

  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));

  prismaClient = new PrismaClient();

  return prismaClient;
}

// 清理顺序**不能变**：likes 引用 articles 与 users，两条外键都是 ON DELETE RESTRICT，
// 先删 user 或 article 都会被 MySQL 1452 拒绝（docs/DB.md 已实测）。
async function cleanupProbeData({ username, userId, articleIds }) {
  const prisma = await getPrisma();
  let likes = 0;
  let articles = 0;

  try {
    const r1 = await prisma.like.deleteMany({ where: { userId } });
    likes = r1.count;

    if (articleIds.length > 0) {
      // 物理删（探针自造的靶子文章，含 D 组软删的那篇），不留软删垃圾。
      const r2 = await prisma.article.deleteMany({ where: { id: { in: articleIds } } });
      articles = r2.count;
    }
  } finally {
    await prisma.$disconnect();
    prismaClient = null;
  }

  const users = await cleanupProbeAccounts([username]);

  return { likes, articles, users };
}

/* ============================ 前置检查 ============================ */

async function preflight() {
  const health = await api('GET', '/health');
  if (health.status !== 200) {
    console.error(`后端不可用（${CONFIG.api}/health → ${health.status}），先起后端再跑探针`);
    process.exit(2);
  }

  const front = await fetch(CONFIG.frontend).then((r) => r.status).catch(() => 0);
  if (front !== 200) {
    console.error(`前端不可用（${CONFIG.frontend} → ${front}），先起前端再跑探针（必须是 5173）`);
    process.exit(2);
  }
}

/* ============================ 主流程 ============================ */

const ACCOUNT = {
  username: `pwprobe${Date.now()}${Math.floor(Math.random() * 1000)}`,
  password: 'probe123456',
  nickname: '点赞探针',
};

const state = { token: null, userId: null, articleIds: [] };

async function main() {
  await preflight();

  /* ---------- 造一次性账号 + 靶子文章 ---------- */

  const reg = await api('POST', '/auth/register', { body: ACCOUNT });
  if (reg.status !== 201) {
    console.error(`注册探针账号失败：HTTP ${reg.status} ${reg.message}`);
    process.exit(2);
  }

  const login = await api('POST', '/auth/login', {
    body: { username: ACCOUNT.username, password: ACCOUNT.password },
  });

  state.token = login.data && login.data.token;
  state.userId = login.data && login.data.user && login.data.user.id;

  if (!state.token || !state.userId) {
    console.error('登录探针账号失败，拿不到 token / userId');
    process.exit(2);
  }

  console.log(`\n探针账号：${ACCOUNT.username}（id=${state.userId}），token 长度 ${state.token.length}\n`);

  // 靶子文章：A/B/D 全用它，真实文章的 likeCount 全程不动。
  const created = await api('POST', '/articles', {
    token: state.token,
    body: { title: '点赞探针靶子文章', content: '仅供 probe-like.mjs 使用，跑完即物理删除。'.repeat(5) },
  });

  if (created.status !== 201 || !created.data) {
    console.error(`造靶子文章失败：HTTP ${created.status} ${created.message}`);
    process.exit(2);
  }

  const targetId = created.data.id;
  state.articleIds.push(targetId);

  console.log(`靶子文章：id=${targetId}，初始 likeCount=${created.data.likeCount}\n`);

  check(
    'A0',
    'POST /api/articles 的 201 响应带 likeCount: 0',
    created.data.likeCount === 0,
    `likeCount=${created.data.likeCount}`
  );

  /* ---------- A 组：点赞 / 取消 / 重复 409 / 取消未点赞 404 ---------- */

  const a1 = await like(targetId, state.token);
  check(
    'A1',
    '首次点赞 → 200 且 liked=true',
    a1.status === 200 && a1.data && a1.data.liked === true && a1.data.likeCount === 1,
    `HTTP ${a1.status} ${JSON.stringify(a1.data)}`
  );

  const a2 = await like(targetId, state.token);
  check(
    'A2',
    '重复点赞 → 409 / 40900',
    a2.status === 409 && a2.code === 40900,
    `HTTP ${a2.status} code=${a2.code} msg="${a2.message}"`
  );

  // 详情接口与点赞响应口径一致（同一篇文章的实时 COUNT）
  const detail = await api('GET', `/articles/${targetId}`);
  check(
    'A3',
    '点赞后 GET /articles/:id 的 likeCount 同步为 1',
    detail.status === 200 && detail.data && detail.data.likeCount === 1,
    `HTTP ${detail.status} likeCount=${detail.data && detail.data.likeCount}`
  );

  const a4 = await unlike(targetId, state.token);
  check(
    'A4',
    '取消点赞 → 200 且 liked=false',
    a4.status === 200 && a4.data && a4.data.liked === false && a4.data.likeCount === 0,
    `HTTP ${a4.status} ${JSON.stringify(a4.data)}`
  );

  const a5 = await unlike(targetId, state.token);
  check(
    'A5',
    '取消没赞过的 → 404 / 40400',
    a5.status === 404 && a5.code === 40400,
    `HTTP ${a5.status} code=${a5.code} msg="${a5.message}"`
  );

  const a6 = await api('GET', `/articles/${targetId}`);
  check(
    'A6',
    '取消后 likeCount 回落到 0',
    a6.status === 200 && a6.data && a6.data.likeCount === 0,
    `HTTP ${a6.status} likeCount=${a6.data && a6.data.likeCount}`
  );

  /* ---------- B 组：真并发双 POST，恰好 1 成 1 个 409 ---------- */

  // 两个请求同时发出（Promise.all），中间不加 await —— 这才是真并发。
  // 「先查后写」的实现在这里会两个都成功，只有 DB 唯一约束能拦住第二个。
  const [b1, b2] = await Promise.all([like(targetId, state.token), like(targetId, state.token)]);
  const statuses = [b1.status, b2.status].sort();

  check(
    'B1',
    '真并发双 POST → 恰好 1 个 200、1 个 409',
    statuses[0] === 200 && statuses[1] === 409,
    `状态码 ${JSON.stringify([b1.status, b2.status])}`
  );

  const bDetail = await api('GET', `/articles/${targetId}`);
  check(
    'B2',
    '并发后 likeCount 恰好为 1（没有重复插入）',
    bDetail.status === 200 && bDetail.data && bDetail.data.likeCount === 1,
    `likeCount=${bDetail.data && bDetail.data.likeCount}`
  );

  // B 组留了 1 个赞，取消掉，让 A/C/D/E 组的状态干净。
  await unlike(targetId, state.token);

  /* ---------- C 组：未登录 401 ---------- */

  const c1 = await like(targetId, null);
  check(
    'C1',
    '未登录点赞 → 401 / 40100',
    c1.status === 401 && c1.code === 40100,
    `HTTP ${c1.status} code=${c1.code} msg="${c1.message}"`
  );

  const c2 = await unlike(targetId, null);
  check(
    'C2',
    '未登录取消点赞 → 401 / 40100',
    c2.status === 401 && c2.code === 40100,
    `HTTP ${c2.status} code=${c2.code} msg="${c2.message}"`
  );

  const c3 = await like(targetId, 'not-a-real-token');
  check(
    'C3',
    'token 非法 → 401 / 40100',
    c3.status === 401 && c3.code === 40100,
    `HTTP ${c3.status} code=${c3.code} msg="${c3.message}"`
  );

  /* ---------- D 组：软删文章点赞 404 ---------- */

  const del = await api('DELETE', `/articles/${targetId}`, { token: state.token });
  check(
    'D0',
    '靶子文章软删成功',
    del.status === 200,
    `HTTP ${del.status} ${del.message}`
  );

  const d1 = await like(targetId, state.token);
  check(
    'D1',
    '软删文章点赞 → 404（文章不存在）',
    d1.status === 404 && d1.code === 40400,
    `HTTP ${d1.status} code=${d1.code} msg="${d1.message}"`
  );

  const d2 = await unlike(targetId, state.token);
  check(
    'D2',
    '软删文章取消点赞 → 404（文章不存在）',
    d2.status === 404 && d2.code === 40400,
    `HTTP ${d2.status} code=${d2.code} msg="${d2.message}"`
  );

  const d3 = await api('GET', `/articles/${targetId}`);
  check(
    'D3',
    '软删文章详情 → 404，列表里也不再出现',
    d3.status === 404,
    `HTTP ${d3.status} code=${d3.code}`
  );

  const listAfter = await api('GET', '/articles?page=1&pageSize=100');
  const ids = (listAfter.data && listAfter.data.list ? listAfter.data.list : []).map((a) => a.id);
  check(
    'D4',
    '软删后列表不含该文章',
    !ids.includes(targetId),
    `列表 ${ids.length} 条，含 id=${targetId}? ${ids.includes(targetId)}`
  );

  /* ---------- E 组：列表页 likeCount 正确 + 无 N+1（浏览器） ---------- */

  if (!(await cdpAlive())) {
    chromeChild = (await launchChrome()).child;
    await sleep(1500);
  }

  session = await attach();
  await session.send('Network.enable');

  const requests = [];
  const onReq = (msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      requests.push({ url: msg.params.request.url, method: msg.params.request.method });
    }
  };
  session.onEvent(onReq);

  // 先注入探针账号的登录态（localStorage.token，键名见 frontend/src/stores/user.js），再刷新。
  await session.goto(`${CONFIG.frontend}/`);
  await sleep(1200);
  await session.evaluate(`localStorage.setItem('token', ${JSON.stringify(state.token)}); 'ok'`);

  requests.length = 0;
  await session.goto(`${CONFIG.frontend}/`);
  await sleep(2500);

  // N+1 检测：如果每篇文章都单独查一次赞，这里会出现 1 + N 次请求。
  // 只数 GET —— request.js 给所有请求都设了 Content-Type，列表请求一定会先发 OPTIONS 预检。
  const listReqs = requests.filter((r) => r.method === 'GET' && r.url.includes('/api/articles'));

  check(
    'E1',
    '列表页加载只发 1 次 GET /api/articles（无 N+1）',
    listReqs.length === 1,
    `GET /api/articles 次数=${listReqs.length}${listReqs.length ? ` 首次 ${listReqs[0].url.replace(CONFIG.api, '')}` : ''}`
  );

  const apiList = await api('GET', '/articles?page=1&pageSize=10');
  const apiMap = new Map(
    (apiList.data && apiList.data.list ? apiList.data.list : []).map((a) => [String(a.title).trim(), a.likeCount])
  );

  const domRaw = await session.evaluate(`
    JSON.stringify(Array.from(document.querySelectorAll('.article-card')).map((card) => {
      const t = card.querySelector('.article-title');
      const l = card.querySelector('.article-like-count');
      return { title: t ? t.textContent.trim() : null, like: l ? l.textContent.trim() : null };
    }))
  `);
  const dom = JSON.parse(domRaw || '[]');

  const mismatched = dom.filter((d) => {
    const expected = apiMap.get(d.title);
    return expected == null || Number(d.like) !== expected;
  });

  check(
    'E2',
    '每张卡片渲染的 likeCount 与接口一致',
    dom.length > 0 && mismatched.length === 0,
    `卡片 ${dom.length} 张，不一致 ${mismatched.length} 张${
      mismatched.length ? ` 例：${mismatched[0].title} DOM=${mismatched[0].like} API=${apiMap.get(mismatched[0].title)}` : ''
    }`
  );

  // 读的是**无障碍属性本身**，不是「有没有这个元素」。
  //
  // ⚠️ 注意点赞按钮**不是 `<button>`**：卡片整块是 router-link（真实 <a href>），
  // 而 HTML 规范不允许 <a> 内嵌交互内容，所以项目约定用
  // `<span role="button" tabindex="0">`（见 frontend/src/components/ArticleCard.vue）。
  // 因此断言 SPAN + role=button + tabindex=0，**不能**照搬「tagName === 'BUTTON'」。
  // aria-label 由组件给出：liked ? '取消点赞' : '点赞'。
  const likeBtn = JSON.parse(
    await session.evaluate(`(() => {
      const b = document.querySelector('.article-card .article-like');
      return JSON.stringify(b ? {
        tag: b.tagName,
        role: b.getAttribute('role'),
        tab: b.getAttribute('tabindex'),
        aria: b.getAttribute('aria-label'),
      } : null);
    })()`)
  );
  check(
    'E3',
    '卡片点赞按钮是 span[role=button][tabindex=0] 且 aria-label 可读',
    dom.length > 0 &&
      Boolean(likeBtn) &&
      likeBtn.tag === 'SPAN' &&
      likeBtn.role === 'button' &&
      likeBtn.tab === '0' &&
      ['点赞', '取消点赞'].includes(likeBtn.aria),
    `tag=${likeBtn && likeBtn.tag} role=${likeBtn && likeBtn.role} tab=${likeBtn && likeBtn.tab} aria=${likeBtn && likeBtn.aria}`
  );

  // E4：点第一张卡的点赞按钮 —— 必须 **只** 点赞、不能跳详情页。
  // 卡片整块是 router-link（真实 <a href>），只写 .stop 拦不住原生导航，
  // 这条就是 @click.prevent.stop 的直接回归测试。
  const before = await session.evaluate(
    `document.querySelector('.article-card .article-like-count').textContent.trim()`
  );
  const urlBefore = await session.evaluate(`location.pathname`);

  await session.evaluate(`
    (() => {
      document.querySelector('.article-card .article-like').click();
      return true;
    })()
  `);
  await sleep(1200);

  const after = await session.evaluate(
    `document.querySelector('.article-card .article-like-count').textContent.trim()`
  );
  const urlAfter = await session.evaluate(`location.pathname`);

  check(
    'E4',
    '点卡片点赞按钮：计数 +1 且不跳详情页（.prevent.stop 生效）',
    Number(after) === Number(before) + 1 && urlAfter === urlBefore,
    `计数 ${before} → ${after}，路径 ${urlBefore} → ${urlAfter}`
  );

  const likedState = await session.evaluate(
    `document.querySelector('.article-card .article-like').classList.contains('is-liked')`
  );

  check(
    'E5',
    '点赞后按钮进入 is-liked 态',
    likedState === true,
    `class 含 is-liked = ${likedState}`
  );

  // 取消回来，避免留垃圾（finally 也会兜底，这里顺手让 UI 状态可复核）
  await session.evaluate(`
    (() => {
      document.querySelector('.article-card .article-like').click();
      return true;
    })()
  `);
  await sleep(1200);

  const restored = await session.evaluate(
    `document.querySelector('.article-card .article-like-count').textContent.trim()`
  );

  check(
    'E6',
    '再点一次取消点赞：计数回到原值',
    Number(restored) === Number(before),
    `计数 ${after} → ${restored}（原值 ${before}）`
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

let exitCode = 1;

try {
  await main();
  exitCode = summarize();
} catch (error) {
  console.error('\n探针异常终止：', error && error.message ? error.message : error);
  exitCode = 1;
} finally {
  if (session) {
    session.offEvent(() => {});
    session.close();
  }

  if (chromeChild) {
    await stopChrome(chromeChild);
  }

  // 清理：探针自造的 likes / 靶子文章 / 一次性账号。
  try {
    const cleaned = await cleanupProbeData({
      username: ACCOUNT.username,
      userId: state.userId,
      articleIds: state.articleIds,
    });
    console.log(`\n清理：删除点赞 ${cleaned.likes} 条 / 靶子文章 ${cleaned.articles} 篇 / 探针账号 ${cleaned.users} 个`);
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
