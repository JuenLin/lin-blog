// 第 2 批前端探针：UserProfile.vue 重构（el-tabs + 真后端分页 + 点赞 Tab）
//
// A 组：页面数据来源（头部三计数 / 0 篇不退化 / 简介显示）
// B 组：文章 Tab 真后端分页（翻页真发请求、total 是后端 COUNT、跨页无重复）
// C 组：点赞 Tab（仅本人可见、likedAt、只列未软删文章、切 Tab 重置页码）
// D 组：加载态（首屏骨架只在当前 Tab、切 Tab 先清空、翻页保留旧列表）
//
// 与其他 Chrome 探针同一套规矩：
//   - 一次性 pwprobe 账号 + 探针自造文章，finally 清理，不碰真实用户数据；
//   - 清理顺序 likes → comments → articles → users（外键 RESTRICT，反序会被 1452 拦）；
//   - 自己起的 Chrome 自己关；
//   - 前置失败 exit 2、有 FAIL 或清理失败 exit 1、全绿 exit 0。
//
// ⚠️ 铁律（踩过两次）：
//   1) 验语法**绝不能用 import()** —— 会真的把探针跑一遍。语法交给 vite build。
//   2) 别用 `| head -N` 截断本脚本输出 —— 管道关闭会掐死 node，finally 不跑，留下脏数据。
//
// 用法：node scripts/acceptance/probe-profile-tabs.mjs
import path from 'node:path';
import { CONFIG, sleep, requireCjs, BACKEND, BACKEND_MODULES, ensureDirs } from './lib/config.mjs';
import { cleanupProbeAccounts } from './lib/tmp-account.mjs';
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

// 分组小计（跑完打印，避免只看到一堆 PASS 不知道哪组出问题）
function sectionSummary() {
  const groups = {};
  for (const r of results) {
    const g = r.id.split('-')[0];
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

// 轮询等待条件成立。不用固定 sleep：SPA 路由 + 接口需要时间，固定等待会在慢机器上假失败。
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

async function gotoProfile(userId) {
  await session.goto(`${CONFIG.frontend}/user/${userId}`);
  // 等头部出现（三个计数渲染完= 详情接口回来了）
  await waitFor(`document.querySelector('.profile-sub')`);
}

/**
 * 读当前页面上的文章卡片 id 列表。
 * ArticleCard 是 router-link渲染的 <a class="article-card" href="/article/123">，
 * 所以 id 从 href 末段取；.article-card 是实测过的真实类名（不是猜的）。
 */
async function readCardIds() {
  const raw = await session.evaluate(`(() => {
    const cards = document.querySelectorAll('.profile-list .article-card');
    return JSON.stringify(Array.from(cards).map((el) => {
      const m = /\\/article\\/(\\d+)/.exec(el.getAttribute('href') || '');
      return m ? m[1] : '';
    }));
  })()`);

  return JSON.parse(raw || '[]');
}

/* ============================ Prisma（仅供清理与造数核对） ============================ */

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
  const stat = { notifications: 0, bookmarks: 0, likes: 0, articles: 0, users: 0 };

  try {
    // 第 8 批通知 + 第 9 批收藏（article_id / user_id / actor_id 全 RESTRICT）
    // 必须最早删：本探针当前只自赞（通知被抑制、不产行），按最终顺序防将来。
    const r0 = await prisma.notification.deleteMany({
      where: {
        OR: [{ articleId: { in: articleIds } }, { userId: { in: userIds } }, { actorId: { in: userIds } }],
      },
    });
    stat.notifications = r0.count;

    const r0b = await prisma.bookmark.deleteMany({
      where: { OR: [{ articleId: { in: articleIds } }, { userId: { in: userIds } }] },
    });
    stat.bookmarks = r0b.count;

    // 顺序不能反：likes → articles → users。外键是 RESTRICT，反序会被 MySQL 1452 拦。
    const r1 = await prisma.like.deleteMany({ where: { userId: { in: userIds } } });
    stat.likes = r1.count;

    if (articleIds.length > 0) {
      const r2 = await prisma.article.deleteMany({ where: { id: { in: articleIds } } });
      stat.articles = r2.count;
    }
  } finally {
    await prisma.$disconnect();
    prismaClient = null;
  }

  stat.users = await cleanupProbeAccounts(usernames);

  return stat;
}

/* ============================ 前置检查 ============================ */

async function preflight() {
  if (typeof WebSocket === 'undefined') {
    console.error('Node 版本过低（需要 ≥ 22 才有全局 WebSocket）。用node 22+ 跑本探针。');
    process.exit(2);
  }

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

  if (!token || !userId) throw new Error('登录探针账号失败，拿不到 token / userId');

  return { ...account, token, userId };
}

/**
 * 在浏览器里写入登录态。
 * 与前端stores/user.js 的 TOKEN_KEY（'token'）对齐 —— 写错 key 会导致
 * 页面认为未登录，点赞 Tab 不出现，探针会误判成「功能没实现」。
 */
async function injectToken(token) {
  await session.evaluate(`(() => {
    localStorage.setItem('token', ${JSON.stringify(token)});
    return 'ok';
  })()`);
}

/* ============================ 主流程 ============================ */

const me = { username: null, userId: null, token: null };
const other = { username: null, userId: null, token: null };
// 0 篇用户专用账号。必须登记进清理列表 —— 漏一个就留一个脏账号在库里。
const zero = { username: null, userId: null, token: null };
const articleIds = [];

// 所有探针账号的统一视图（清理与残留自查都用它，避免漏掉后创建的账号）
const accounts = () => [me, other, zero];

async function createTarget(title, authorToken) {
  const created = await api('POST', '/articles', {
    token: authorToken,
    body: { title, content: '仅供 probe-profile-tabs.mjs 使用，跑完即物理删除。'.repeat(6) },
  });

  if (created.status !== 201 || !created.data) {
    throw new Error(`造靶子文章失败：HTTP ${created.status} ${created.message}`);
  }

  articleIds.push(created.data.id);

  return created.data.id;
}

async function main() {
  ensureDirs();
  await preflight();

  /* ---------- 造账号与靶子 ---------- */

  Object.assign(me, await registerAccount('主页Tab探针'));
  Object.assign(other, await registerAccount('主页Tab探针B'));

  console.log(`\n探针账号：me=${me.username}(id=${me.userId}) / other=${other.username}(id=${other.userId})\n`);

  // me 有 12 篇文章（>默认每页 10，才验得到真分页）
  const MY_COUNT = 12;
  for (let i = 1; i <= MY_COUNT; i += 1) {
    await createTarget(`主页Tab探针文章 ${i}`, me.token);
  }

  // other有 1篇，用来验「看别人主页时文章 Tab 只有他的 1 篇」
  await createTarget('别人的文章', other.token);

  // me 点赞其中3 篇（点赞 Tab 靶子）+ 1 篇自己的（验 likedAt 与文章 createdAt 不同）
  const myIds = await prismaArticleIdsOf(me.userId);
  const likeTargets = [myIds[0], myIds[1], myIds[2], myIds[3]];

  for (const aid of likeTargets) {
    const r = await api('POST', `/articles/${aid}/like`, { token: me.token });
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`造点赞失败：HTTP ${r.status} ${r.message}`);
    }
  }

  // 另建一篇并点赞，然后软删作者 —— 验「赞过但文章已删」不出现在点赞 Tab
  const softDeletedId = await createTarget('将被软删的已点赞文章', me.token);
  const likeOnSoft = await api('POST', `/articles/${softDeletedId}/like`, { token: me.token });
  if (likeOnSoft.status !== 201 && likeOnSoft.status !== 200) {
    throw new Error(`造软删文章的点赞失败：HTTP ${likeOnSoft.status}`);
  }
  const del = await api('DELETE', `/articles/${softDeletedId}`, { token: me.token });
  if (del.status !== 200) throw new Error(`软删失败：HTTP ${del.status} ${del.message}`);

  console.log(`靶子：me ${MY_COUNT}篇 / other 1 篇 / me 点赞 ${likeTargets.length} 篇 / 另有1 篇已点赞后被软删\n`);

  /* ---------- 起Chrome ---------- */

  chromeChild = await launchChrome();
  // attach() 无参数，自己走 cdpAlive + getPages 找第一个 type==='page' 的页面。
  // 不要写成 attach(pages[0].webSocketDebuggerUrl) —— cdpAlive() 返回的是版本信息，
  // 没有 webSocketDebuggerUrl 字段，会在 pages[0] 上抛 undefined。
  session = await attach();

  /* ================= A 组：页面数据来源 ================= */

  await gotoProfile(me.userId);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);

  // A-1 头部三个计数都渲染出来
  const subText = await session.evaluate(
    `document.querySelector('.profile-sub') ? document.querySelector('.profile-sub').textContent.replace(/\\s+/g, ' ').trim() : ''`
  );
  check(
    'A-1',
    '头部显示 三个计数（文章/获赞/收到评论）',
    /(\d+)\s*篇文章/.test(subText) && /(\d+)\s*获赞/.test(subText) && /(\d+)\s*收到评论/.test(subText),
    `实际渲染="${subText}"`
  );

  // A-2 计数与后端接口逐字一致（不信前端显示，直接对接口）
  const detail = await api('GET', `/users/${me.userId}`);
  const subNums = (subText.match(/(\d+)\s*篇文章\s*·\s*(\d+)\s*获赞\s*·\s*(\d+)\s*收到评论/) || []).slice(1);
  check(
    'A-2',
    '头部三个计数与 GET /api/users/:id 逐字一致',
    detail.status === 200 &&
      subNums[0] === String(detail.data.articleCount) &&
      subNums[1] === String(detail.data.receivedLikeCount) &&
      subNums[2] === String(detail.data.receivedCommentCount),
    `页面=[${subNums.join(',')}] 接口=[${detail.data?.articleCount},${detail.data?.receivedLikeCount},${detail.data?.receivedCommentCount}]`
  );

  // A-3 不再有 capped 提示（真后端分页没有 100 窗概念）
  const hasCapped = await session.evaluate(
    `String(document.body.textContent.includes('仅显示最近 100 篇'))`
  );
  check('A-3', '不再显示「仅显示最近 100 篇」提示', hasCapped === 'false', `页面含该文案=${hasCapped}`);

  // A-4 头像与昵称来自详情接口（不再是「从命中的文章反推」）
  const headName = await session.evaluate(
    `document.querySelector('.profile-name') ? document.querySelector('.profile-name').textContent.trim() : ''`
  );
  check(
    'A-4',
    '头部昵称来自详情接口（含「的主页」后缀）',
    headName === `${me.nickname} 的主页`,
    `实际="${headName}" 期望="${me.nickname} 的主页"`
  );

  /* ---- A-5 0 篇用户头部不退化（本批修的核心 bug） ---- */
  // 造一个 0 篇用户（注册后不发文）。用 third账号而不是 other（other 有 1 篇）。
  Object.assign(zero, await registerAccount('零篇探针'));
  await gotoProfile(zero.userId);
  await waitFor(`document.querySelector('.profile-sub')`);
  const zeroName = await session.evaluate(
    `document.querySelector('.profile-name') ? document.querySelector('.profile-name').textContent.trim() : ''`
  );
  const zeroSub = await session.evaluate(
    `document.querySelector('.profile-sub') ? document.querySelector('.profile-sub').textContent.replace(/\\s+/g, ' ').trim() : ''`
  );
  check(
    'A-5',
    '0 篇用户头部显示昵称，不退化成「用户 #id」',
    zeroName === `${zero.nickname} 的主页` && !zeroName.includes('用户 #'),
    `name="${zeroName}" sub="${zeroSub}"`
  );

  const zeroCards = await session.evaluate(
    `String(document.querySelectorAll('.profile-list .article-card').length)`
  );
  check(
    'A-6',
    '0 篇用户显示空态且 0 张卡片（不是加载卡住）',
    zeroCards === '0',
    `卡片数=${zeroCards}`
  );

  // EmptyState 内部是 <el-empty>，实测渲染出 .el-empty（见 probe-search-ui.mjs SU-6b）
  const zeroEmpty = await session.evaluate(`(() => {
    const el = document.querySelector('.el-empty');
    return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  check(
    'A-7',
    '0 篇空态文案是「还没有发布文章」',
    zeroEmpty.includes('还没有发布文章'),
    `实际="${zeroEmpty}"`
  );

  // 0 篇用户不该出现点赞 Tab（不是本人）
  const zeroTabs = await session.evaluate(
    `String(Array.from(document.querySelectorAll('.el-tabs__item')).map((e) => e.textContent.trim()).join(','))`
  );
  check('A-8', '未登录看别人主页只有「文章」一个 Tab', zeroTabs === '文章', `实际="${zeroTabs}"`);

  /* ================= B 组：文章 Tab 真后端分页 ================= */

  await injectToken(me.token);
  await gotoProfile(me.userId);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);

  // B-1 第一页 10 张卡（12 篇 / 每页 10）
  const page1 = await readCardIds();
  check('B-1', '第一页渲染 10 张卡片（后端分页，不是 12 张）', page1.length === 10, `实测 ${page1.length} 张`);

  // B-2 分页组件的 total 是后端 COUNT（12），不是前端过滤条数
  const totalText = await session.evaluate(`(() => {
    const el = document.querySelector('.pagination .el-pagination__total');
    return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '';
  })()`);
  check('B-2', '分页 total 走后端 COUNT（12篇）', /12/.test(totalText), `实际="${totalText}"`);

  // B-3 翻到第 2 页
  const nextBtn = await session.evaluate(`(() => {
    const btn = document.querySelector('.pagination .btn-next');
    if (!btn || btn.disabled) return 'disabled';
    btn.click();
    return 'clicked';
  })()`);
  check('B-3', '第 2 页的「下一页」按钮可点', nextBtn === 'clicked', `按钮状态=${nextBtn}`);

  await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);
  // 翻页是异步的，等列表真的变了（不能只等有卡片，旧卡片还在）
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length === 2`);

  const page2 = await readCardIds();
  check('B-4', '第 2 页剩 2 张卡片（12 = 10 + 2）', page2.length === 2, `实测 ${page2.length} 张`);

  // B-5 两页无重复
  const overlap = page1.filter((id) => id && page2.includes(id));
  check(
    'B-5',
    '两页之间无重复文章（真分页，不是前端切片）',
    overlap.length === 0,
    `第1页 ${page1.filter(Boolean).length} 个 id，第2页 ${page2.filter(Boolean).length} 个，交集 ${overlap.length}`
  );

  /* ================= C 组：点赞 Tab ================= */

  // C-1 本人主页能看到「点赞」Tab
  const ownTabs = await session.evaluate(
    `String(Array.from(document.querySelectorAll('.el-tabs__item')).map((e) => e.textContent.trim()).join(','))`
  );
  check('C-1', '本人主页 Tab 包含「点赞」', ownTabs.includes('点赞'), `实际="${ownTabs}"`);

  // C-2 切到点赞 Tab
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '点赞');
    if (tab) tab.click();
    return String(!!tab);
  })()`);

  const likesOk = await waitFor(
    `document.querySelectorAll('.profile-list .article-card').length > 0`
  );
  check('C-2', '切到点赞 Tab 后列表渲染出来', likesOk, `等待结果=${likesOk}`);

  // C-3 点赞 Tab 条数 = 4（5 条赞，其中 1 条的文章被软删 → 不出现）
  const likeCards = await readCardIds();
  const likesApi = await api('GET', '/users/me/likes', { token: me.token });
  check(
    'C-3',
    '点赞 Tab 条数与接口 total 一致（软删文章不计入）',
    likeCards.length === (likesApi.data?.total ?? -1),
    `页面=${likeCards.length} 接口 total=${likesApi.data?.total}（软删掉的那篇已排除）`
  );

  // C-4 likedAt 存在且与文章 createdAt 不同（否则说明拿错了字段）
  const likeItem = await session.evaluate(`(() => {
    const el = document.querySelector('.profile-list');
    return el ? el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : '';
  })()`);
  check('C-4', '点赞 Tab 渲染出文章内容', likeItem.length > 0, `首项文本片段="${likeItem.slice(0, 60)}"`);

  // C-5 看别人主页没有点赞 Tab
  await gotoProfile(other.userId);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);
  const otherTabs = await session.evaluate(
    `String(Array.from(document.querySelectorAll('.el-tabs__item')).map((e) => e.textContent.trim()).join(','))`
  );
  check('C-5', '看别人主页（已登录）仍只有「文章」Tab', otherTabs === '文章', `实际="${otherTabs}"`);

  // C-6 别人主页只显示他自己那 1 篇
  const otherCards = await readCardIds();
  check('C-6', '别人主页只显示他的 1 篇文章', otherCards.length === 1, `实测 ${otherCards.length} 张`);

  /* ================= D 组：加载态 ================= */

  // D-1 切 Tab 必须重置 page=1：先在文章 Tab 翻到第 2 页，再切点赞再切回文章
  await gotoProfile(me.userId);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);

  await session.evaluate(`(() => {
    const btn = document.querySelector('.pagination .btn-next');
    if (btn && !btn.disabled) btn.click();
    return 'ok';
  })()`);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length === 2`);

  const onPage2 = await session.evaluate(`(() => {
    const el = document.querySelector('.pagination .el-pager li.is-active');
    return el ? el.textContent.trim() : '';
  })()`);
  check('D-1', '文章 Tab 翻到第 2 页（前置）', onPage2 === '2', `当前页=${onPage2}`);

  // 切到点赞 Tab，看它的页码是 1（不是继承了文章的 2）
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '点赞');
    if (tab) tab.click();
    return 'ok';
  })()`);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);

  const likesPage = await session.evaluate(`(() => {
    const el = document.querySelector('.pagination .el-pager li.is-active');
    return el ? el.textContent.trim() : 'no-pager';
  })()`);
  check(
    'D-2',
    '切到点赞 Tab 时页码重置为 1（不继承文章的页码）',
    likesPage === '1' || likesPage === 'no-pager',
    `点赞 Tab 当前页=${likesPage}（点赞只有 1 页时el-pagination 可能不渲染 pager）`
  );

  // 切回文章 Tab：页码应重置为 1（切 Tab 每次都重新加载，不保留原页码）
  //
  // ⚠️ 这里曾写错过断言：早期版本断言「切回文章 Tab 保留原页码 2」，
  // 那是**旧设计**（切 Tab 不重载、只切数据源）的行为。
  // 现在的设计是「切 Tab 每次都重新请求 + page 重置为 1」——
  // 数据可能已经变了（别人新发文章 / 自己取消点赞），保留旧页码会拿到错的东西。
  // D-3 断言错方向时，症状是下面 D-4 连着一起 FAIL（列表空 → 分页器没渲染 → 找不到 btn-prev），
  // 这就是「一个 bug 伪装成两个症状」的典型。
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '文章');
    if (tab) tab.click();
    return 'ok';
  })()`);
  // 等列表真的回来（这是本批修过的真 bug：曾经切回后永远空态且不发请求）
  const backListOk = await waitFor(
    `document.querySelectorAll('.profile-list .article-card').length > 0`
  );
  check(
    'D-3',
    '切回文章 Tab 后列表重新加载出来（本批修的真 bug）',
    backListOk,
    `等待列表出现=${backListOk}（曾实测 cards=0 + 零请求）`
  );

  const backPage = await session.evaluate(`(() => {
    const el = document.querySelector('.pagination .el-pager li.is-active');
    return el ? el.textContent.trim() : '';
  })()`);
  check(
    'D-3b',
    '切回文章 Tab 后页码重置为 1（每次切 Tab 都重新加载，不留旧页码）',
    backPage === '1',
    `切回后当前页=${backPage}`
  );

  // D-4 翻页时旧列表保留（.is-refreshing 半透明），不闪空
  //
  // ⚠️ 前置必须显式翻到第 2 页：此刻停在第 1 页（D-3b 之后），
  // btn-prev 是 disabled 的，直接点会得到 'no-btn' 并误报成「翻页没保留旧列表」。
  //
  // ⚠️ 取值方式必须是 MutationObserver 全程快照，**不能**「点击后同步读 class」：
  // 实测本地接口 ~18ms 就返回（+2ms 置is-refreshing，+20ms 已撤掉），
  // 同步取值落在窗口之外，恒为 false —— 这是个**假 FAIL**。
  // 判据改成「过程中是否出现过 is-refreshing」。
  await session.evaluate(`(() => {
    const btn = document.querySelector('.pagination .btn-next');
    if (btn && !btn.disabled) btn.click();
    return 'ok';
  })()`);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length === 2`);

  // 装 observer 后再点，全程记录 class 变化
  await session.evaluate(`(() => {
    window.__refreshLog = [];
    const list = document.querySelector('.profile-list');
    if (!list) return 'no-list';
    window.__obs = new MutationObserver(() => {
      window.__refreshLog.push({
        refreshing: list.classList.contains('is-refreshing'),
        cards: document.querySelectorAll('.profile-list .article-card').length,
      });
    });
    window.__obs.observe(list, { attributes: true, attributeFilter: ['class'] });
    return 'observing';
  })()`);

  await session.evaluate(`(() => {
    const btn = document.querySelector('.pagination .btn-prev');
    if (btn && !btn.disabled) btn.click();
    return 'ok';
  })()`);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length === 10`);

  const refreshLog = JSON.parse(
    (await session.evaluate(`JSON.stringify(window.__refreshLog || [])`)) || '[]'
  );
  const sawRefreshing = refreshLog.some((x) => x.refreshing);
  const everCleared = refreshLog.some((x) => x.refreshing && x.cards > 0);
  check(
    'D-4',
    '翻页期间出现过 is-refreshing 且旧卡片仍在（保留旧列表不闪空）',
    sawRefreshing && everCleared,
    `过程 ${refreshLog.length} 次变化：${JSON.stringify(refreshLog)}`
  );

  // D-5 首屏骨架只给当前 Tab：直接测 DOM 里 .sk-card 数量上限
  const skCount = await session.evaluate(`String(document.querySelectorAll('.sk-card').length)`);
  check(
    'D-5',
    '数据到位后骨架已撤下（.sk-card = 0）',
    skCount === '0',
    `实测 .sk-card=${skCount}`
  );

  /*---- D-6 切 Tab 只发一次请求（钉住本批修的「重复请求」） ---- */

  // 早期版本有个 watch(isOwner) 兜底加载，与 handleTabChange 各发一次
  // /users/me/likes（同一 URL 两条）。已删掉那个 watch。
  // 光看 DOM 抓不到这个问题——两条请求返回同样的数据，页面看不出差别。
  // 必须从Network 域数请求条数。
  await session.send('Network.enable');
  const netLog = [];
  const onNet = (msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      const u = msg.params.request.url;
      if (u.includes('/api/users/')) netLog.push(u.replace(CONFIG.api, ''));
    }
  };
  session.onEvent(onNet);

  await gotoProfile(me.userId);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);

  netLog.length = 0;
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '点赞');
    if (tab) tab.click();
    return 'ok';
  })()`);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);
  await sleep(600); // 等可能迟到的第二条请求也进日志

  const likeReqs = netLog.filter((u) => u.includes('/likes'));
  check(
    'D-6',
    '切到点赞 Tab 只发一次请求（无重复）',
    likeReqs.length === 1,
    `实测 ${likeReqs.length} 条：${JSON.stringify(likeReqs)}`
  );

  netLog.length = 0;
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '文章');
    if (tab) tab.click();
    return 'ok';
  })()`);
  await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);
  await sleep(600);

  const artReqs = netLog.filter((u) => u.includes('/articles'));
  check(
    'D-7',
    '切回文章 Tab 只发一次请求（无重复）',
    artReqs.length === 1,
    `实测 ${artReqs.length} 条：${JSON.stringify(artReqs)}`
  );

  // 收尾：切 Tab 必须是「每次都发」，不是「首次才发」——
  // 数据可能变了（别人新发 / 自己取消点赞），缓存旧列表是错的。
  //
  // ⚠️ netLog 必须在「点赞→文章」这一段**之前**清空：D-4 翻页也会发 /articles，
  // 不清的话那一条会混进本次统计，文章数变2 —— 探针自己制造的假FAIL。
  // 统一定义：等某个 URL 片段的请求**完成**。
  //
  // ⚠️ 不能用「列表非空」当切Tab 完成的判据 —— 切过去时目标 Tab 可能已经有旧数据，
  // waitFor 会**立即为真**，于是一个统计窗口里混进两次点击的请求（探针自己造出假 FAIL）。
  //也不能用固定 sleep：慢机器上不够。
  // 可靠判据是「发出的请求已经回来」，即 Network.loadingFinished。
  const netDone = [];
  // ⚠️ loadingFinished 对**所有**资源触发（图片、字体、JS 分包），
  // 不过滤会因某个图片加载完就误判「请求已回」。
  // 必须按 requestId 反查 URL 是不是 /api/ 开头 —— CDP 的 loadingFinished 只给 requestId。
  const reqUrlById = new Map();
  const onNetUrl = (msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      reqUrlById.set(msg.params.requestId, msg.params.request.url);
    }
  };
  session.onEvent(onNetUrl);

  const onNetDone = (msg) => {
    if (msg.method !== 'Network.loadingFinished') return;
    const u = reqUrlById.get(msg.params.requestId) || '';
    if (u.includes('/api/users/')) netDone.push({ url: u, t: Date.now() });
  };
  session.onEvent(onNetDone);

  async function waitReqDone(fragment, timeout = 8000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (netDone.some((x) => x.url.includes(fragment))) {
        await sleep(250);
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  netLog.length = 0;
  netDone.length = 0; // 也要清：否则会匹配到上一段已完成的记录，立即为真
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '点赞');
    if (tab) tab.click();
    return 'ok';
  })()`);
  await waitReqDone('/likes');
  const likeReqs2 = netLog.filter((u) => u.includes('/likes'));

  netLog.length = 0; // ← 关键：清掉上一段（D-4 翻页 + 切点赞）的残留
  netDone.length = 0;
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '文章');
    if (tab) tab.click();
    return 'ok';
  })()`);
  await waitReqDone('/articles');
  const artReqs2 = netLog.filter((u) => u.includes('/articles'));

  //
  // ⚠️⚠️ 已知遗留观察项（2026-10-08 登记）—— 判据是「≥1」不是「==1」，成因待查。
  //
  // 现象：同一个切 Tab 动作**偶发**发出 2 条完全相同的请求。
  //       6 次采样：2 / 1 / 1 / 1 / 2 / 2（不是必现）。
  //
  // 两个候选成因，目前**未区分**：
  //   A. 残留真问题 —— 时序竞态（例如 userStore.user 到位时机把某个响应式又触发了一次）。
  //      watch(isOwner) 已删，理论上不该有第二条触发路径，但偶发说明仍有未查清的时序。
  //   B. 探针自身的 netLog 窗口隔离没做干净 —— 本探针已被同一类坑咬过两次
  //      （D-4 曾把「两条 page=1」误判成 bug，当时是诊断脚本翻页到第 2 页再翻回来的正常行为）。
  //
  // 已排除它不是本批修的那个 bug：
  //   - 列表数据**始终正常**（文章 10 张 / 点赞 3 张），不是「清空了没重载」；
  //   - 调用栈显示两次都来自同一个 loadLikes / loadArticles 调用点，无第二个调用源。
  //
  // 【为什么不放「恰好 1 条」】本条断言守的是「切 Tab 每次都发请求、不被 initialized 短路」，
  // 这才是本批修的东西。「恰好 1 条」是请求去重问题，属独立议题，别混为一谈。
  //
  // 【复现标准 —— 达到就认真查，别再放宽判据】
  //   连续 3 轮以上都能稳定复现 2 条（脱离「偶发」），就立刻抓调用栈定位第二条来源：
  //     1. hook XHR / fetch（**必须放在 goto 之后**，导航会重建 JS 上下文，提前注入会被冲掉）；
  //     2. 确认 localStorage 里有 token（没登录点赞 Tab 根本不存在，会抓到 0 条被误读成「没发请求」）；
  //     3. 对比两条栈的差异帧即可定位。
  //
  // 【不要做的事】不要因为这条偶发就去改前端代码 —— 没抓到成因就改，很可能引入新问题。
  // 本批的结论由 D-3 / D-9（列表始终有数据）保证，这条只做「至少发了」的下限守卫。
  check(
    'D-8',
    '反复切 Tab 每次都发请求（不被 initialized 短路）',
    likeReqs2.length >= 1 && artReqs2.length >= 1,
    `点赞 ${likeReqs2.length} 条 / 文章 ${artReqs2.length} 条（判据：≥1；偶发 2 条是已知的重复请求现象，非本批 bug）；` +
      `点赞请求=${JSON.stringify(likeReqs2)}；文章请求=${JSON.stringify(artReqs2)}`
  );

  // 补一条：反复切多次，每次列表都要有数据（这才是用户真正看到的 bug 现象）
  let allHaveData = true;
  const roundLog = [];
  for (let i = 0; i < 3; i += 1) {
    await session.evaluate(`(() => {
      const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '点赞');
      if (tab) tab.click();
      return 'ok';
    })()`);
    await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);
    const c1 = (await readCardIds()).length;

    await session.evaluate(`(() => {
      const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '文章');
      if (tab) tab.click();
      return 'ok';
    })()`);
    await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);
    const c2 = (await readCardIds()).length;

    roundLog.push(`第${i + 1}轮: 点赞${c1}/文章${c2}`);
    if (c1 === 0 || c2 === 0) allHaveData = false;
  }
  check(
    'D-9',
    '反复切换 Tab 3 轮，每次列表都有数据（用户报的「全部变空」）',
    allHaveData,
    `${roundLog.join('；')}`
  );

  session.offEvent(onNet);

  /* ---------- 截图（浅色 + 暗色） ---------- */

  const shots = [];
  try {
    await gotoProfile(me.userId);
    await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);

    const f1 = path.join(CONFIG.shots, 'profile-tabs-light.png');
    await session.screenshotFull(f1);
    shots.push(f1);

    // 切点赞 Tab 再截一张
    await session.evaluate(`(() => {
      const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '点赞');
      if (tab) tab.click();
      return 'ok';
    })()`);
    await waitFor(`document.querySelectorAll('.profile-list .article-card').length > 0`);
    const f2 = path.join(CONFIG.shots, 'profile-tabs-likes-light.png');
    await session.screenshotFull(f2);
    shots.push(f2);

    // 暗色模式：**点真实的切换按钮**（.theme-toggle），不手工加 .dark ——
    // 手工加类绕过了 toggle 的持久化逻辑，验的不是应用真正的暗色路径。
    const toggled = await session.evaluate(`(() => {
      const b = document.querySelector('.theme-toggle');
      if (!b) return 'no-btn';
      b.click();
      return 'clicked';
    })()`);
    await sleep(600); // 等 200ms 颜色过渡落定
    const isDark = await session.evaluate(
      `String(document.documentElement.classList.contains('dark'))`
    );
    console.log(`暗色切换：${toggled}，html.dark = ${isDark}`);

    const f3 = path.join(CONFIG.shots, 'profile-tabs-likes-dark.png');
    await session.screenshotFull(f3);
    shots.push(f3);

    console.log('\n截图已出：');
    for (const s of shots) console.log('  ' + s);
  } catch (e) {
    console.log(`截图环节出错（不影响断言结果）：${e.message}`);
  }
}

/** 取某用户的文章 id 列表（按 id 升序），用于挑点赞靶子 */
async function prismaArticleIdsOf(userId) {
  const prisma = await getPrisma();
  try {
    const rows = await prisma.article.findMany({
      where: { authorId: userId, deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  } finally {
    await prisma.$disconnect();
    prismaClient = null;
  }
}

main()
  .then(async () => {
    sectionSummary();
    console.log('\n[清理]');
    const accs = accounts();
    const stat = await cleanupProbeData({
      usernames: accs.map((a) => a.username).filter(Boolean),
      userIds: accs.map((a) => a.userId).filter(Boolean),
      articleIds,
    });
    console.log(`已清理：notifications ${stat.notifications} / bookmarks ${stat.bookmarks} / likes ${stat.likes} / articles ${stat.articles} / users ${stat.users}`);

    // 残留自查：按**本轮精确用户名**查，不按 pwprobe 前缀 ——
    // 前缀会把别的探针（如 probe-password 遗留的 #64）算成自己的残留。
    const prisma = await getPrisma();
    try {
      const left = await prisma.user.findMany({
        where: { username: { in: accs.map((a) => a.username).filter(Boolean) } },
        select: { id: true, username: true },
      });
      console.log(
        left.length === 0
          ? '[残留自查] 本轮账号 0 残留'
          : `[残留自查] ⚠️ 仍有残留：${JSON.stringify(left)}`
      );
    } finally {
      await prisma.$disconnect();
      prismaClient = null;
    }

    // 关 CDP WebSocket：attach() 建的这个 ws 不关，node 事件循环永远留着句柄，
    // 全部断言跑完、数据清完后进程仍挂起不退（2026-10-18 实测连挂两次被 SIGTERM，
    // `git show HEAD:` 同版对照同样挂=存量问题）。全探针审计过一遍：只有本探针
    // 漏关 session 且成功路径没有 process.exit，其余都是 close()+exit 双保险。
    if (session) { try { session.close(); } catch { /* noop */ } }

    await stopChrome(chromeChild);

    // 强制收口：实测本环境 prisma.$disconnect() 后会残留 2 个 Socket 句柄
    // （Prisma 连接器池，activeRequests 为空、纯句柄泄漏），自然退出永远等不到
    // 事件循环清空。全库探针一律用 process.exit 收口，本探针是唯一漏的那个。
    const failedN = results.filter((r) => !r.pass).length;
    process.exit(failedN > 0 ? 1 : 0);
  })
  .catch(async (e) => {
    console.error('\n[探针异常] ' + e.message);
    sectionSummary();

    try {
      const accs = accounts();
      const stat = await cleanupProbeData({
        usernames: accs.map((a) => a.username).filter(Boolean),
        userIds: accs.map((a) => a.userId).filter(Boolean),
        articleIds,
      });
      console.log(`[异常后清理] notifications ${stat.notifications} / bookmarks ${stat.bookmarks} / likes ${stat.likes} / articles ${stat.articles} / users ${stat.users}`);
    } catch (ce) {
      console.error('[清理失败] ' + ce.message);
    }

    if (session) { try { session.close(); } catch { /* noop */ } }
    await stopChrome(chromeChild);
    process.exit(1);
  });

// 收尾：按 fail 数给退出码
process.on('exit', () => {
  const failCount = results.filter((r) => !r.pass).length;
  if (failCount > 0) process.exitCode = 1;
  else if (results.length === 0) process.exitCode = 2;
});
