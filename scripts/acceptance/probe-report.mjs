// 第 12 批「举报与审核」探针：A 提交语义 / B 管理端列表 / C 处理事务与通知 / D UI 举报入口
//
// 与其他探针的分工：
//   • 管理端既有删文章 / 删评论接口在 run.mjs 的 admin 组覆盖；
//   • 本文件专测举报链路：防重复 409 / 不能举报自己 400 / 不可见目标 404 /
//     越权 403 / **单事务联动软删**（含评论级联子评论）/ PENDING 批转 RESOLVED /
//     REPORT_RESOLVED / REPORT_REJECTED 通知落库（docs/API.md「举报与审核（第 12 批）」）。
//
// 关键断言（用户拍板防坑，全钉死）：
//   • 软删 / 草稿目标不可再被举报（404）；
//   • 处理是**后端单事务**：RESOLVED+deleteTarget 联动软删 + 该目标全部 PENDING 批转
//     RESOLVED（resolvedCount 断言），前端/admin 不自己拼删除接口；
//   • 目标已被作者先行软删 → 幂等流转 targetDeleted=false，不报错卡住管理员；
//   • 通知按举报行落库（两人举报同一目标各收一条），REJECTED 走 REPORT_REJECTED。
//
// 与其他 Chrome 探针同一套规矩：
//   - 一次性 pwprobe 账号（A 作者 / B·C 举报人+UI 演员），不碰真实用户数据；
//   - 靶子文章与评论全部自造，跑完按 id 精确回收（tmp-account 硬删序第 12 批已补 reports）；
//   - 管理员 token 本地 mint（CONFIG.adminId，与 probe-admin 同款，不需要密码）；
//   - 自己起的 Chrome 自己关；
//   - 前置失败 exit 2、有 FAIL 或清理失败 exit 1、全绿 exit 0。
//
// ⚠️ 铁律（踩过两次）：
//   1) 验语法绝不能用 import() —— 会真的把探针跑一遍留下脏数据。语法交给 vite build。
//   2) 别用 `| head -N` / `| grep` 截断本脚本输出 —— 管道关闭会掐死 node，
//      finally 不跑，会留下 pwprobe 账号。一律 `> 文件` 再 grep 那个文件。
//
// 用法：node scripts/acceptance/probe-report.mjs
import path from 'node:path';
import { CONFIG, sleep, requireCjs, BACKEND, BACKEND_MODULES, ensureDirs } from './lib/config.mjs';
import { cleanupProbeAccounts } from './lib/tmp-account.mjs';
import { mintToken } from './lib/session.mjs';
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

const createReportApi = (body, token) => api('POST', '/reports', { token, body });
const listReportsApi = (query, token) => api('GET', `/admin/reports${query}`, { token });
const resolveReportApi = (id, body, token) => api('PUT', `/admin/reports/${id}`, { token, body });

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

/* ============================ 造数 ============================ */

const stamp = Date.now();

// A：内容作者（被举报方）；B：举报人 1 + UI 演员；C：举报人 2。
const A = { username: `pwprobe${stamp}a`, password: `probe${stamp}a`, token: null, userId: null };
const B = { username: `pwprobe${stamp}b`, password: `probe${stamp}b`, token: null, userId: null };
const C = { username: `pwprobe${stamp}c`, password: `probe${stamp}c`, token: null, userId: null };
// mintToken 返回 { token, file, secretLen } 对象——解构取 token（整个对象塞 Bearer 头会 401）。
const ADMIN = { token: mintToken(CONFIG.adminId, 'admin').token, userId: CONFIG.adminId };

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

async function createArticle(token, title, status) {
  const created = await api('POST', '/articles', {
    token,
    body: {
      title,
      summary: '探针自造靶子文章，跑完即物理删除',
      content: '仅供 probe-report.mjs 使用。'.repeat(5),
      category: '未分类',
      ...(status ? { status } : {}),
    },
  });

  if (!created.data || !created.data.id) {
    throw new Error(`造靶子文章失败：${created.status} ${created.message}`);
  }

  return created.data.id;
}

async function createComment(token, articleId, content) {
  const created = await api('POST', '/comments', {
    token,
    body: { articleId, content },
  });

  if (!created.data || !created.data.id) {
    throw new Error(`造评论失败（article=${articleId}）：${created.status} ${created.message}`);
  }

  return created.data.id;
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

/** 注入登录态并整页重进（token 是 AppHeader / 详情页初始化的入口，SPA 跳转不重走）。 */
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

  console.log('\n[前置] 注册 A / B / C 三个探针账号');
  await registerAndLogin(A);
  await registerAndLogin(B);
  await registerAndLogin(C);
  console.log(`A id=${A.userId} / B id=${B.userId} / C id=${C.userId}`);

  /* ---------- 造靶子 ---------- */

  // artMain：主靶子（B、C 两人举报）；artDraft：草稿 404 靶子；artSelfDel：作者自删 404 靶子；
  // artRejected：REJECTED 不动目标靶子；artIdem：先删后处理幂等靶子。
  const artMain = await createArticle(A.token, `举报靶子 main ${stamp}`);
  const artDraft = await createArticle(A.token, `举报靶子 draft ${stamp}`, 'DRAFT');
  const artSelfDel = await createArticle(A.token, `举报靶子 selfdel ${stamp}`);
  const artRejected = await createArticle(A.token, `举报靶子 rejected ${stamp}`);
  const artIdem = await createArticle(A.token, `举报靶子 idem ${stamp}`);
  // cRejected：挂在 artRejected 上的评论（D3 UI 评论举报靶子——artMain 的评论在
  // C3 会被联动软删，artRejected 走 REJECTED 目标不动，评论活到 D 组）。
  const cRejected = await createComment(A.token, artRejected, `REJECTED 靶子上的评论 ${stamp}`);
  // cMain：评论靶子（C3 级联软删验证）；cChild：cMain 的**子评论**（必须带 parentId，
  // 级联只覆盖 parentId 直接指向被删评论的子树）；cDel：软删评论 404 靶子。
  const cMain = await createComment(A.token, artMain, `被举报靶子评论 ${stamp}`);
  const cChildRes = await api('POST', '/comments', {
    token: A.token,
    body: { articleId: artMain, parentId: cMain, content: `子评论靶子（挂在被举报评论下） ${stamp}` },
  });
  if (!cChildRes.data || !cChildRes.data.id) {
    throw new Error(`造子评论失败：${cChildRes.status} ${cChildRes.message}`);
  }
  const cChild = cChildRes.data.id;
  const cDel = await createComment(A.token, artMain, `待软删评论 ${stamp}`);

  console.log(`靶子：artMain=${artMain} artDraft=${artDraft} artSelfDel=${artSelfDel} artRejected=${artRejected} artIdem=${artIdem} cMain=${cMain} cChild=${cChild} cDel=${cDel} cRejected=${cRejected}\n`);

  /* ================= A 组：提交语义 ================= */

  const a1 = await createReportApi({ targetType: 'ARTICLE', targetId: artMain, reason: '抄袭嫌疑' }, B.token);
  check(
    'A1',
    'B 举报 A 的文章 → 201，status=PENDING',
    a1.status === 201 && a1.code === 0 && a1.data && a1.data.status === 'PENDING' && a1.data.targetType === 'ARTICLE',
    `HTTP ${a1.status} code=${a1.code} ${JSON.stringify(a1.data)}`
  );
  const repBArtMain = a1.data.id;

  const a2 = await createReportApi({ targetType: 'ARTICLE', targetId: artMain }, C.token);
  check(
    'A2',
    'C 举报同一文章 → 201（不同举报人放行，唯一约束只拦同人同对象）',
    a2.status === 201 && a2.code === 0,
    `HTTP ${a2.status} code=${a2.code}`
  );

  const a3 = await createReportApi({ targetType: 'ARTICLE', targetId: artMain, reason: '再报一次' }, B.token);
  check(
    'A3',
    'B 重复举报同一文章 → 409 / 40900（防坑 3：不新增行不重置状态）',
    a3.status === 409 && a3.code === 40900,
    `HTTP ${a3.status} code=${a3.code} msg="${a3.message}"`
  );

  const a4self = await createReportApi({ targetType: 'ARTICLE', targetId: artMain }, A.token);
  const a4badtype = await createReportApi({ targetType: 'WALL', targetId: artMain }, B.token);
  check(
    'A4',
    'A 举报自己的文章 → 400；非法 targetType → 400',
    a4self.status === 400 && a4self.code === 40000 && a4badtype.status === 400 && a4badtype.code === 40000,
    `self=${a4self.status}/${a4self.code} type=${a4badtype.status}/${a4badtype.code}`
  );

  const a5anon = await createReportApi({ targetType: 'ARTICLE', targetId: artMain }, null);
  const a5draft = await createReportApi({ targetType: 'ARTICLE', targetId: artDraft }, B.token);
  check(
    'A5',
    '未登录举报 → 401；举报草稿 → 404（status=PUBLISHED 口径，草稿对外不可见）',
    a5anon.status === 401 && a5anon.code === 40100 && a5draft.status === 404 && a5draft.code === 40400,
    `anon=${a5anon.status}/${a5anon.code} draft=${a5draft.status}/${a5draft.code}`
  );

  // 防坑 1：作者已自行软删的内容不能再被举报（文章 + 评论两条路径各钉一遍）。
  const delArt = await api('DELETE', `/articles/${artSelfDel}`, { token: A.token });
  const a6art = await createReportApi({ targetType: 'ARTICLE', targetId: artSelfDel }, B.token);
  const delCom = await api('DELETE', `/comments/${cDel}`, { token: A.token });
  const a6com = await createReportApi({ targetType: 'COMMENT', targetId: cDel }, B.token);
  check(
    'A6',
    '举报已自删文章 → 404；举报已软删评论 → 404（不可见口径）',
    delArt.status === 200 && a6art.status === 404 && a6art.code === 40400 &&
      delCom.status === 200 && a6com.status === 404 && a6com.code === 40400,
    `删文章=${delArt.status} 举报=${a6art.status}/${a6art.code} 删评论=${delCom.status} 举报=${a6com.status}/${a6com.code}`
  );

  const a7 = await createReportApi({ targetType: 'COMMENT', targetId: cMain, reason: '人身攻击' }, B.token);
  check(
    'A7',
    'B 举报 A 的评论 → 201（评论目标走通，供 C3 级联验证）',
    a7.status === 201 && a7.data && a7.data.targetType === 'COMMENT',
    `HTTP ${a7.status} ${JSON.stringify(a7.data)}`
  );
  const repBComMain = a7.data.id;

  /* ================= B 组：管理端列表 ================= */

  const b1 = await listReportsApi('?status=PENDING', B.token);
  check(
    'B1',
    '非 ADMIN 查举报列表 → 403 / 40300',
    b1.status === 403 && b1.code === 40300,
    `HTTP ${b1.status} code=${b1.code}`
  );

  const b2 = await listReportsApi('?status=PENDING&page=1&pageSize=50', ADMIN.token);
  const b2rows = (b2.data && b2.data.list) || [];
  const b2art = b2rows.find((r) => r.id === repBArtMain) || null;
  const b2com = b2rows.find((r) => r.id === repBComMain) || null;
  check(
    'B2',
    'ADMIN 列表 status=PENDING 筛选命中；preview 形状（文章=标题 / 评论=内容，deleted=false，reporter 正确）',
    b2.code === 0 &&
      b2art && b2art.targetPreview.title && b2art.targetPreview.deleted === false && b2art.reporter.id === B.userId &&
      b2com && b2com.targetPreview.title && b2com.targetPreview.deleted === false && b2com.reporter.id === B.userId &&
      b2rows.every((r) => r.status === 'PENDING'),
    `PENDING 总数=${b2rows.length} art preview=${JSON.stringify(b2art && b2art.targetPreview)} com preview=${JSON.stringify(b2com && b2com.targetPreview)}`
  );

  /* ================= C 组：处理事务 + 通知 ================= */

  // C5（先跑，不消耗状态）：REJECTED + deleteTarget 组合 → 400。
  const c5 = await resolveReportApi(repBArtMain, { status: 'REJECTED', deleteTarget: true }, ADMIN.token);
  check(
    'C5',
    'REJECTED + deleteTarget 组合 → 400（未违规不能删内容）',
    c5.status === 400 && c5.code === 40000,
    `HTTP ${c5.status} code=${c5.code}`
  );

  // C1（核心）：RESOLVED + deleteTarget → 单事务联动软删 + 该目标全部 PENDING 批转
  // RESOLVED（B + C 两人 → resolvedCount=2），文章详情随之 404。
  const c1 = await resolveReportApi(repBArtMain, { status: 'RESOLVED', deleteTarget: true }, ADMIN.token);
  const c1art = await api('GET', `/articles/${artMain}`);
  check(
    'C1',
    'RESOLVED+deleteTarget → resolvedCount=2 targetDeleted=true，文章详情 404',
    c1.code === 0 && c1.data && c1.data.resolvedCount === 2 && c1.data.targetDeleted === true && c1art.status === 404,
    `HTTP ${c1.status} ${JSON.stringify(c1.data)} 详情=${c1art.status}`
  );

  // C2：B、C 各收到一条 REPORT_RESOLVED（按举报行落库，两人举报同一目标各一条）。
  await sleep(400); // 通知写库在事务提交后 await，留一点余量
  const bNotifs = await api('GET', '/notifications?page=1&pageSize=50', { token: B.token });
  const cNotifs = await api('GET', '/notifications?page=1&pageSize=50', { token: C.token });
  const bRes = ((bNotifs.data && bNotifs.data.list) || []).filter((n) => n.type === 'REPORT_RESOLVED' && n.articleId === artMain);
  const cRes = ((cNotifs.data && cNotifs.data.list) || []).filter((n) => n.type === 'REPORT_RESOLVED' && n.articleId === artMain);
  check(
    'C2',
    'B / C 各收到 REPORT_RESOLVED（articleId 挂目标文章）',
    bRes.length === 1 && cRes.length === 1,
    `B=${bRes.length} C=${cRes.length}`
  );

  // C3：评论 RESOLVED + deleteTarget → 评论 + 子评论级联软删（Prisma 直查 deletedAt），
  // 通知 articleId 挂所属文章（通知锚点只有 articleId，设计如此）。
  const c3 = await resolveReportApi(repBComMain, { status: 'RESOLVED', deleteTarget: true }, ADMIN.token);
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));
  const prisma = new PrismaClient();
  let c3ok = false;
  let c3detail = '';
  let bComNotif = null;
  try {
    const comRow = await prisma.comment.findUnique({ where: { id: cMain }, select: { deletedAt: true } });
    const childRow = await prisma.comment.findUnique({ where: { id: cChild }, select: { deletedAt: true } });
    c3ok = c3.code === 0 && c3.data.targetDeleted === true && comRow && comRow.deletedAt !== null && childRow && childRow.deletedAt !== null;
    c3detail = `HTTP ${c3.status} ${JSON.stringify(c3.data)} comDel=${Boolean(comRow && comRow.deletedAt)} childDel=${Boolean(childRow && childRow.deletedAt)}`;

    const bList2 = ((await api('GET', '/notifications?page=1&pageSize=50', { token: B.token })).data.list) || [];
    bComNotif = bList2.find((n) => n.type === 'REPORT_RESOLVED' && n.articleId === artMain && n.id !== (bRes[0] && bRes[0].id));
  } finally {
    await prisma.$disconnect();
  }
  check(
    'C3',
    '评论 RESOLVED+deleteTarget → 评论+子评论级联软删；通知 articleId 挂所属文章',
    c3ok && bComNotif,
    `${c3detail} 第二条通知=${Boolean(bComNotif)}`
  );

  // C4：REJECTED → 只改当前一条，目标内容不受影响；举报人收到 REPORT_REJECTED。
  const repCArtRejected = (await createReportApi({ targetType: 'ARTICLE', targetId: artRejected }, C.token)).data.id;
  const c4 = await resolveReportApi(repCArtRejected, { status: 'REJECTED' }, ADMIN.token);
  const c4art = await api('GET', `/articles/${artRejected}`);
  const cNotifs2 = await api('GET', '/notifications?page=1&pageSize=50', { token: C.token });
  const cRej = ((cNotifs2.data && cNotifs2.data.list) || []).filter((n) => n.type === 'REPORT_REJECTED' && n.articleId === artRejected);
  check(
    'C4',
    'REJECTED → resolvedCount=1、目标详情仍 200；C 收到 REPORT_REJECTED',
    c4.code === 0 && c4.data.resolvedCount === 1 && c4art.status === 200 && cRej.length === 1,
    `${JSON.stringify(c4.data)} 详情=${c4art.status} REJECTED 通知=${cRej.length}`
  );

  // C6（拍板 3）：目标已被作者先行软删 → 幂等流转 targetDeleted=false，不报错卡管理员。
  const repBArtIdem = (await createReportApi({ targetType: 'ARTICLE', targetId: artIdem }, B.token)).data.id;
  await api('DELETE', `/articles/${artIdem}`, { token: A.token });
  const c6 = await resolveReportApi(repBArtIdem, { status: 'RESOLVED', deleteTarget: true }, ADMIN.token);
  check(
    'C6',
    '目标已先行软删 → 200，targetDeleted=false，resolvedCount=1（幂等流转）',
    c6.code === 0 && c6.data.targetDeleted === false && c6.data.resolvedCount === 1,
    `HTTP ${c6.status} ${JSON.stringify(c6.data)}`
  );

  /* ================= D 组：UI 举报入口 ================= */

  if (!(await cdpAlive())) {
    chromeChild = (await launchChrome()).child;
    await sleep(1500);
  }

  session = await attach();
  await session.send('Network.enable');

  // D1：B（登录、非作者）进 artRejected 详情页 → 举报按钮可见；
  //     A（作者）进同一页 → 举报按钮不可见（作者删自己的内容走删除，不走举报）。
  await gotoAs(B.token, `/article/${artRejected}`);
  const d1bBtn = await waitFor(`document.querySelector('[data-testid="article-report-btn"]')`);
  await gotoAs(A.token, `/article/${artRejected}`);
  const d1aBtn = await waitFor(`document.querySelector('[data-testid="article-report-btn"]')`);
  check(
    'D1',
    '举报按钮：登录非作者可见，作者本人不可见',
    d1bBtn && !d1aBtn,
    `B 可见=${d1bBtn} A 可见=${d1aBtn}`
  );

  // D2：B 打开 dialog 填理由提交 → 成功提示「已收到举报，我们会尽快处理」。
  await gotoAs(B.token, `/article/${artRejected}`);
  await waitFor(`document.querySelector('[data-testid="article-report-btn"]')`);
  await session.evaluate(`document.querySelector('[data-testid="article-report-btn"]').click(); 'ok'`);
  const d2dialog = await waitFor(`document.querySelector('[data-testid="article-report-reason"]')`, 6000);
  await session.evaluate(
    `(() => {
      const ta = document.querySelector('[data-testid="article-report-reason"]');
      ta.value = 'UI 探针提交的举报理由';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })()`
  );
  await session.evaluate(`document.querySelector('[data-testid="article-report-submit"]').click(); 'ok'`);
  const d2toast = await waitFor(
    `document.body.textContent.includes('已收到举报，我们会尽快处理')`,
    8000
  );
  check(
    'D2',
    'UI 提交文章举报 → 成功提示出现',
    d2dialog && d2toast,
    `dialog=${d2dialog} toast=${d2toast}`
  );

  // D3：评论行举报按钮（登录 + 非评论作者）→ 打开 dialog 提交 → 成功提示。
  await gotoAs(B.token, `/article/${artRejected}`);
  await waitFor(`document.querySelectorAll('[data-testid="comment-report"]').length > 0`);
  await session.evaluate(`document.querySelector('[data-testid="comment-report"]').click(); 'ok'`);
  const d3dialog = await waitFor(`document.querySelector('[data-testid="comment-report-reason"]')`, 6000);
  await session.evaluate(`document.querySelector('[data-testid="comment-report-submit"]').click(); 'ok'`);
  const d3toast = await waitFor(
    `document.body.textContent.includes('已收到举报，我们会尽快处理')`,
    8000
  );
  check(
    'D3',
    'UI 提交评论举报（无理由，选填口径）→ 成功提示出现',
    d3dialog && d3toast,
    `dialog=${d3dialog} toast=${d3toast}`
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

  // 清理：走 tmp-account 统一通道（其硬删序第 12 批已补 reports：
  // notifications → bookmarks → likes → follows → comment_likes → reports → comments → articles → series → users）。
  // B / C 举报过 A 的靶子（reporterId 侧）+ 靶子全是自造的（targetId 侧），双侧都覆盖。
  try {
    const users = await cleanupProbeAccounts([A.username, B.username, C.username]);
    console.log(`\n清理：删除探针账号 ${users} 个（含其自造文章 / 评论 / 举报 / 通知）`);
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
