// 第 5 批管理后台 + 权限系统 + 代码块/TOC 探针（probe-admin.mjs）。
//
// 覆盖 36 项：
//   A 组 非管理员（7）  —— temp 账号当普通用户靶子：401 / 403 各档 + 无副作用断言
//   B 组 管理员（19）   —— stats / users / PATCH / articles / comments 全流程，
//                          含「封禁 ADMIN → 40000 且 status 未变」的防呆断言
//   C 组 role 透出（3） —— users/167、users/2、auth/me 均为 ADMIN
//   D 组 Chrome（3）    —— /admin 路由守卫（非 admin 回首页）+ 统计卡渲染 + 金色徽章
//   E 组 代码块/TOC（6）—— hljs 高亮 / TOC 数量与滚动 / XSS 净化（script 与 onerror）
//
// 账号策略：admin(2) / lin(167) 是真实账号，用 mintToken 铸 token（不碰密码），
// 只做只读断言 + 「封禁 ADMIN 被拒」的负向断言（不会真改它们状态）；
// 写操作全部用 temp 账号（register 真注册），finally 物理删（FK RESTRICT 序）。
import path from 'node:path';
import { CONFIG, ensureDirs, sleep, requireCjs, BACKEND, BACKEND_MODULES } from './lib/config.mjs';
import { cdpAlive, attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { mintToken } from './lib/session.mjs';

ensureDirs();

/* ---------- 计数与输出 ---------- */

let passed = 0;
let failed = 0;
const failures = [];

function check(id, desc, pass, detail = '') {
  if (pass) {
    passed += 1;
    console.log(`PASS ${id} ${desc}${detail ? ' | ' + detail : ''}`);
  } else {
    failed += 1;
    failures.push(`${id} ${desc}${detail ? ' | ' + detail : ''}`);
    console.log(`FAIL ${id} ${desc}${detail ? ' | ' + detail : ''}`);
  }
}

function summarize() {
  console.log('----------------------------------------');
  console.log(`合计 ${passed + failed} 项：PASS ${passed} / FAIL ${failed}`);
  if (failures.length) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
  }
}

/* ---------- HTTP ---------- */

// 字符串字面量（注入 localStorage / evaluate 用），防引号逃逸。
function lit(value) {
  return JSON.stringify(String(value));
}

async function api(method, urlPath, { token = null, body = null } = {}) {
  // 网络层错误重试（后端 --watch 偶发重启会掐断在途请求）；业务 4xx / 409 绝不重试。
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(CONFIG.api + urlPath, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* 保留 null */
      }
      return { http: res.status, json };
    } catch (error) {
      if (attempt === 4) throw error;
      console.log(`[RETRY] ${method} ${urlPath} 第 ${attempt} 次失败：${error.message}`);
      await sleep(1500);
    }
  }
}

/* ---------- Prisma（直连，只读基线 + 清理自造数据） ---------- */

let prismaClient = null;

async function getPrisma() {
  if (prismaClient) return prismaClient;

  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));
  prismaClient = new PrismaClient();

  return prismaClient;
}

/* ---------- 账号 ---------- */

const state = {
  admin: null,
  lin: null,
  tempA: null, // 被封禁 / 发文章 / 发评论的靶子
  tempB: null, // 普通用户（403 靶子 + Chrome 守卫靶子）
  xssArticleId: null,
  chrome: null,
  session: null,
};

async function makeAccount(tag) {
  // 409 = 上次运行的残留（finally 没跑完），换后缀重试，别把失败当环境问题。
  const username = `pwprobe-admin-${tag}-${Date.now()}`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await api('POST', '/auth/register', {
      body: { username, password: 'probe-pass-123' },
    });

    if (res.http === 201 && res.json?.code === 0) {
      // ⚠️ register 响应**不含 token**（只有 public user，docs/API.md）。
      // 用 mintToken 自铸（不碰密码），否则后续请求全是 40100。
      const { token } = mintToken(res.json.data.id, username);

      return {
        id: res.json.data.id,
        username,
        token,
      };
    }

    if (res.http === 409) {
      await sleep(200);
      continue;
    }

    throw new Error(`注册 temp 账号失败：HTTP ${res.http} ${JSON.stringify(res.json)}`);
  }

  throw new Error(`注册 temp 账号 409 重试 3 次仍失败：${username}`);
}

/* ---------- 物理清理（FK RESTRICT 序） ---------- */

async function hardDeleteUser(prisma, userId) {
  // 硬删序（docs/DB.md）：likes → follows → comments → articles → users。
  // 文章的 comments / likes 是上游，必须先清（RESTRICT 会在顺序错误时直接拒绝）。
  const articles = await prisma.article.findMany({
    where: { authorId: userId },
    select: { id: true },
  });

  for (const article of articles) {
    await prisma.like.deleteMany({ where: { articleId: article.id } });
    await prisma.comment.deleteMany({ where: { articleId: article.id } });
  }

  await prisma.like.deleteMany({ where: { userId } });
  await prisma.follow.deleteMany({ where: { OR: [{ followerId: userId }, { followingId: userId }] } });
  await prisma.comment.deleteMany({ where: { authorId: userId } });
  await prisma.article.deleteMany({ where: { authorId: userId } });
  await prisma.user.delete({ where: { id: userId } });
}

/* ---------- Chrome 辅助 ---------- */

async function openPage(session, url) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await session.goto(url);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1500);
    }
  }
}

// 等页面就绪（Vue 挂载完成）：document.readyState + 根节点有子元素。
async function waitForPageReady(session, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const ready = await session.evaluate(
        `document.readyState === 'complete' && document.getElementById('app')?.children.length > 0`
      );
      if (ready) return;
    } catch {
      /* 重试 */
    }
    await sleep(300);
  }
  throw new Error('等待页面就绪超时');
}

// 注入登录态（mintToken 模式，不碰密码）。
async function injectToken(session, token) {
  await session.evaluate(`localStorage.setItem('token', ${lit(token)}); 'ok'`);
}

// 等路由到达（pathname 匹配）。给 D1 的「非 admin 被弹回首页」用。
async function waitForPath(session, expected, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const pathname = await session.evaluate(`location.pathname`);
      if (pathname === expected) return true;
    } catch {
      /* 重试 */
    }
    await sleep(300);
  }
  return false;
}

// 等选择器出现。
async function waitForSelector(session, selector, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const found = await session.evaluate(`Boolean(document.querySelector(${lit(selector)}))`);
      if (found) return true;
    } catch {
      /* 重试 */
    }
    await sleep(300);
  }
  return false;
}

// 真实鼠标点击（CDP Input 事件），坐标取元素实时 boundingRect。
async function clickElement(session, selector, index = 0) {
  const rect = await session.evaluate(
    `(() => { const els = document.querySelectorAll(${lit(selector)}); const el = els[${index}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
  );
  if (!rect) throw new Error(`找不到点击目标：${selector}[${index}]`);

  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type,
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    });
  }
}

/* ---------- 主流程 ---------- */

async function main() {
  /* ===== preflight ===== */
  const health = await fetch(CONFIG.api + '/health').then((r) => r.json()).catch(() => null);
  if (!health || health.data?.status !== 'ok') {
    throw new Error('后端不可达，请先启动 3000');
  }
  const fe = await fetch(CONFIG.frontend).catch(() => null);
  if (!fe) {
    throw new Error('前端不可达，请先启动 5173');
  }

  const prisma = await getPrisma();
  state.admin = await prisma.user.findFirst({ where: { username: 'admin' }, select: { id: true, username: true, role: true, status: true } });
  state.lin = await prisma.user.findFirst({ where: { username: 'lin' }, select: { id: true, username: true, role: true, status: true } });

  if (!state.admin || !state.lin) {
    throw new Error('admin / lin 账号不存在（第 5 批前置调研要求两者都在）');
  }
  if (state.admin.role !== 'ADMIN' || state.lin.role !== 'ADMIN') {
    throw new Error(`admin / lin 不是 ADMIN（admin=${state.admin.role} lin=${state.lin.role}）——先执行 UPDATE users SET role='ADMIN' WHERE username IN ('admin','lin')`);
  }
  console.log(`PREFLIGHT admin=id${state.admin.id}(ADMIN) lin=id${state.lin.id}(ADMIN)`);

  const adminToken = mintToken(state.admin.id, state.admin.username).token;
  const linToken = mintToken(state.lin.id, state.lin.username).token;

  state.tempA = await makeAccount('a');
  state.tempB = await makeAccount('b');
  console.log(`TEMP A=id${state.tempA.id} B=id${state.tempB.id}`);

  // 取一篇未软删文章 id（DELETE 403 无副作用断言用，不硬编码）。
  const someArticle = await prisma.article.findFirst({
    where: { deletedAt: null },
    select: { id: true },
    orderBy: { id: 'desc' },
  });
  const someComment = await prisma.comment.findFirst({
    where: { deletedAt: null },
    select: { id: true },
    orderBy: { id: 'desc' },
  });

  /* ===== A 组：非管理员（7） ===== */
  console.log('---- A 组：非管理员 ----');

  const a1 = await api('GET', '/admin/stats');
  check('A1', 'stats 无 token → 401/40100', a1.http === 401 && a1.json?.code === 40100, JSON.stringify(a1.json));

  const a2 = await api('GET', '/admin/users', { token: state.tempB.token });
  check('A2', 'users temp → 403/40300', a2.http === 403 && a2.json?.code === 40300, JSON.stringify(a2.json));

  const a3 = await api('GET', '/admin/articles', { token: state.tempB.token });
  check('A3', 'articles temp → 403/40300', a3.http === 403 && a3.json?.code === 40300);

  const a4 = await api('GET', '/admin/comments', { token: state.tempB.token });
  check('A4', 'comments temp → 403/40300', a4.http === 403 && a4.json?.code === 40300);

  const demoBefore = await prisma.user.findFirst({ where: { id: 1 }, select: { status: true } });
  const a5 = await api('PATCH', '/admin/users/1/status', { token: state.tempB.token, body: { status: 'BANNED' } });
  const demoAfter = await prisma.user.findFirst({ where: { id: 1 }, select: { status: true } });
  check('A5', 'PATCH status temp → 403', a5.http === 403 && a5.json?.code === 40300);
  check('A5b', 'PATCH 无副作用（demo 状态未变）', demoBefore.status === demoAfter.status, `${demoBefore.status}`);

  const a6 = await api('DELETE', `/admin/articles/${someArticle.id}`, { token: state.tempB.token });
  const artAfter = await prisma.article.findFirst({ where: { id: someArticle.id }, select: { deletedAt: true } });
  check('A6', 'DELETE article temp → 403', a6.http === 403 && a6.json?.code === 40300);
  check('A6b', 'DELETE article 无副作用（未软删）', artAfter.deletedAt === null);

  const a7 = await api('DELETE', `/admin/comments/${someComment.id}`, { token: state.tempB.token });
  const comAfter = await prisma.comment.findFirst({ where: { id: someComment.id }, select: { deletedAt: true } });
  check('A7', 'DELETE comment temp → 403', a7.http === 403 && a7.json?.code === 40300);
  check('A7b', 'DELETE comment 无副作用（未软删）', comAfter.deletedAt === null);

  /* ===== B 组：管理员（19） ===== */
  console.log('---- B 组：管理员 ----');

  const b1 = await api('GET', '/admin/stats', { token: adminToken });
  const d1 = b1.json?.data || {};
  check('B1', 'stats admin → 200 六计数齐全', b1.http === 200 && ['users', 'articles', 'comments', 'likes', 'follows', 'deletedArticles'].every((k) => typeof d1[k] === 'number'), JSON.stringify(d1));

  const usersCount = await prisma.user.count({ where: { deletedAt: null } });
  check('B2', 'stats.users ≡ COUNT(users 未软删)', d1.users === usersCount, `${d1.users} vs ${usersCount}`);

  const b3 = await api('GET', '/admin/users?page=1&pageSize=2', { token: adminToken });
  const u3 = b3.json?.data || {};
  check('B3', 'users 分页 meta 正确', b3.http === 200 && u3.page === 1 && u3.pageSize === 2 && Array.isArray(u3.list) && u3.list.length === 2 && u3.total === usersCount && u3.totalPages === Math.ceil(usersCount / 2), JSON.stringify({ page: u3.page, total: u3.total, totalPages: u3.totalPages }));

  check('B4', 'users 无 password 键', u3.list.every((u) => u.password === undefined));
  check('B5', 'users 带 role/status', u3.list.every((u) => typeof u.role === 'string' && typeof u.status === 'string'));

  const b6 = await api('GET', `/admin/users?keyword=${encodeURIComponent('lin')}`, { token: adminToken });
  const u6 = b6.json?.data?.list || [];
  check('B6', 'users keyword=lin 命中且全部匹配', b6.http === 200 && u6.some((u) => u.username === 'lin') && u6.every((u) => u.username.includes('lin') || (u.nickname || '').includes('lin')), `命中 ${u6.length} 条`);

  const b7a = await api('GET', '/admin/users?status=ACTIVE', { token: adminToken });
  check('B7', 'users status=ACTIVE 筛选', b7a.http === 200 && (b7a.json?.data?.list || []).every((u) => u.status === 'ACTIVE'));
  const b7b = await api('GET', '/admin/users?status=XXX', { token: adminToken });
  check('B7b', 'users status 非法值 → 400/40000', b7b.http === 400 && b7b.json?.code === 40000, JSON.stringify(b7b.json));

  const b8 = await api('PATCH', `/admin/users/${state.tempA.id}/status`, { token: adminToken, body: { status: 'BANNED' } });
  check('B8', 'PATCH 封禁 tempA → 200 且 status=BANNED', b8.http === 200 && b8.json?.data?.status === 'BANNED' && b8.json?.data?.role === 'USER', JSON.stringify(b8.json?.data));

  const b9 = await api('GET', '/auth/me', { token: state.tempA.token });
  check('B9', '被封 tempA 旧 token → 401/40101', b9.http === 401 && b9.json?.code === 40101, JSON.stringify(b9.json));

  const b10 = await api('POST', '/auth/login', { body: { username: state.tempA.username, password: 'probe-pass-123' } });
  check('B10', '被封 tempA 登录 → 401/40101', b10.http === 401 && b10.json?.code === 40101, JSON.stringify(b10.json));

  const b11 = await api('PATCH', `/admin/users/${state.tempA.id}/status`, { token: adminToken, body: { status: 'BANNED' } });
  check('B11', '重复封禁 tempA → 200 幂等', b11.http === 200 && b11.json?.data?.status === 'BANNED');

  const b12 = await api('PATCH', `/admin/users/${state.tempA.id}/status`, { token: adminToken, body: { status: 'ACTIVE' } });
  check('B12', '解禁 tempA → 200', b12.http === 200 && b12.json?.data?.status === 'ACTIVE');
  const b12b = await api('GET', '/auth/me', { token: state.tempA.token });
  check('B12b', '解禁后同一旧 token 恢复 200', b12b.http === 200 && b12b.json?.data?.id === state.tempA.id, `http=${b12b.http}`);

  // B13（用户 10-17 新增）：封禁 ADMIN 一刀切拒绝 + status 未变。
  const b13 = await api('PATCH', `/admin/users/${state.lin.id}/status`, { token: adminToken, body: { status: 'BANNED' } });
  const linAfter = await prisma.user.findFirst({ where: { id: state.lin.id }, select: { status: true } });
  check('B13', 'admin 封禁 lin(ADMIN) → 400/40000', b13.http === 400 && b13.json?.code === 40000 && String(b13.json?.message || '').includes('管理员'), JSON.stringify(b13.json));
  check('B13b', 'lin status 未被改变', linAfter.status === 'ACTIVE', linAfter.status);

  const b14 = await api('PATCH', `/admin/users/${state.admin.id}/status`, { token: adminToken, body: { status: 'BANNED' } });
  const adminAfter = await prisma.user.findFirst({ where: { id: state.admin.id }, select: { status: true } });
  check('B14', '封禁自己(ADMIN) → 400/40000', b14.http === 400 && b14.json?.code === 40000, JSON.stringify(b14.json));
  check('B14b', 'admin status 未被改变', adminAfter.status === 'ACTIVE', adminAfter.status);

  const b15 = await api('PATCH', '/admin/users/99999999/status', { token: adminToken, body: { status: 'BANNED' } });
  check('B15', '封禁不存在 id → 404/40400', b15.http === 404 && b15.json?.code === 40400, JSON.stringify(b15.json));

  const b16a = await api('GET', '/admin/articles?pageSize=100', { token: adminToken });
  const artsTotal = await prisma.article.count();
  const artsList = b16a.json?.data?.list || [];
  check('B16', 'admin articles total ≡ COUNT(全部含软删)', b16a.http === 200 && b16a.json?.data?.total === artsTotal, `${b16a.json?.data?.total} vs ${artsTotal}`);
  check('B16b', 'admin articles 含 deletedAt 非空行', artsList.some((a) => a.deletedAt !== null && a.deletedAt !== undefined));

  const b16c = await api('GET', '/articles?pageSize=100');
  const pubArts = b16c.json?.data?.list || [];
  check('B16c', '公开列表无 deletedAt 字段', pubArts.every((a) => a.deletedAt === undefined));
  const deletedTitle = artsList.find((a) => a.deletedAt)?.title;
  check('B16d', '软删文章公开接口看不到', deletedTitle ? !pubArts.some((a) => a.title === deletedTitle) : true, deletedTitle || '（无软删行，跳过）');

  // B17：tempA 发一篇 → admin 删 → 公开详情 404 → 再删 404。
  const pub = await api('POST', '/articles', { token: state.tempA.token, body: { title: 'pwprobe-admin-article', content: '正文'.repeat(30) } });
  check('B17a', 'tempA 发文章 → 201', pub.http === 201, `http=${pub.http}`);
  const probeArtId = pub.json?.data?.id;
  const b17b = await api('DELETE', `/admin/articles/${probeArtId}`, { token: adminToken });
  check('B17b', 'admin 删他人文章 → 200 data:null', b17b.http === 200 && b17b.json?.data === null, JSON.stringify(b17b.json));
  const b17c = await api('GET', `/articles/${probeArtId}`);
  check('B17c', '公开详情 → 404/40400', b17c.http === 404 && b17c.json?.code === 40400, `http=${b17c.http}`);
  const b17d = await api('DELETE', `/admin/articles/${probeArtId}`, { token: adminToken });
  check('B17d', '删已软删文章 → 404/40400', b17d.http === 404 && b17d.json?.code === 40400);

  const b18 = await api('GET', '/admin/comments?pageSize=100', { token: adminToken });
  const comsTotal = await prisma.comment.count();
  const comsList = b18.json?.data?.list || [];
  check('B18', 'admin comments total ≡ COUNT(全部含软删)', b18.http === 200 && b18.json?.data?.total === comsTotal, `${b18.json?.data?.total} vs ${comsTotal}`);
  check('B18b', 'admin comments 行含 articleTitle/deletedAt/author.role', comsList.length > 0 && comsList.every((c) => typeof c.articleTitle === 'string' && 'deletedAt' in c && typeof c.author?.role === 'string'), JSON.stringify(comsList[0] || null));

  const com = await api('POST', '/comments', { token: state.tempA.token, body: { articleId: someArticle.id, content: 'pwprobe-admin-comment' } });
  check('B19a', 'tempA 发评论 → 201', com.http === 201, `http=${com.http}`);
  const probeComId = com.json?.data?.id;
  const b19b = await api('DELETE', `/admin/comments/${probeComId}`, { token: adminToken });
  check('B19b', 'admin 删他人评论 → 200', b19b.http === 200 && b19b.json?.data === null);
  const b19c = await api('GET', `/articles/${someArticle.id}/comments?pageSize=100`);
  check('B19c', '公开评论列表不可见该评论', !(b19c.json?.data?.list || []).some((c) => c.id === probeComId));

  /* ===== C 组：role 透出（3） ===== */
  console.log('---- C 组：role 透出 ----');

  const c1 = await api('GET', `/users/${state.lin.id}`);
  check('C1', 'users/167(lin) → role=ADMIN', c1.http === 200 && c1.json?.data?.role === 'ADMIN', JSON.stringify(c1.json?.data?.role));
  const c2 = await api('GET', `/users/${state.admin.id}`);
  check('C2', 'users/2(admin) → role=ADMIN', c2.http === 200 && c2.json?.data?.role === 'ADMIN', JSON.stringify(c2.json?.data?.role));
  const c3 = await api('GET', '/auth/me', { token: adminToken });
  check('C3', 'auth/me(admin) → role=ADMIN', c3.http === 200 && c3.json?.data?.role === 'ADMIN', JSON.stringify(c3.json?.data?.role));
  const c4 = await api('GET', '/auth/me', { token: state.tempB.token });
  check('C4', 'auth/me(tempB) → role=USER（普通人不是 ADMIN）', c4.http === 200 && c4.json?.data?.role === 'USER', JSON.stringify(c4.json?.data?.role));

  /* ===== D 组：Chrome（3） ===== */
  console.log('---- D 组：Chrome ----');

  const alive = await cdpAlive();
  if (!alive) {
    state.chrome = await launchChrome();
  }
  state.session = await attach();

  // headless Chrome 默认视口约 800px 宽，而 ArticleToc 的媒体查询是
  // 「<1200px 隐藏」——不放大视口的话 TOC display:none，点击坐标全是 0，
  // 全部打到页面左上角（E3 曾这样挂过）。这里只改本探针的视口，不动 lib/chrome.mjs
  // （其他探针可能有自己的小屏假设）。
  await state.session.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // D1：tempB（普通用户）访问 /admin → 守卫弹回首页。
  await openPage(state.session, CONFIG.frontend + '/');
  await waitForPageReady(state.session);
  await injectToken(state.session, state.tempB.token);
  await openPage(state.session, CONFIG.frontend + '/admin');
  const bounced = await waitForPath(state.session, '/', 15000);
  check('D1', 'tempB 访问 /admin → 重定向回首页', bounced, `pathname=${await state.session.evaluate('location.pathname').catch(() => '?')}`);

  // D2：admin 访问 /admin → 统计卡渲染 6 个数字。
  await injectToken(state.session, adminToken);
  await openPage(state.session, CONFIG.frontend + '/admin');
  const statsRendered = await waitForSelector(state.session, '.admin-stat-card', 15000);
  const statValues = statsRendered
    ? await state.session.evaluate(`Array.from(document.querySelectorAll('.admin-stat-value')).map((el) => el.textContent.trim())`)
    : [];
  check('D2', 'admin 访问 /admin → 统计卡渲染 6 个数字', statsRendered && Array.isArray(statValues) && statValues.length === 6 && statValues.every((v) => /^\d+$/.test(v)), JSON.stringify(statValues));
  await state.session.screenshot(path.join(CONFIG.shots, 'probe-admin-stats.png'));

  // D3：admin 的文章详情页渲染金色「管理员」徽章。
  const adminArticle = await prisma.article.findFirst({
    where: { authorId: state.admin.id, deletedAt: null },
    select: { id: true, title: true },
    orderBy: { id: 'desc' },
  });
  if (adminArticle) {
    await openPage(state.session, CONFIG.frontend + `/article/${adminArticle.id}`);
    const badge = await waitForSelector(state.session, '.author-name .user-badge', 15000);
    const badgeText = badge ? await state.session.evaluate(`document.querySelector('.author-name .user-badge')?.textContent.trim() || ''`) : '';
    check('D3', '文章详情页渲染「管理员」徽章', badge && badgeText === '管理员', `text=${badgeText}`);
    await state.session.screenshot(path.join(CONFIG.shots, 'probe-admin-badge.png'));
  } else {
    check('D3', '文章详情页渲染「管理员」徽章', false, '找不到 admin 的未软删文章');
  }

  /* ===== E 组浏览器断言（E0 发文章 + E1-E6） ===== */
  console.log('---- E 组：代码块 / TOC / XSS ----');

  const xssContent = [
    '# 探针一级标题',
    '',
    '正文段落，包含**粗体**与列表：',
    '',
    '- 列表项甲',
    '- 列表项乙',
    '',
    '## 第一节',
    '',
    '```js',
    "const answer = 42;",
    '```',
    '',
    '## 第二节',
    '',
    '<img src=x onerror="alert(1)">',
    '',
    "<script>alert('xss-probe')</script>",
    '',
    '```',
    "console.log('无语言代码块');",
    '```',
  ].join('\n');

  const xss = await api('POST', '/articles', {
    token: state.tempA.token,
    body: { title: 'pwprobe-admin-xss', content: xssContent },
  });
  check('E0', '发 XSS/markdown 测试文章 → 201', xss.http === 201, `http=${xss.http}`);
  state.xssArticleId = xss.json?.data?.id;

  await openPage(state.session, CONFIG.frontend + `/article/${state.xssArticleId}`);
  await waitForSelector(state.session, '.article-content pre code', 15000);
  await sleep(800); // 等 hljs.highlightElement 跑完（onMounted 后 nextTick）

  const e1 = await state.session.evaluate(
    `(() => { const code = document.querySelector('.article-content pre code'); return code ? code.className : ''; })()`
  );
  check('E1', '代码块渲染 <pre><code class="hljs">', String(e1).includes('hljs'), `class=${e1}`);

  const e2 = await state.session.evaluate(`document.querySelectorAll('.article-toc .el-anchor__link').length`);
  check('E2', 'TOC 提取标题数正确（h1+2×h2=3）', e2 === 3, `links=${e2}`);

  // E3：点第 2 个目录项 → 页面滚动到对应标题（smooth scroll，轮询等稳定）。
  const scrollBefore = await state.session.evaluate(`window.scrollY`);
  await clickElement(state.session, '.article-toc .el-anchor__link', 1);
  let scrollInfo = null;
  const scrollStarted = Date.now();
  while (Date.now() - scrollStarted < 8000) {
    await sleep(400);
    scrollInfo = await state.session.evaluate(
      `(() => { const h = document.querySelectorAll('.article-content h1, .article-content h2, .article-content h3')[1]; const r = h ? h.getBoundingClientRect() : null; return { scrollY: window.scrollY, headingTop: r ? Math.round(r.top) : null, headingId: h ? h.id : null }; })()`
    );
    if (scrollInfo.headingTop !== null && scrollInfo.headingTop < 200) break;
  }
  check('E3', '点 TOC 项页面滚动到对应标题', scrollInfo.scrollY > (scrollBefore || 0) && scrollInfo.headingTop !== null && scrollInfo.headingTop < 200, JSON.stringify(scrollInfo));

  const e4 = await state.session.evaluate(
    `document.querySelectorAll('.article-content script, .article-content iframe, .article-content object, .article-content embed').length`
  );
  check('E4', 'XSS：正文容器内无 script/iframe/object/embed', e4 === 0, `count=${e4}`);

  const e5 = await state.session.evaluate(
    `(() => { const img = document.querySelector('.article-content img'); if (!img) return 'NO_IMG'; return { hasOnerror: img.hasAttribute('onerror'), src: img.getAttribute('src') }; })()`
  );
  check('E5', 'XSS：img 的 onerror 属性被剥掉', e5 && e5.hasOnerror === false, JSON.stringify(e5));

  const e6 = await state.session.evaluate(
    `(() => { const c = document.querySelector('.article-content'); return { strong: c.querySelectorAll('strong').length, li: c.querySelectorAll('li').length, h2: c.querySelectorAll('h2').length }; })()`
  );
  check('E6', '普通 markdown 渲染（strong/li/h2 均在）', e6 && e6.strong >= 1 && e6.li >= 2 && e6.h2 === 2, JSON.stringify(e6));

  await state.session.screenshot(path.join(CONFIG.shots, 'probe-admin-xss.png'));
}

/* ---------- 入口（finally 保证清理） ---------- */

async function run() {
  try {
    await main();
  } finally {
    // 关浏览器（先 session 再 chrome 进程）。
    try {
      state.session?.close();
    } catch {
      /* noop */
    }
    try {
      if (state.chrome) await stopChrome(state.chrome);
    } catch {
      /* noop */
    }

    // 清理 temp 账号（含它们发的文章/评论）。真实账号一个都不碰。
    const prisma = await getPrisma().catch(() => null);
    if (prisma) {
      try {
        for (const account of [state.tempA, state.tempB]) {
          if (!account) continue;
          await hardDeleteUser(prisma, account.id);
        }
        // 双保险：按前缀再扫一遍（防 finally 之前崩了没记 state）。
        const leftovers = await prisma.user.findMany({
          where: { username: { startsWith: 'pwprobe-admin-' } },
          select: { id: true },
        });
        for (const u of leftovers) {
          await hardDeleteUser(prisma, u.id);
        }
        const stillThere = await prisma.user.count({ where: { username: { startsWith: 'pwprobe-admin-' } } });
        console.log(`CLEANUP temp users left = ${stillThere}`);
      } catch (error) {
        console.log(`CLEANUP 失败（需手工处理）：${error.message}`);
      } finally {
        await prisma.$disconnect().catch(() => null);
      }
    }
  }

  summarize();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((error) => {
  console.error(`探针异常终止：${error.stack || error.message}`);
  process.exit(1);
});
