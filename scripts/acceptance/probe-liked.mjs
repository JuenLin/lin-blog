// 第十四批探针：A1'「GET /api/articles/:id/liked」+ A5「/settings 设置页」
//
// A 组：liked 接口的 HTTP 语义（含跨用户隔离、软删、未登录）
// B 组：详情页刷新后还原点赞按钮态（浏览器），以及未登录不发该请求
// C 组：/settings 父级壳（重定向、侧栏、下拉菜单入口合并）
//
// 与 probe-like.mjs 同一套规矩：
//   - 一次性 pwprobe 账号，finally 清理，不碰真实用户数据；
//   - 点赞 / 软删全用探针**自己发的文章**做靶子；
//   - 清理顺序 likes → articles → users（外键 RESTRICT，反序会被 1452 拦）；
//   - 自己起的浏览器自己关（契约 §13-17）。
//
// 用法：node scripts/acceptance/probe-liked.mjs
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

/* ============================ HTTP / CDP 小工具 ============================ */

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

const liked = (id, token) => api('GET', `/articles/${id}/liked`, { token });
const like = (id, token) => api('POST', `/articles/${id}/like`, { token });
const unlike = (id, token) => api('DELETE', `/articles/${id}/like`, { token });

// 轮询等待页面上的某个条件成立（表达式返回真值）。
// 不用固定 sleep：详情页要先拉详情再拉 liked，固定等待会让探针在慢机器上假失败。
async function waitFor(expression, timeout = 8000, interval = 200) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const raw = await session.evaluate(`(() => { try { return String(!!(${expression})); } catch (e) { return 'false'; } })()`);

    if (raw === 'true') return true;

    await sleep(interval);
  }

  return false;
}

/* ============================ Prisma（仅供清理） ============================ */

let prismaClient = null;
async function getPrisma() {
  if (prismaClient) return prismaClient;

  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));

  prismaClient = new PrismaClient();

  return prismaClient;
}

async function cleanupProbeData({ usernames, userIds, articleIds }) {
  const prisma = await getPrisma();
  let likes = 0;
  let articles = 0;

  try {
    const r1 = await prisma.like.deleteMany({ where: { userId: { in: userIds } } });
    likes = r1.count;

    if (articleIds.length > 0) {
      const r2 = await prisma.article.deleteMany({ where: { id: { in: articleIds } } });
      articles = r2.count;
    }
  } finally {
    await prisma.$disconnect();
    prismaClient = null;
  }

  const users = await cleanupProbeAccounts(usernames);

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

async function registerAccount(nickname) {
  const account = {
    username: `pwprobe${Date.now()}${Math.floor(Math.random() * 1000)}`,
    password: 'probe123456',
    nickname,
  };

  const reg = await api('POST', '/auth/register', { body: account });
  if (reg.status !== 201) {
    throw new Error(`注册探针账号失败：HTTP ${reg.status} ${reg.message}`);
  }

  const login = await api('POST', '/auth/login', {
    body: { username: account.username, password: account.password },
  });

  const token = login.data && login.data.token;
  const userId = login.data && login.data.user && login.data.user.id;

  if (!token || !userId) {
    throw new Error('登录探针账号失败，拿不到 token / userId');
  }

  return { ...account, token, userId };
}

/* ============================ 主流程 ============================ */

// 主账号：点赞、软删、浏览器登录态都用它。
// 次账号：只用来验「A 的 liked 不受 B 点赞影响」。
const me = { username: null, userId: null, token: null };
const other = { username: null, userId: null, token: null };
const articleIds = [];

async function main() {
  await preflight();

  /* ---------- 造一次性账号 + 靶子文章 ---------- */

  const meAcc = await registerAccount('点赞态探针');
  Object.assign(me, meAcc);

  const otherAcc = await registerAccount('点赞态探针B');
  Object.assign(other, otherAcc);

  console.log(`\n探针账号：${me.username}（id=${me.userId}） / ${other.username}（id=${other.userId}）\n`);

  async function createTarget(title) {
    const created = await api('POST', '/articles', {
      token: me.token,
      body: { title, content: '仅供 probe-liked.mjs 使用，跑完即物理删除。'.repeat(5) },
    });

    if (created.status !== 201 || !created.data) {
      throw new Error(`造靶子文章失败：HTTP ${created.status} ${created.message}`);
    }

    articleIds.push(created.data.id);

    return created.data.id;
  }

  // A：浏览器组用（先点赞再刷新验证还原）
  // B：浏览器组用（保持未点赞）
  // C：软删专用
  const idA = await createTarget('liked探针靶子A');
  const idB = await createTarget('liked探针靶子B');
  const idC = await createTarget('liked探针靶子C');

  console.log(`靶子文章：A=${idA} B=${idB} C=${idC}\n`);

  /* ---------- A 组：liked 接口的 HTTP 语义 ---------- */

  const a1 = await liked(idA, me.token);
  check(
    'A1',
    '未点赞时 liked → 200 且 liked=false',
    a1.status === 200 && a1.data && a1.data.liked === false,
    `HTTP ${a1.status} ${JSON.stringify(a1.data)}`
  );

  // 契约：data 只含 liked，不带 likeCount（避免与详情接口的计数出现两个来源）。
  const a1Keys = a1.data ? Object.keys(a1.data) : [];
  check(
    'A2',
    'data 只含 liked 一个字段（不带 likeCount）',
    a1Keys.length === 1 && a1Keys[0] === 'liked',
    `data 键 = ${JSON.stringify(a1Keys)}`
  );

  const a3 = await like(idA, me.token);
  const a4 = await liked(idA, me.token);
  check(
    'A3',
    '点赞后 liked → true',
    a3.status === 200 && a4.status === 200 && a4.data && a4.data.liked === true,
    `POST HTTP ${a3.status}；liked=${a4.data && a4.data.liked}`
  );

  // 跨用户隔离：另一个账号没赞过，它的 liked 必须是 false ——
  // 这条能挡住「查 liked 时漏了 userId 过滤、只看文章」的实现。
  const a5 = await liked(idA, other.token);
  check(
    'A4',
    '另一个未点赞账号查同一篇 → liked=false（按 userId 隔离）',
    a5.status === 200 && a5.data && a5.data.liked === false,
    `HTTP ${a5.status} liked=${a5.data && a5.data.liked}（该账号 id=${other.userId}）`
  );

  const a6 = await like(idA, other.token);
  const a7 = await liked(idA, other.token);
  const a8 = await liked(idA, me.token);
  check(
    'A5',
    '次账号点赞后：次账号 liked=true 且主账号仍为 true（互不影响）',
    a6.status === 200 && a7.data && a7.data.liked === true && a8.data && a8.data.liked === true,
    `次账号 liked=${a7.data && a7.data.liked}，主账号 liked=${a8.data && a8.data.liked}`
  );

  // 次账号取消，让 likeCount 回到只由主账号贡献的状态（B 组要点按钮计数）
  await unlike(idA, other.token);

  const a9 = await unlike(idA, me.token);
  const a10 = await liked(idA, me.token);
  check(
    'A6',
    '取消点赞后 liked → false',
    a9.status === 200 && a10.data && a10.data.liked === false,
    `DELETE HTTP ${a9.status}；liked=${a10.data && a10.data.liked}`
  );

  /* ---------- 未登录 / 非法 token / 参数 / 404 ---------- */

  const a11 = await liked(idA, null);
  check(
    'A7',
    '未登录 → 401 / 40100',
    a11.status === 401 && a11.code === 40100,
    `HTTP ${a11.status} code=${a11.code} msg="${a11.message}"`
  );

  const a12 = await liked(idA, 'not-a-real-token');
  check(
    'A8',
    'token 非法 → 401 / 40100',
    a12.status === 401 && a12.code === 40100,
    `HTTP ${a12.status} code=${a12.code} msg="${a12.message}"`
  );

  // 中间件顺序：auth 在 validate 之前 —— 未登录 + 非法 id 也必须回 401，
  // 不能先回 400 把参数校验细节暴露给未登录者（第九批的教训）。
  const a13 = await liked('abc', null);
  check(
    'A9',
    '未登录 + 非法 id → 401（auth 先于 validate）',
    a13.status === 401 && a13.code === 40100,
    `HTTP ${a13.status} code=${a13.code}`
  );

  const a14 = await liked('abc', me.token);
  check(
    'A10',
    '已登录 + 非法 id → 400 / 40000',
    a14.status === 400 && a14.code === 40000,
    `HTTP ${a14.status} code=${a14.code} msg="${a14.message}"`
  );

  const a15 = await liked(999999, me.token);
  check(
    'A11',
    '不存在的文章 → 404 / 40400',
    a15.status === 404 && a15.code === 40400,
    `HTTP ${a15.status} code=${a15.code} msg="${a15.message}"`
  );

  const softDel = await api('DELETE', `/articles/${idC}`, { token: me.token });
  const a16 = await liked(idC, me.token);
  check(
    'A12',
    '软删文章 → 404 / 40400（与 POST、DELETE 口径一致）',
    softDel.status === 200 && a16.status === 404 && a16.code === 40400,
    `软删 HTTP ${softDel.status}；liked HTTP ${a16.status} code=${a16.code}`
  );

  /* ---------- B 组：详情页刷新后还原按钮态 ---------- */

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

  const likedRequests = () =>
    requests.filter((r) => r.method === 'GET' && /\/api\/articles\/\d+\/liked(\?|$)/.test(r.url));

  // 注入主账号登录态。先打开首页再写 localStorage（直接 goto 详情页再写也行，
  // 但写入后必须刷新一次才会被 store 读取）。
  await session.goto(`${CONFIG.frontend}/`);
  await sleep(1000);
  await session.evaluate(`localStorage.setItem('token', ${JSON.stringify(me.token)}); 'ok'`);

  // 先让主账号把 A 赞上，再刷新详情页 —— 这才是「刷新后按钮态」的真实场景。
  const bLike = await like(idA, me.token);
  if (bLike.status !== 200) {
    throw new Error(`B 组前置点赞失败：HTTP ${bLike.status}`);
  }

  requests.length = 0;
  await session.goto(`${CONFIG.frontend}/article/${idA}`);
  const b1 = await waitFor(`document.querySelector('.article-detail-like')`, 10000);

  const b1Liked = await waitFor(
    `document.querySelector('.article-detail-like') && document.querySelector('.article-detail-like').classList.contains('is-liked')`,
    8000
  );

  check(
    'B1',
    '刷新详情页后按钮态还原为 is-liked（liked 接口生效）',
    b1 && b1Liked,
    `点赞按钮已渲染=${b1}，is-liked=${b1Liked}`
  );

  // aria-pressed 是给读屏用户的真实状态，顺手一起断言，
  // 避免「class 对了但无障碍属性没跟着变」。
  const b2Pressed = await session.evaluate(
    `document.querySelector('.article-detail-like').getAttribute('aria-pressed')`
  );
  check(
    'B2',
    '已赞态的 aria-pressed=true、aria-label=取消点赞',
    b2Pressed === 'true' &&
      (await session.evaluate(`document.querySelector('.article-detail-like').getAttribute('aria-label')`)) ===
        '取消点赞',
    `aria-pressed=${b2Pressed}`
  );

  const b3 = likedRequests();
  check(
    'B3',
    '详情页进入时恰好发 1 次 GET /:id/liked（不多发）',
    b3.length === 1,
    `请求次数=${b3.length}${b3.length ? ` url=${b3[0].url.replace(CONFIG.api, '')}` : ''}`
  );

  // 点按钮取消 → 计数回退且按钮回到未赞态（顺带证明按钮仍可用）
  const beforeCount = await session.evaluate(
    `document.querySelector('.article-detail-like-count').textContent.trim()`
  );
  await session.evaluate(`document.querySelector('.article-detail-like').click(); true`);
  const b4 = await waitFor(
    `document.querySelector('.article-detail-like') && !document.querySelector('.article-detail-like').classList.contains('is-liked')`,
    8000
  );
  const afterCount = await session.evaluate(
    `document.querySelector('.article-detail-like-count').textContent.trim()`
  );
  check(
    'B4',
    '已赞态下点按钮 → 取消成功，计数 -1 且按钮回到未赞态',
    b4 && Number(afterCount) === Number(beforeCount) - 1,
    `计数 ${beforeCount} → ${afterCount}，is-liked 已清除=${b4}`
  );

  /* ---------- B5：切到另一篇（未赞）→ 重新拉取且按钮为未赞态 ---------- */

  requests.length = 0;
  await session.goto(`${CONFIG.frontend}/article/${idB}`);
  const b5Rendered = await waitFor(`document.querySelector('.article-detail-like')`, 10000);
  await sleep(1200); // 让 liked 请求有时间发出

  const b5Liked = await session.evaluate(
    `document.querySelector('.article-detail-like').classList.contains('is-liked')`
  );
  const b5Reqs = likedRequests().filter((r) => r.url.includes(`/articles/${idB}/liked`));

  check(
    'B5',
    '换到未点赞的文章 → 发该文章的 liked 请求且按钮为未赞态',
    b5Rendered && b5Liked === false && b5Reqs.length === 1,
    `按钮已渲染=${b5Rendered}，is-liked=${b5Liked}，id=${idB} 的请求数=${b5Reqs.length}`
  );

  /* ---------- B6：未登录访问详情页不得发 /liked（不能把匿名读者踢走） ---------- */

  await session.evaluate(`localStorage.removeItem('token'); 'ok'`);
  requests.length = 0;
  await session.goto(`${CONFIG.frontend}/article/${idA}`);
  const b6Rendered = await waitFor(`document.querySelector('.article-detail-like')`, 10000);
  await sleep(1500);

  const b6Reqs = likedRequests();
  const b6Path = await session.evaluate(`location.pathname`);

  check(
    'B6',
    '未登录访问详情页：不发 /liked 请求，且不被 401 拦截器踢到登录页',
    b6Rendered && b6Reqs.length === 0 && b6Path === `/article/${idA}`,
    `按钮已渲染=${b6Rendered}，/liked 请求数=${b6Reqs.length}，当前路径=${b6Path}`
  );

  /* ---------- C 组：/settings 设置页 ---------- */

  // C1：未登录访问设置子页 → 跳登录页并带 redirect（meta.requiresAuth 仍在生效）
  await session.goto(`${CONFIG.frontend}/settings/profile`);
  await sleep(1500);
  const c1Path = await session.evaluate(`location.pathname`);
  const c1Query = await session.evaluate(`location.search`);
  check(
    'C1',
    '未登录访问 /settings/profile → 跳登录页并带 redirect',
    c1Path === '/login' && decodeURIComponent(c1Query).includes('/settings/profile'),
    `path=${c1Path} search=${decodeURIComponent(c1Query)}`
  );

  // 恢复登录态
  await session.evaluate(`localStorage.setItem('token', ${JSON.stringify(me.token)}); 'ok'`);

  // C2：/settings 重定向到默认子页
  await session.goto(`${CONFIG.frontend}/settings`);
  await sleep(2000);
  const c2Path = await session.evaluate(`location.pathname`);
  check(
    'C2',
    '已登录访问 /settings → 重定向到 /settings/profile',
    c2Path === '/settings/profile',
    `path=${c2Path}`
  );

  // C3：壳与两个子页面入口都在（先证元素渲染，再断言内容 —— 空集合上的 every() 恒真）
  const c3Nav = JSON.parse(
    await session.evaluate(`
      JSON.stringify(Array.from(document.querySelectorAll('.settings-link')).map((a) => ({
        text: a.textContent.trim(),
        href: a.getAttribute('href'),
        active: a.classList.contains('router-link-active'),
      })))
    `)
  );

  const c3Texts = c3Nav.map((n) => n.text);
  check(
    'C3',
    '设置页侧栏渲染「编辑资料 / 修改密码」两个入口',
    c3Nav.length === 2 && c3Texts.includes('编辑资料') && c3Texts.includes('修改密码'),
    `侧栏 ${c3Nav.length} 项：${JSON.stringify(c3Texts)}`
  );

  const c3Active = c3Nav.filter((n) => n.active).map((n) => n.text);
  check(
    'C4',
    '当前所在子页的侧栏项高亮（router-link-active 恰好 1 项）',
    c3Active.length === 1 && c3Active[0] === '编辑资料',
    `高亮项=${JSON.stringify(c3Active)}（当前 path=${c2Path}）`
  );

  // C5：点「修改密码」→ 路径切换、密码表单出现，且侧栏仍在（壳没被替换掉）
  await session.evaluate(`
    (() => {
      const link = Array.from(document.querySelectorAll('.settings-link'))
        .find((a) => a.textContent.trim() === '修改密码');
      if (link) link.click();
      return !!link;
    })()
  `);
  const c5Form = await waitFor(`document.querySelector('.change-password-card')`, 8000);
  const c5Path = await session.evaluate(`location.pathname`);
  const c5Side = await session.evaluate(`document.querySelectorAll('.settings-link').length`);
  check(
    'C5',
    '点侧栏「修改密码」→ 路径切换到 /settings/password 且密码表单渲染、侧栏仍在',
    c5Path === '/settings/password' && c5Form && c5Side === 2,
    `path=${c5Path}，密码卡渲染=${c5Form}，侧栏项数=${c5Side}`
  );

  // 切回资料页，确认另一侧也能渲染（排除「只有密码页被挂上」的错挂）
  await session.evaluate(`
    (() => {
      const link = Array.from(document.querySelectorAll('.settings-link'))
        .find((a) => a.textContent.trim() === '编辑资料');
      if (link) link.click();
      return !!link;
    })()
  `);
  const c6Form = await waitFor(`document.querySelector('.profile-edit-card')`, 8000);
  check(
    'C6',
    '点侧栏「编辑资料」→ 资料表单渲染（两个子页都真的挂上了）',
    c6Form,
    `资料卡渲染=${c6Form}，path=${await session.evaluate(`location.pathname`)}`
  );

  // C7：下拉菜单入口已合并成「设置」，两个旧项不再出现
  await session.goto(`${CONFIG.frontend}/`);
  await sleep(1500);
  await waitFor(`document.querySelector('.user-dropdown')`, 10000);
  await session.evaluate(`(() => { const el = document.querySelector('.user-dropdown'); if (el) el.click(); return true; })()`);
  const c7Opened = await waitFor(
    `document.querySelectorAll('.el-dropdown-menu__item').length > 0`,
    8000
  );
  const c7Items = JSON.parse(
    await session.evaluate(
      `JSON.stringify(Array.from(document.querySelectorAll('.el-dropdown-menu__item')).map((el) => el.innerText.trim()))`
    )
  );
  check(
    'C7',
    '下拉菜单含「设置」，且不再含「编辑资料」「修改密码」两个旧项',
    c7Opened &&
      c7Items.length > 0 &&
      c7Items.includes('设置') &&
      !c7Items.includes('编辑资料') &&
      !c7Items.includes('修改密码'),
    `菜单项=${JSON.stringify(c7Items)}`
  );

  // C8：点「设置」落到 /settings/profile
  await session.evaluate(`
    (() => {
      const item = Array.from(document.querySelectorAll('.el-dropdown-menu__item'))
        .find((el) => el.innerText.trim() === '设置');
      if (item) item.click();
      return !!item;
    })()
  `);
  const c8 = await waitFor(`location.pathname.indexOf('/settings') === 0`, 8000);
  const c8Path = await session.evaluate(`location.pathname`);
  check(
    'C8',
    '下拉菜单点「设置」→ 进入 /settings/profile',
    c8 && c8Path === '/settings/profile',
    `path=${c8Path}`
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

  try {
    const cleaned = await cleanupProbeData({
      usernames: [me.username, other.username].filter(Boolean),
      userIds: [me.userId, other.userId].filter(Boolean),
      articleIds,
    });
    console.log(
      `\n清理：删除点赞 ${cleaned.likes} 条 / 靶子文章 ${cleaned.articles} 篇 / 探针账号 ${cleaned.users} 个`
    );
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
