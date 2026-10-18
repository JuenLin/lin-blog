// 第 10 批「专栏系列」探针：A 系列 CRUD 与权限 / B 文章绑定三态与删除解绑 / C UI 横幅与 Tab
//
// 覆盖用户 2026-10-18 拍板的 5 个决策点里与 series 相关的三条：
//   ② 无 /me 变体，列表走 GET /users/:id/series（B9 验形状、B10 验用户不存在 404）；
//   ③ seriesId/seriesOrder 三态（B6 解绑双清、B7 未绑系列单独设序号 400）；
//   ⑤ 同系列序号冲突 409（B5）、新建未传序号自动 max+1（B1）。
//
// 与其他探针同一套规矩：
//   - 一次性 pwprobe 账号 A（系列作者）/ B（越权方），靶子文章全部自造；
//   - 清理走 cleanupProbeAccounts（顺序 …articles → series → users，tmp-account 第 10 批已加 series）；
//   - 自己起的 Chrome 自己关；前置失败 exit 2、有 FAIL 或清理失败 exit 1、全绿 exit 0；
//   - 不加管道跑（`> 文件` 再 grep），管道关闭会掐死 node 留脏数据。
//
// 用法：node scripts/acceptance/probe-series.mjs
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

const createSeries = (token, body) => api('POST', '/series', { token, body });
const getSeries = (id) => api('GET', `/series/${id}`);
const updateSeries = (id, token, body) => api('PUT', `/series/${id}`, { token, body });
const deleteSeries = (id, token) => api('DELETE', `/series/${id}`, { token });
const listUserSeries = (userId, qs = '') => api('GET', `/users/${userId}/series${qs}`);

/* ============================ Prisma（仅供清理核对） ============================ */

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

const A = { username: `pwprobe${stamp}a`, password: `probe${stamp}a`, token: null, userId: null };
const B = { username: `pwprobe${stamp}b`, password: `probe${stamp}b`, token: null, userId: null };

// 靶子系列与文章 id 统一收集，finally 里随账号一起清理。
const seriesId = { value: null };
const articleIds = [];

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

async function createArticle(token, title, extra = {}) {
  const created = await api('POST', '/articles', {
    token,
    body: {
      title,
      content: '仅供 probe-series.mjs 使用。'.repeat(5),
      category: '未分类',
      ...extra,
    },
  });

  if (!created.data || !created.data.id) {
    throw new Error(`造靶子文章失败：${created.status} ${created.message}`);
  }

  articleIds.push(created.data.id);

  return created.data;
}

/* ============================ 页面小工具（C 组） ============================ */

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

async function gotoAs(token, urlPath) {
  await session.goto(`${CONFIG.frontend}${urlPath}`);

  if (token) {
    await session.evaluate(`localStorage.setItem('token', ${JSON.stringify(token)}); 'ok'`);
  } else {
    await session.evaluate(`localStorage.removeItem('token'); 'ok'`);
  }

  await session.goto(`${CONFIG.frontend}${urlPath}`);
}

/* ============================ 主流程 ============================ */

async function main() {
  await preflight();
  ensureDirs();

  console.log('\n[前置] 注册 A / B 两个探针账号');
  await registerAndLogin(A);
  await registerAndLogin(B);
  console.log(`A id=${A.userId} / B id=${B.userId}\n`);

  /* ================= A 组：系列 CRUD 与权限 ================= */

  // A1：未登录创建 → 401。
  const a1 = await createSeries(null, { title: `未登录不该建成的系列 ${stamp}` });
  check(
    'A1',
    '未登录 POST /series → 401 / 40100',
    a1.status === 401 && a1.code === 40100,
    `HTTP ${a1.status} code=${a1.code} msg="${a1.message}"`
  );

  // A2：创建成功 → 201（或 200），articleCount=0，author 回 A。
  const a2 = await createSeries(A.token, { title: `probe 系列 ${stamp}`, description: '探针自造' });
  seriesId.value = a2.data && a2.data.id;
  check(
    'A2',
    'A 创建系列 → 201/200，articleCount=0，author.username=A',
    (a2.status === 201 || a2.status === 200) &&
      seriesId.value != null &&
      a2.data.articleCount === 0 &&
      a2.data.author &&
      a2.data.author.username === A.username,
    `HTTP ${a2.status} id=${seriesId.value} articleCount=${a2.data && a2.data.articleCount} author=${a2.data && a2.data.author ? a2.data.author.username : null}`
  );

  // A3：title 越界（空串 / 51 字）→ 400 / 40000。
  const a3a = await createSeries(A.token, { title: '' });
  const a3b = await createSeries(A.token, { title: '长'.repeat(51) });
  check(
    'A3',
    'title 空串 / 超 50 字 → 400 / 40000',
    a3a.status === 400 && a3a.code === 40000 && a3b.status === 400 && a3b.code === 40000,
    `空=${a3a.status}/${a3a.code} 长=${a3b.status}/${a3b.code}`
  );

  // A4：系列详情公开可读，空系列 articles=[]。
  const a4 = await getSeries(seriesId.value);
  check(
    'A4',
    'GET /series/:id 公开 200，articles=[]（空系列）',
    a4.status === 200 && a4.data && Array.isArray(a4.data.articles) && a4.data.articles.length === 0,
    `HTTP ${a4.status} articles=${JSON.stringify(a4.data && a4.data.articles)}`
  );

  // A5：不存在的系列 → 404 / 40400。
  const a5 = await getSeries(999999999);
  check(
    'A5',
    'GET 不存在的系列 → 404 / 40400',
    a5.status === 404 && a5.code === 40400,
    `HTTP ${a5.status} code=${a5.code} msg="${a5.message}"`
  );

  // A6：作者改 title → 200；非作者 B 改 → 403 / 40300（ADMIN 才能代管，B 不是）。
  const a6 = await updateSeries(seriesId.value, A.token, { title: `probe 系列·改名 ${stamp}` });
  const a6b = await updateSeries(seriesId.value, B.token, { title: 'B 不该改得动' });
  check(
    'A6',
    'A 改 title → 200；B（非作者非 ADMIN）→ 403 / 40300',
    a6.status === 200 && a6.data && a6.data.title === `probe 系列·改名 ${stamp}` && a6b.status === 403 && a6b.code === 40300,
    `A: ${a6.status}/${a6.data && a6.data.title}；B: ${a6b.status}/${a6b.code} msg="${a6b.message}"`
  );

  // A7：PUT / DELETE 未登录 → 401。
  const a7a = await updateSeries(seriesId.value, null, { title: '匿名改' });
  const a7b = await deleteSeries(seriesId.value, null);
  check(
    'A7',
    '未登录 PUT / DELETE 系列 → 401 / 40100',
    a7a.status === 401 && a7a.code === 40100 && a7b.status === 401 && a7b.code === 40100,
    `PUT=${a7a.status}/${a7a.code} DELETE=${a7b.status}/${a7b.code}`
  );

  // A8：B 删除 A 的系列 → 403。
  const a8 = await deleteSeries(seriesId.value, B.token);
  check(
    'A8',
    'B 删 A 的系列 → 403 / 40300',
    a8.status === 403 && a8.code === 40300,
    `HTTP ${a8.status} code=${a8.code} msg="${a8.message}"`
  );

  /* ================= B 组：文章绑定三态 / 冲突 / 删除解绑 ================= */

  // B1：三篇文章。p1 / p2 不传序号 → 自动 1、2（max+1 语义）；
  // p3 显式传 9（合法空闲值，验证显式序号通路）。
  const p1 = await createArticle(A.token, `系列靶子 p1 ${stamp}`, { seriesId: seriesId.value });
  const p2 = await createArticle(A.token, `系列靶子 p2 ${stamp}`, { seriesId: seriesId.value });
  const p3 = await createArticle(A.token, `系列靶子 p3 ${stamp}`, { seriesId: seriesId.value, seriesOrder: 9 });
  check(
    'B1',
    '新建文章绑系列：未传序号自动 1→2，显式 9 原样落',
    p1.seriesId === seriesId.value && p1.seriesOrder === 1 && p2.seriesOrder === 2 && p3.seriesOrder === 9,
    `p1 order=${p1.seriesOrder} p2 order=${p2.seriesOrder} p3 order=${p3.seriesOrder}`
  );

  // B2：文章详情透出 seriesId / seriesOrder（详情接口字段透出回归）。
  const b2 = await api('GET', `/articles/${p1.id}`);
  check(
    'B2',
    '文章详情透出 seriesId / seriesOrder',
    b2.status === 200 && b2.data && b2.data.seriesId === seriesId.value && b2.data.seriesOrder === 1,
    `HTTP ${b2.status} seriesId=${b2.data && b2.data.seriesId} seriesOrder=${b2.data && b2.data.seriesOrder}`
  );

  // B3：系列详情有序列表：PUBLISHED 升序 [p1(1), p2(2), p3(9)]，每项带 summary。
  const b3 = await getSeries(seriesId.value);
  const b3Ids = (b3.data && b3.data.articles ? b3.data.articles : []).map((a) => a.id);
  const b3HasSummary =
    b3.data && b3.data.articles && b3.data.articles.every((a) => typeof a.summary === 'string' && a.summary.length > 0);
  check(
    'B3',
    '系列详情 articles 按 seriesOrder 升序 [p1,p2,p3]，每项带非空 summary',
    b3.status === 200 &&
      b3.data.articleCount === 3 &&
      b3Ids[0] === p1.id &&
      b3Ids[1] === p2.id &&
      b3Ids[2] === p3.id &&
      b3HasSummary,
    `顺序=${JSON.stringify(b3Ids)} articleCount=${b3.data && b3.data.articleCount}`
  );

  // B4：B 的文章绑 A 的系列 → 403 / 40300（归属校验：只能加入自己的系列）。
  const b4 = await createSeries(B.token, { title: `B 的系列 ${stamp}` });
  const b4Article = await api('POST', '/articles', {
    token: B.token,
    body: { title: `B 越权靶子 ${stamp}`, content: 'B 的正文。'.repeat(5), category: '未分类', seriesId: seriesId.value },
  });
  if (b4Article.data && b4Article.data.id) articleIds.push(b4Article.data.id);
  check(
    'B4',
    "B 的文章绑 A 的系列 → 403 / 40300（404 系列不存在也拦住越权枚举）",
    b4Article.status === 403 && b4Article.code === 40300,
    `HTTP ${b4Article.status} code=${b4Article.code} msg="${b4Article.message}"`
  );

  // B5：显式序号冲突 → 409 / 40900（用户拍板：必须让用户明确选择，不自动重排）。
  const b5 = await api('POST', '/articles', {
    token: A.token,
    body: { title: `序号冲突靶子 ${stamp}`, content: '正文。'.repeat(5), category: '未分类', seriesId: seriesId.value, seriesOrder: 1 },
  });
  if (b5.data && b5.data.id) articleIds.push(b5.data.id);
  check(
    'B5',
    '新建文章显式传已占用的序号 1 → 409 / 40900',
    b5.status === 409 && b5.code === 40900,
    `HTTP ${b5.status} code=${b5.code} msg="${b5.message}"`
  );

  // B6：解绑双清 —— PUT seriesId=null 后 seriesOrder 必须同时回 NULL（不留孤儿序号）。
  const b6 = await api('PUT', `/articles/${p2.id}`, {
    token: A.token,
    body: { title: `系列靶子 p2 ${stamp}`, content: '仅供 probe-series.mjs 使用。'.repeat(5), category: '未分类', seriesId: null },
  });
  check(
    'B6',
    'PUT seriesId=null 解绑 → seriesId 与 seriesOrder 同时 null（双清）',
    b6.status === 200 && b6.data && b6.data.seriesId === null && b6.data.seriesOrder === null,
    `HTTP ${b6.status} seriesId=${b6.data && b6.data.seriesId} seriesOrder=${b6.data && b6.data.seriesOrder}`
  );

  // B7：未绑定系列的文章单独设序号 → 400 / 40000。
  const b7 = await api('PUT', `/articles/${p2.id}`, {
    token: A.token,
    body: { title: `系列靶子 p2 ${stamp}`, content: '仅供 probe-series.mjs 使用。'.repeat(5), category: '未分类', seriesOrder: 3 },
  });
  check(
    'B7',
    '未绑系列的文章单独设 seriesOrder → 400 / 40000',
    b7.status === 400 && b7.code === 40000,
    `HTTP ${b7.status} code=${b7.code} msg="${b7.message}"`
  );

  /* ================= C 组：UI 系列横幅 + 个人主页系列 Tab ================= */

  if (!(await cdpAlive())) {
    chromeChild = (await launchChrome()).child;
    await sleep(1500);
  }

  session = await attach();
  await session.send('Network.enable');

  // C1：详情页系列横幅 —— p1 是 order=1，横幅应显示「第 1 篇 / 共 3 篇」与系列标题
  //（B6 解绑的是 p2，系列里还有 p1 / p3 两篇已发布 → 共 2 篇。重新核对：p2 已解绑，
  // articleCount 只数 PUBLISHED 未软删 → 2。改断言为动态值：共 2 篇，p1 第 1 篇。）
  await gotoAs(A.token, `/article/${p1.id}`);
  const c1Ready = await waitFor(`Boolean(document.querySelector('[data-testid="series-banner"]'))`, 10000);
  await sleep(600);
  const c1Text = c1Ready ? await session.evaluate(`document.querySelector('[data-testid="series-banner"]').textContent`) : '';
  check(
    'C1',
    '详情页系列横幅渲染：含系列标题与「第 1 篇 / 共 2 篇」',
    c1Ready &&
      c1Text.includes('probe 系列·改名') &&
      c1Text.includes('第 1 篇') &&
      c1Text.includes('共 2 篇'),
    `banner="${(c1Text || '').trim().slice(0, 80)}"`
  );

  // C2：系列内「下一篇」→ 跳到 seriesOrder 更晚的 p3（升序下标 +1），横幅更新为第 2 篇。
  // 客户端路由跳转（router-link / span click），同组件复用，watch route.params.id 触发 load。
  const c2Before = await session.evaluate(`location.pathname`);
  await session.evaluate(`(() => {
    const links = Array.from(document.querySelectorAll('.series-banner-link'));
    const next = links.find((el) => el.textContent.includes('下一篇'));
    if (next) next.click();
    return links.length;
  })()`);
  const c2OnP3 = await waitFor(`location.pathname === '/article/${p3.id}'`, 8000);
  await sleep(800);
  const c2Text = await session.evaluate(
    `(() => { const el = document.querySelector('[data-testid="series-banner"]'); return el ? el.textContent : ''; })()`
  );
  check(
    'C2',
    '系列内「下一篇」跳到 p3，横幅更新为「第 2 篇」',
    c2OnP3 && c2Text.includes('第 2 篇'),
    `path ${c2Before} → ${await session.evaluate('location.pathname')}，banner 含第2篇=${c2Text.includes('第 2 篇')}`
  );

  // C3：个人主页「系列」Tab —— 公开 Tab（不对 isOwner 设限），行渲染标题与篇数。
  await gotoAs(A.token, `/user/${A.userId}`);
  const c3TabReady = await waitFor(
    `Array.from(document.querySelectorAll('.el-tabs__item')).some((e) => e.textContent.trim() === '系列')`,
    8000
  );
  await session.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((e) => e.textContent.trim() === '系列');
    if (tab) tab.click();
    return 'ok';
  })()`);
  const c3RowReady = await waitFor(`document.querySelectorAll('.series-row').length > 0`, 10000);
  await sleep(800);
  const c3Rows = await session.evaluate(`(() => {
    return JSON.stringify(Array.from(document.querySelectorAll('.series-row')).map((el) => ({
      title: el.querySelector('.series-row-title') ? el.querySelector('.series-row-title').textContent : '',
      count: el.querySelector('.series-row-count') ? el.querySelector('.series-row-count').textContent : '',
    })));
  })()`);
  const c3Parsed = JSON.parse(c3Rows || '[]');
  check(
    'C3',
    '个人主页系列 Tab：A 的系列在列（标题匹配，篇数 chip = 2 篇）',
    c3TabReady && c3RowReady && c3Parsed.length >= 1 && c3Parsed.some((r) => r.title.includes('probe 系列·改名') && r.count.includes('2')),
    `rows=${JSON.stringify(c3Parsed).slice(0, 120)}`
  );

  /* ---------- B 组收尾：删除系列 → SET NULL 解绑（回 API 层） ---------- */

  // B8：A 删自己的系列 → unboundCount=2（p1 / p3 还绑着），文章不删、seriesId 回 null，
  // 系列行物理删（GET 404）。
  const b8 = await deleteSeries(seriesId.value, A.token);
  const b8p1 = await api('GET', `/articles/${p1.id}`);
  const b8gone = await getSeries(seriesId.value);
  check(
    'B8',
    'DELETE 系列 → unboundCount=2；文章存活且 seriesId=null；系列行物理删（GET 404）',
    b8.status === 200 && b8.data && b8.data.unboundCount === 2 && b8p1.status === 200 &&
      b8p1.data.seriesId === null && b8p1.data.seriesOrder === null && b8gone.status === 404,
    `DELETE=${b8.status} unbound=${b8.data && b8.data.unboundCount} p1=${b8p1.status}/seriesId=${b8p1.data && b8p1.data.seriesId} GET=${b8gone.status}`
  );

  // B9：GET /users/:id/series 列表形状（无 author 键，articleCount 显式 0——B 的空系列）。
  const b9 = await listUserSeries(B.userId);
  const b9row = b9.data && b9.data.list && b9.data.list[0];
  check(
    'B9',
    'GET /users/:id/series → 200，list 项带 title/description/articleCount=0 且无 author 键',
    b9.status === 200 && b9.data && b9.data.total === 1 && b9row &&
      typeof b9row.articleCount === 'number' && b9row.articleCount === 0 &&
      !('author' in b9row) && typeof b9row.title === 'string',
    `HTTP ${b9.status} total=${b9.data && b9.data.total} row=${JSON.stringify(b9row || null).slice(0, 140)}`
  );

  // B10：用户不存在 → 404 / 40400（requireUserExists）。
  const b10 = await listUserSeries(999999999);
  check(
    'B10',
    'GET /users/999999999/series → 404 / 40400',
    b10.status === 404 && b10.code === 40400,
    `HTTP ${b10.status} code=${b10.code} msg="${b10.message}"`
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

  // 清理：走 tmp-account 统一通道（… → articles → series → users，第 10 批已加 series）。
  // A 名下的靶子文章 / 系列、B 名下的越权系列全部随账号清掉；只删 pwprobe 前缀账号。
  try {
    const users = await cleanupProbeAccounts([A.username, B.username]);
    console.log(`\n清理：删除探针账号 ${users} 个（含其自造文章、系列与全部绑定关系）`);
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }

  const prisma = await getPrisma().catch(() => null);
  if (prisma) {
    try {
      const leftoverSeries = await prisma.series.count({
        where: { title: { contains: 'probe 系列' } },
      });
      const leftoverArticles = await prisma.article.count({
        where: { title: { contains: '系列靶子' } },
      });
      console.log(`残留自查：probe 系列 ${leftoverSeries} 行 / 系列靶子文章 ${leftoverArticles} 篇（期望都为 0）`);
    } finally {
      await prisma.$disconnect();
    }
  }
}

process.exit(exitCode);
