// 第三批「评论删除」独立探针：A 组纯 API（A1-A9）+ B 组 Chrome 交互（B1-B4）+ A10（软删文章）。
// 共 14 条断言，覆盖评论删除的全部权限分支、负向边界、UI 二次确认与空态。
//
// ⚠️⚠️⚠️ 执行顺序（写死，任何人改这文件前先读这段，别乱动）
//    A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8 → A9  →  [启动 Chrome]  →  B1 → B2 → B3 → B4  →  A10
// 理由（顺序错了会踩坑）：
//    - A1-A9 是接口层断言，纯 HTTP，不依赖浏览器，先全跑完；
//    - B1-B4 是 UI 交互，必须跑在「artB 还没被软删」的窗口里——A10 会软删 artB，
//      软删后 /articles/:id 与 /articles/:id/comments 都 404，B 组进页面会拿不到评论、全挂；
//    - 所以 A10（虽然是 A 组编号、逻辑上属接口层）时序上必须排在 B 组之后。
//    - 之所以 A10 仍叫 A 组：它是接口断言，只是"晚点跑"，不是 B 组的 UI 部分。
//
// fixture：3 个全新 pwprobe 账号（A=评论作者 / B=文章作者 / C=第三人）+ 1 篇 artB（B 建）+ 4 条评论
//    c1=A 的评论，c2=A 的评论，c3=B 的评论，c4=C 的评论
// 清理顺序（外键 RESTRICT，反序会被 1452 拦）：comments → articles → users
//    （本项目评论没有 like 子表，故跳过 likes 步骤；通用顺序见 probe-like.mjs：likes→articles→users）
//    不碰 run.mjs / cleanupFixtures / MARKERS（独立探针，自成闭环）。
//
// 用法：node scripts/acceptance/probe-comment-delete.mjs
import path from 'node:path';
import { CONFIG, sleep, requireCjs, BACKEND, BACKEND_MODULES } from './lib/config.mjs';
import { cleanupProbeAccounts, PROBE_PREFIX } from './lib/tmp-account.mjs';
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

  return {
    status: res.status,
    code: json && json.code,
    message: json && json.message,
    data: json && json.data,
  };
}

const register = (body) => api('POST', '/auth/register', { body });
const login = (body) => api('POST', '/auth/login', { body });
const createArticle = (token, body) => api('POST', '/articles', { token, body });
const createComment = (token, body) => api('POST', '/comments', { token, body });
const deleteComment = (id, token) => api('DELETE', `/comments/${id}`, { token });
const deleteArticle = (id, token) => api('DELETE', `/articles/${id}`, { token });
const listComments = (articleId, token) =>
  api('GET', `/articles/${articleId}/comments?page=1&pageSize=10&sortBy=createdAt&order=desc`, { token });

/* ============================ Prisma（仅供清理） ============================ */

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

  const front = await fetch(CONFIG.frontend).then((r) => r.status).catch(() => 0);
  if (front !== 200) {
    console.error(`前端不可用（${CONFIG.frontend} → ${front}），先起前端再跑探针（必须是 5173）`);
    process.exit(2);
  }
}

/* ============================ 小工具 ============================ */

// 把字符串变成 JS 字符串字面量，安全嵌进 evaluate 表达式。
const lit = (s) => JSON.stringify(s);

/* ============================ 主流程 ============================ */

const MARK = {
  c1: 'cdel-c1-A-comment',
  c2: 'cdel-c2-A-comment',
  c3: 'cdel-c3-B-comment',
  c4: 'cdel-c4-C-comment',
};

const state = {
  A: { token: null, userId: null, username: null },
  B: { token: null, userId: null, username: null },
  C: { token: null, userId: null, username: null },
  artB: null,
  comments: {},
};

async function makeAccount(role) {
  const username = `${PROBE_PREFIX}-cdel-${role}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const password = 'Cd3l!2026xK9';
  const r = await register({ username, password, nickname: `评论删除探针-${role}` });
  if (r.status !== 201) {
    throw new Error(`注册 ${role} 失败：HTTP ${r.status} ${r.message}`);
  }
  const l = await login({ username, password });
  if (l.status !== 200 || !l.data || !l.data.token || !l.data.user) {
    throw new Error(`登录 ${role} 失败：HTTP ${l.status} ${l.message}`);
  }
  return { token: l.data.token, userId: l.data.user.id, username };
}

async function main() {
  await preflight();

  /* ---------- 造 3 个账号 + 1 篇文章 + 4 条评论 ---------- */

  state.A = await makeAccount('A');
  state.B = await makeAccount('B');
  state.C = await makeAccount('C');
  console.log(
    `\n账号：A=${state.A.username}(id ${state.A.userId})  B=${state.B.username}(id ${state.B.userId})  C=${state.C.username}(id ${state.C.userId})`
  );

  const art = await createArticle(state.B.token, {
    title: '评论删除探针靶子文章',
    content: '仅供 probe-comment-delete.mjs 使用，跑完即物理删除。'.repeat(4),
  });
  if (art.status !== 201 || !art.data) {
    throw new Error(`造 artB 失败：HTTP ${art.status} ${art.message}`);
  }
  state.artB = art.data.id;
  console.log(`靶子文章：artB id=${state.artB}\n`);

  // c1/c2 由 A 发，c3 由 B 发，c4 由 C 发。注意：mk 必须用「传入的 token」，
  // 评论作者取 token 里的 userId—— 写错 token 会导致权限断言整组错位（已踩过一次）。
  const mk = async (marker, token) => {
    const r = await createComment(token, { articleId: state.artB, content: marker });
    if (r.status !== 201 || !r.data) throw new Error(`造评论 ${marker} 失败：HTTP ${r.status} ${r.message}`);
    return r.data.id;
  };
  state.comments.c1 = await mk(MARK.c1, state.A.token);
  state.comments.c2 = await mk(MARK.c2, state.A.token);
  state.comments.c3 = await mk(MARK.c3, state.B.token);
  state.comments.c4 = await mk(MARK.c4, state.C.token);
  console.log(`评论：c1=${state.comments.c1} c2=${state.comments.c2} c3=${state.comments.c3} c4=${state.comments.c4}\n`);

  /* ============================================================
   * A 组（纯 API，A1-A9）。顺序见文件顶部注释。
   * ============================================================ */

  // A1：基准列表——请求成功 + 集合非空（负向断言的前置），total=4，c1 在列。
  const base = await listComments(state.artB, state.C.token);
  const baseOk = base.status === 200 && base.data && Array.isArray(base.data.list);
  const baseIds = baseOk ? base.data.list.map((c) => c.id) : [];
  const listHas = (id) => baseIds.includes(id);
  check(
    'A1',
    '基准列表：GET /articles/:id/comments → 200，total=4，c1 在列',
    baseOk && base.data.total === 4 && base.data.list.length === 4 && listHas(state.comments.c1),
    `HTTP ${base.status} total=${baseOk ? base.data.total : '?'} 列表 ${baseOk ? base.data.list.length : '?'} 条，含 c1? ${listHas(state.comments.c1)}`
  );

  // A2：未登录删除 → 401。
  const a2 = await deleteComment(state.comments.c1, null);
  check(
    'A2',
    '未登录删除评论 → 401 / 40100',
    a2.status === 401 && a2.code === 40100,
    `HTTP ${a2.status} code=${a2.code} msg="${a2.message}"`
  );

  // A3：路径参数非法（非数字 id）→ 400。
  const a3 = await api('DELETE', `/comments/abc`, { token: state.B.token });
  check(
    'A3',
    '非法 id（非数字）删除 → 400 / 40000',
    a3.status === 400 && a3.code === 40000,
    `HTTP ${a3.status} code=${a3.code} msg="${a3.message}"`
  );

  // A4：第三人 C 删 A 的评论 c1 → 403；**补**：再查列表确认 c1 真的没被删（403 只说明拒绝得对，
  //     不说明没动数据——防止"悄悄删了却返回 403"的假绿）。
  const a4 = await deleteComment(state.comments.c1, state.C.token);
  const after403 = await listComments(state.artB, state.C.token);
  const stillThere =
    after403.status === 200 &&
    after403.data &&
    after403.data.total === 4 &&
    Array.isArray(after403.data.list) &&
    after403.data.list.some((c) => c.id === state.comments.c1);
  check(
    'A4',
    '第三人删他人评论 → 403，且 c1 仍存活（total 仍=4、c1 仍在列表）',
    a4.status === 403 && a4.code === 40300 && stillThere,
    `删 HTTP ${a4.status} code=${a4.code}；复查 HTTP ${after403.status} total=${after403.data && after403.data.total} 含 c1? ${stillThere}`
  );

  // A5：评论作者 A 删自己的 c1 → 200 + data=null；复查 total=3、c1 不在。
  const a5 = await deleteComment(state.comments.c1, state.A.token);
  const afterA5 = await listComments(state.artB, state.C.token);
  const a5ok =
    afterA5.status === 200 &&
    afterA5.data &&
    afterA5.data.total === 3 &&
    Array.isArray(afterA5.data.list) &&
    !afterA5.data.list.some((c) => c.id === state.comments.c1);
  check(
    'A5',
    '评论作者删自己评论 → 200 + data=null，且 total 3、c1 已消失',
    a5.status === 200 && a5.data === null && a5ok,
    `删 HTTP ${a5.status} data=${a5.data}; 复查 total=${afterA5.data && afterA5.data.total} 含 c1? ${afterA5.data && afterA5.data.list.some((c) => c.id === state.comments.c1)}`
  );

  // A6：文章作者 B 删 A 的评论 c2 → 200 + data=null；复查抓「前」total（应为 2）。
  const a6 = await deleteComment(state.comments.c2, state.B.token);
  const afterA6 = await listComments(state.artB, state.C.token);
  const t6 = afterA6.data && afterA6.data.total;
  const a6ok = a6.status === 200 && a6.data === null && t6 === 2;
  check(
    'A6',
    '文章作者删他人评论 → 200 + data=null，total 降为 2（“前”快照）',
    a6ok,
    `删 HTTP ${a6.status} data=${a6.data}; total=${t6}`
  );

  // A7：文章作者 B 删自己的评论 c3 → 200 + data=null；复查抓「后」total（应为 1）。
  const a7 = await deleteComment(state.comments.c3, state.B.token);
  const afterA7 = await listComments(state.artB, state.C.token);
  const t7 = afterA7.data && afterA7.data.total;
  const a7ok = a7.status === 200 && a7.data === null && t7 === 1;
  check(
    'A7',
    '文章作者删自己评论 → 200 + data=null，total 降为 1（“后”快照）',
    a7ok,
    `删 HTTP ${a7.status} data=${a7.data}; total=${t7}`
  );

  // A8：A6 后的 total(=2) 与 A7 后的 total(=1) 差恰为 1 —— 计数精确递减，无多删/漏删。
  check(
    'A8',
    '连续两次删除计数精确递减：A6后total - A7后total === 1',
    typeof t6 === 'number' && typeof t7 === 'number' && t6 - t7 === 1,
    `t6=${t6} t7=${t7} 差=${t6 - t7}`
  );

  // A9：重复删除已软删的 c1 → 404（whereNotDeleted 查不到，幂等 404）。
  const a9 = await deleteComment(state.comments.c1, state.A.token);
  check(
    'A9',
    '重复删除已删除评论 → 404 / 40400',
    a9.status === 404 && a9.code === 40400,
    `HTTP ${a9.status} code=${a9.code} msg="${a9.message}"`
  );

  /* ============================================================
   * B 组（Chrome 交互，B1-B4）。此时 artB 仍可见，剩余评论仅 c4。
   * 登录态用 B（文章作者），所以每条评论都该带删除按钮。
   * ============================================================ */

  if (!(await cdpAlive())) {
    chromeChild = (await launchChrome()).child;
    await sleep(1500);
  }
  session = await attach();
  await session.send('Network.enable');

  // 进文章详情页（先 goto 到真实 origin，本地存储才可访问—— 在 about:blank 上读 localStorage 会抛 SecurityError），
  // 再注入 B 的登录态，整页重载触发 AppHeader onMounted 拉到 user。
  await session.goto(`${CONFIG.frontend}/article/${state.artB}`);
  await sleep(1000);
  await session.evaluate(`localStorage.setItem('token', ${lit(state.B.token)}); 'ok'`);
  await session.goto(`${CONFIG.frontend}/article/${state.artB}`);
  await sleep(1500);

  // 等评论加载完且 user 就绪（删除按钮出现 = 双重就绪信号）。
  const ready = await waitFor(
    `(function(){var m=${lit(MARK.c4)};var items=[].slice.call(document.querySelectorAll('.comment-item'));var t=items.find(function(it){var c=it.querySelector('.comment-content');return c&&c.textContent.indexOf(m)>=0;});return !!t&&!!t.querySelector('.comment-delete-btn');})()`,
    15000
  );
  check('B1', 'UI：B（文章作者）视角下 c4 渲染且带「删除」按钮', ready === true, `ready=${ready}`);

  // B2：点删除按钮 → ElMessageBox 确认框出现（含「删除」「取消」）。
  if (ready) {
    await session.evaluate(
      `(function(){var m=${lit(MARK.c4)};var items=[].slice.call(document.querySelectorAll('.comment-item'));var t=items.find(function(it){var c=it.querySelector('.comment-content');return c&&c.textContent.indexOf(m)>=0;});if(t){t.querySelector('.comment-delete-btn').click();}return !!t;})()`
    );
  }
  const boxShown = await waitFor(`!!document.querySelector('.el-message-box')`, 6000);
  const boxBtns = boxShown
    ? await session.evaluate(
        `[].slice.call(document.querySelectorAll('.el-message-box__btns .el-button')).map(function(b){return b.textContent.trim();})`
      )
    : [];
  check(
    'B2',
    'UI：点删除弹出二次确认框（含「删除」「取消」）',
    boxShown && Array.isArray(boxBtns) && boxBtns.includes('删除') && boxBtns.includes('取消'),
    `box=${boxShown} buttons=${JSON.stringify(boxBtns)}`
  );

  // B3：点「删除」确认 → c4 从 DOM 消失，删除按钮归零。
  if (boxShown) {
    await session.evaluate(
      `(function(){var btns=[].slice.call(document.querySelectorAll('.el-message-box__btns .el-button'));var cb=btns.find(function(b){return b.textContent.indexOf('删除')>=0;});if(cb){cb.click();}return !!cb;})()`
    );
  }
  const c4Gone = await waitFor(
    `(function(){var m=${lit(MARK.c4)};return ![].slice.call(document.querySelectorAll('.comment-content')).some(function(c){return c.textContent.indexOf(m)>=0;});})()`,
    8000
  );
  const delBtnsLeft = await session.evaluate(`document.querySelectorAll('.comment-delete-btn').length`);
  check(
    'B3',
    'UI：确认删除后 c4 从列表消失、删除按钮归零',
    c4Gone === true && delBtnsLeft === 0,
    `c4Gone=${c4Gone} 剩余删除按钮=${delBtnsLeft}`
  );

  // B4：双判——标题 total 字段=0 且出现空态「还没有评论」（删最后一条触发的 EmptyState 边界）。
  const b4 = await session.evaluate(
    `(function(){var t=document.querySelector('.comment-title');var tt=t?t.textContent:'';var m=/(\\d+)/.exec(tt);var total=m?parseInt(m[1],10):-1;var ed=document.querySelector('.el-empty__description');var empty=!!ed&&ed.textContent.indexOf('还没有评论')>=0;return {totalText:tt,total:total,empty:empty};})()`
  );
  check(
    'B4',
    'UI：删除后标题 total=0 且空态「还没有评论」出现（total 字段 + 列表消失双判）',
    b4 && b4.total === 0 && b4.empty === true,
    `totalText=${b4 && b4.totalText} total=${b4 && b4.total} empty=${b4 && b4.empty}`
  );

  /* ============================================================
   * A10（接口层，但排在 B 组之后）：B 软删 artB。
   * 必须在 B 组后——软删后评论列表 404，B 组就进不到页面了。
   * ============================================================ */

  const a10 = await deleteArticle(state.artB, state.B.token);
  check('A10', '文章作者软删 artB → 200（B 组已验完 UI，最后收口）', a10.status === 200, `HTTP ${a10.status} ${a10.message}`);
}

/* ============================ 页面等待小工具 ============================ */

async function waitFor(expression, timeout = 8000, interval = 200) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let raw;
    try {
      raw = await session.evaluate(`(function(){try{return String(!!(${expression}));}catch(e){return 'false';}})()`);
    } catch {
      raw = 'false';
    }
    if (raw === 'true') return true;
    await sleep(interval);
  }
  return false;
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
    try {
      session.close();
    } catch {
      /* noop */
    }
  }
  if (chromeChild) {
    await stopChrome(chromeChild);
  }

  // 清理：notifications → bookmarks → comments → articles → users（外键 RESTRICT，反序会被 1452 拦）。
  try {
    const prisma = await getPrisma();
    let comments = 0;
    let articles = 0;
    let notifications = 0;
    let bookmarks = 0;
    try {
      if (state.artB != null) {
        // 第 8 批起 comment 服务会发 COMMENT 通知（notifications.article_id / actor_id
        // 双 RESTRICT）：A/B/C 在靶子文章下发的评论会产通知行，不先删就删不掉
        // 靶子文章（P2003）。第 9 批 bookmarks 同型（article_id / user_id 双
        // RESTRICT），本探针不产收藏，按同一顺序防将来。
        const probeUserIds = [state.A, state.B, state.C].map((a) => a && a.userId).filter(Boolean);
        const r0 = await prisma.notification.deleteMany({
          where: { OR: [{ articleId: state.artB }, { userId: { in: probeUserIds } }, { actorId: { in: probeUserIds } }] },
        });
        notifications = r0.count;

        const r0b = await prisma.bookmark.deleteMany({
          where: { OR: [{ articleId: state.artB }, { userId: { in: probeUserIds } }] },
        });
        bookmarks = r0b.count;

        comments = (await prisma.comment.deleteMany({ where: { articleId: state.artB } })).count;
        articles = (await prisma.article.deleteMany({ where: { id: state.artB } })).count;
      }
    } finally {
      await prisma.$disconnect();
      prismaClient = null;
    }
    const usernames = [state.A, state.B, state.C].filter(Boolean).map((a) => a.username).filter(Boolean);
    const users = usernames.length ? await cleanupProbeAccounts(usernames) : 0;
    console.log(`\n清理：删除通知 ${notifications} 条 / 收藏 ${bookmarks} 条 / 评论 ${comments} 条 / 靶子文章 ${articles} 篇 / 探针账号 ${users} 个`);
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
