// 第 11 批「评论点赞」探针：A 幂等语义 / B 边界（401、软删评论、列表 liked）/ C 通知 / D UI 点赞按钮
//
// 与 probe-like.mjs（文章点赞）的分工（两个都测「赞」，但语义刻意相反）：
//   • probe-like.mjs        → 文章点赞：重复 409、取消未赞 404（**报错式**语义）；
//   • 本文件                → 评论点赞：重复 / 取消未赞**都 200 幂等**（bookmark / follow 族，
//                             docs/API.md「评论点赞与 @提及（第 11 批）」）。
// A 组把这条差异钉死：断言「200 且 code=0」的同时，detail 里显式对照 like 的 409 / 404，
// 将来有人把两个语义「统一」时会立刻红。
//
// 404 的唯一语义是「评论不可见」（评论软删 / 文章软删 / 草稿文章），**不是**「没赞过」
// ——B3 / B4 把这两条 404 路径各钉一遍。
//
// 与其他 Chrome 探针同一套规矩：
//   - 一次性 pwprobe 账号（A 作者 / B 评论者+UI 演员），不碰真实用户数据；
//   - 靶子文章与评论全部是探针自造的，跑完按 id 精确回收；
//   - finally 走 cleanupProbeAccounts 统一通道（其硬删序已含 comment_likes，第 11 批同步）；
//   - 自己起的 Chrome 自己关；
//   - 前置失败 exit 2、有 FAIL 或清理失败 exit 1、全绿 exit 0。
//
// ⚠️ 铁律（踩过两次）：
//   1) 验语法绝不能用 import() —— 会真的把探针跑一遍留下脏数据。语法交给 vite build。
//   2) 别用 `| head -N` / `| grep` 截断本脚本输出 —— 管道关闭会掐死 node，
//      finally 不跑，会留下 pwprobe 账号。一律 `> 文件` 再 grep 那个文件。
//
// 用法：node scripts/acceptance/probe-comment-like.mjs
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

// 评论点赞三件套（第 11 批）
const likeCommentApi = (id, token) => api('POST', `/comments/${id}/like`, { token });
const unlikeCommentApi = (id, token) => api('DELETE', `/comments/${id}/like`, { token });
const likedQuery = (id, token) => api('GET', `/comments/${id}/liked`, { token });

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

// A：文章作者 + 被赞评论作者；B：评论者 + UI 组演员（登录进详情页点赞）。
const A = { username: `pwprobe${stamp}a`, password: `probe${stamp}a`, token: null, userId: null };
const B = { username: `pwprobe${stamp}b`, password: `probe${stamp}b`, token: null, userId: null };

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
      content: '仅供 probe-comment-like.mjs 使用。'.repeat(5),
      category: '未分类',
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

/** 读某条评论的点赞按钮状态：is-liked 类 + 计数文本。 */
async function readLikeButton(commentId) {
  const raw = await session.evaluate(`(() => {
    const el = document.querySelector('[data-testid="comment-like"][data-comment-id="${commentId}"]');
    if (!el) return JSON.stringify({ exists: false });
    const count = el.querySelector('.comment-like-count');
    return JSON.stringify({
      exists: true,
      liked: el.classList.contains('is-liked'),
      count: count ? count.textContent.trim() : '',
    });
  })()`);

  return JSON.parse(raw || '{"exists":false}');
}

/** 按评论 id 点它的点赞按钮。 */
async function clickLikeButton(commentId) {
  return session.evaluate(`(() => {
    const el = document.querySelector('[data-testid="comment-like"][data-comment-id="${commentId}"]');
    if (!el) return 'no-button';
    el.click();
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

  /* ---------- 造靶子：两篇文章 + 三条评论 ---------- */

  const artMain = await createArticle(A.token, `评论点赞靶子 main ${stamp}`);
  const artDel = await createArticle(A.token, `评论点赞靶子 del ${stamp}`);
  // cA：A 在自己文章下的评论（自赞允许 + 自通知抑制的靶子）；
  // cB：B 的评论（A 组幂等语义的主靶子）；cDel：软删 404 组的靶子。
  const cA = await createComment(A.token, artMain, `A 的自赞靶子评论 ${stamp}`);
  const cB = await createComment(B.token, artMain, `B 的评论（幂等语义靶子） ${stamp}`);
  const cDel = await createComment(A.token, artDel, `A 在待软删文章下的评论 ${stamp}`);

  console.log(`靶子：artMain=${artMain} artDel=${artDel} cA=${cA} cB=${cB} cDel=${cDel}\n`);

  /* ================= A 组：幂等语义（与文章点赞刻意相反） ================= */

  const a1 = await likeCommentApi(cB, A.token);
  check(
    'A1',
    '首次赞评论 → 200 / code 0，liked=true，likeCount=1',
    a1.status === 200 && a1.code === 0 && a1.data && a1.data.liked === true && a1.data.likeCount === 1,
    `HTTP ${a1.status} code=${a1.code} ${JSON.stringify(a1.data)}`
  );

  const a5 = await likedQuery(cB, A.token);
  check(
    'A5',
    'GET /comments/:id/liked → { liked: true }，不带 likeCount 键（计数唯一来源是列表 / 点赞响应）',
    a5.status === 200 && a5.data && a5.data.liked === true && !('likeCount' in a5.data),
    `HTTP ${a5.status} ${JSON.stringify(a5.data)}`
  );

  // A2 是本探针的核心差异断言：文章点赞的重复是 40900，评论点赞的重复是**幂等 200**，
  // 且计数不因重放而 +1。
  const a2 = await likeCommentApi(cB, A.token);
  check(
    'A2',
    '重复赞同一评论 → 200 幂等，likeCount 仍 1（与 like 的 409 刻意相反）',
    a2.status === 200 && a2.code === 0 && a2.data && a2.data.liked === true && a2.data.likeCount === 1,
    `HTTP ${a2.status} code=${a2.code}（若为 409 说明被「统一」成了点赞语义） ${JSON.stringify(a2.data)}`
  );

  const a3 = await unlikeCommentApi(cB, A.token);
  check(
    'A3',
    '取消赞 → 200 / code 0，liked=false，likeCount=0',
    a3.status === 200 && a3.code === 0 && a3.data && a3.data.liked === false && a3.data.likeCount === 0,
    `HTTP ${a3.status} code=${a3.code} ${JSON.stringify(a3.data)}`
  );

  // A4 同 A2：取消没赞过的，文章点赞是 40400，评论点赞是**幂等 200**，计数不变负。
  const a4 = await unlikeCommentApi(cB, A.token);
  check(
    'A4',
    '取消没赞过的 → 200 幂等，likeCount 仍 0（与 like 的 404 刻意相反，不变负）',
    a4.status === 200 && a4.code === 0 && a4.data && a4.data.liked === false && a4.data.likeCount === 0,
    `HTTP ${a4.status} code=${a4.code}（若为 404 说明被「统一」成了点赞语义） ${JSON.stringify(a4.data)}`
  );

  // A6：接口**不禁止自赞**（与文章点赞同），计数照加；通知是否抑制在 C 组验。
  const a6 = await likeCommentApi(cA, A.token);
  check(
    'A6',
    '自赞自己的评论 → 200 允许，likeCount=1（通知抑制在 C 组单独验）',
    a6.status === 200 && a6.code === 0 && a6.data && a6.data.liked === true && a6.data.likeCount === 1,
    `HTTP ${a6.status} ${JSON.stringify(a6.data)}`
  );

  /* ================= B 组：边界（列表 liked / 401 / 404 口径） ================= */

  // B5（先于 404 组跑，此时列表还有 cA / cB 两条活评论）：
  // 带 token 的列表每项有 liked 布尔（A6 自赞过 cA → true；cB 已被取消 → false）；
  // 不带 token 时整页**不出现** liked 键（optionalAuth：无 token 静默当匿名，绝不 401）。
  const b5With = await api('GET', `/articles/${artMain}/comments?page=1&pageSize=20`, { token: A.token });
  const b5List = (b5With.data && b5With.data.list) || [];
  const b5CA = b5List.find((c) => c.id === cA) || null;
  const b5CB = b5List.find((c) => c.id === cB) || null;
  const b5NoToken = await api('GET', `/articles/${artMain}/comments?page=1&pageSize=20`);
  const b5AnonList = (b5NoToken.data && b5NoToken.data.list) || [];
  check(
    'B5',
    '评论列表：带 token 每项 liked 布尔（cA=true cB=false）+ likeCount；无 token 无 liked 键',
    b5With.status === 200 &&
      b5List.length === 2 &&
      b5CA && b5CA.liked === true && b5CA.likeCount === 1 &&
      b5CB && b5CB.liked === false && b5CB.likeCount === 0 &&
      b5NoToken.status === 200 &&
      b5AnonList.length === 2 &&
      b5AnonList.every((c) => !('liked' in c)),
    `带token=${JSON.stringify(b5List.map((c) => ({ id: c.id, liked: c.liked, n: c.likeCount })))} 无token含liked键数=${b5AnonList.filter((c) => 'liked' in c).length}`
  );

  // B1：三件套未登录全 401 / 40100。
  const b1post = await likeCommentApi(cB, null);
  const b1del = await unlikeCommentApi(cB, null);
  const b1get = await likedQuery(cB, null);
  check(
    'B1',
    '未登录：POST / DELETE / GET liked 三接口全 401 / 40100',
    b1post.status === 401 && b1post.code === 40100 &&
      b1del.status === 401 && b1del.code === 40100 &&
      b1get.status === 401 && b1get.code === 40100,
    `POST=${b1post.status}/${b1post.code} DELETE=${b1del.status}/${b1del.code} GET=${b1get.status}/${b1get.code}`
  );

  const b2 = await likeCommentApi(cB, 'not-a-real-token');
  check(
    'B2',
    'token 非法 → 401 / 40100',
    b2.status === 401 && b2.code === 40100,
    `HTTP ${b2.status} code=${b2.code} msg="${b2.message}"`
  );

  // B3：软删**文章**（连带评论区对外封闭）→ 其评论的三件套全 404。
  // 404 语义是「评论不可见」，不是「没赞过」——与 deleteComment 防枚举纪律一致。
  const b3del = await api('DELETE', `/articles/${artDel}`, { token: A.token });
  const b3post = await likeCommentApi(cDel, A.token);
  const b3delLike = await unlikeCommentApi(cDel, A.token);
  const b3get = await likedQuery(cDel, A.token);
  check(
    'B3',
    '文章软删后其评论：POST / DELETE / GET liked 全 404 / 40400（评论不可见口径）',
    b3del.status === 200 &&
      b3post.status === 404 && b3post.code === 40400 &&
      b3delLike.status === 404 && b3delLike.code === 40400 &&
      b3get.status === 404 && b3get.code === 40400,
    `删文章=${b3del.status} POST=${b3post.status}/${b3post.code} DELETE=${b3delLike.status}/${b3delLike.code} GET=${b3get.status}/${b3get.code}`
  );

  /* ================= C 组：COMMENT_LIKE 通知 ================= */

  // C1：A 赞 B 的评论 → B 收到 COMMENT_LIKE（actor=A，targetTitle=文章标题）。
  const c1like = await likeCommentApi(cB, A.token);
  await sleep(300); // 通知写库在事务后 await，留一点余量
  const bNotifs = await api('GET', '/notifications?page=1&pageSize=20', { token: B.token });
  const bList = (bNotifs.data && bNotifs.data.list) || [];
  const clRow = bList.find((n) => n.type === 'COMMENT_LIKE' && n.actorId === A.userId && n.targetTitle !== null);
  check(
    'C1',
    'A 赞 B 的评论 → B 收到 COMMENT_LIKE 通知（actor=A）',
    c1like.status === 200 && clRow,
    `like=${c1like.status} B 通知类型=[${bList.map((n) => n.type).join(',')}] 命中=${JSON.stringify(clRow && { actor: clRow.actorName, title: clRow.targetTitle })}`
  );

  // C2：A6 的自赞**没有**给 A 产生 COMMENT_LIKE（自通知抑制）。
  const aNotifs = await api('GET', '/notifications?page=1&pageSize=20', { token: A.token });
  const aList = (aNotifs.data && aNotifs.data.list) || [];
  const selfCl = aList.filter((n) => n.type === 'COMMENT_LIKE');
  check(
    'C2',
    'A 自赞自己的评论不产生 COMMENT_LIKE（自通知抑制）',
    aNotifs.status === 200 && selfCl.length === 0,
    `A 通知类型=[${aList.map((n) => n.type).join(',')}] COMMENT_LIKE 数=${selfCl.length}`
  );

  // B4（放 C 组后：C1 需要活的 cB）：B 软删**自己的评论** → A 的三件套全 404。
  const b4del = await api('DELETE', `/comments/${cB}`, { token: B.token });
  const b4post = await likeCommentApi(cB, A.token);
  const b4unlike = await unlikeCommentApi(cB, A.token);
  const b4get = await likedQuery(cB, A.token);
  check(
    'B4',
    '评论软删后：POST / DELETE / GET liked 全 404 / 40400（同「评论不可见」口径）',
    b4del.status === 200 &&
      b4post.status === 404 && b4post.code === 40400 &&
      b4unlike.status === 404 && b4unlike.code === 40400 &&
      b4get.status === 404 && b4get.code === 40400,
    `删评论=${b4del.status} POST=${b4post.status}/${b4post.code} DELETE=${b4unlike.status}/${b4unlike.code} GET=${b4get.status}/${b4get.code}`
  );

  /* ================= D 组：UI 评论点赞按钮 ================= */

  if (!(await cdpAlive())) {
    chromeChild = (await launchChrome()).child;
    await sleep(1500);
  }

  session = await attach();
  await session.send('Network.enable');

  // D1：B 登录进 artMain 详情页。此时列表只剩 cA（cB 已被 B4 软删），
  // cA 被 A 自赞过 → 计数 1，但 B 自己没赞过 → is-liked=false。
  await gotoAs(B.token, `/article/${artMain}`);
  const d1Ready = await waitFor(`document.querySelectorAll('[data-testid="comment-like"]').length > 0`);
  const d1Btn = d1Ready ? await readLikeButton(cA) : { exists: false };
  check(
    'D1',
    '详情页评论区渲染点赞按钮：cA 按钮存在、is-liked=false、计数 1（A 自赞的）',
    d1Ready && d1Btn.exists && d1Btn.liked === false && d1Btn.count === '1',
    `ready=${d1Ready} 按钮=${JSON.stringify(d1Btn)}`
  );

  // D2：B 点 cA 的赞 → is-liked 出现、计数变 2（响应回写，非乐观更新），
  // 且不发生页面跳转（按钮不是链接，@click 无 .prevent 需求但仍验路径）。
  const d2PathBefore = await session.evaluate(`location.pathname`);
  await clickLikeButton(cA);
  const d2On = await waitFor(
    `(() => { const el = document.querySelector('[data-testid="comment-like"][data-comment-id="${cA}"]'); return Boolean(el) && el.classList.contains('is-liked'); })()`,
    6000
  );
  await sleep(300); // 等计数文本回写
  const d2Btn = await readLikeButton(cA);
  const d2PathAfter = await session.evaluate(`location.pathname`);
  check(
    'D2',
    '点赞评论：is-liked 出现、计数 1→2、不跳页',
    d2On && d2Btn.count === '2' && d2PathAfter === d2PathBefore,
    `liked=${d2On} count=${d2Btn.count} 路径 ${d2PathBefore} → ${d2PathAfter}`
  );

  // D3：再点一次取消 → is-liked 消失、计数回落 1（幂等按钮完整往返，无 404/409 分支）。
  await clickLikeButton(cA);
  const d3Off = await waitFor(
    `(() => { const el = document.querySelector('[data-testid="comment-like"][data-comment-id="${cA}"]'); return Boolean(el) && !el.classList.contains('is-liked'); })()`,
    6000
  );
  await sleep(300);
  const d3Btn = await readLikeButton(cA);
  check(
    'D3',
    '再点取消：is-liked 消失、计数回落 1（幂等往返）',
    d3Off && d3Btn.count === '1',
    `unliked=${d3Off} count=${d3Btn.count}`
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

  // 清理：走 tmp-account 统一通道（其硬删序第 11 批已补 comment_likes：
  // notifications → bookmarks → likes → follows → comment_likes → comments → articles → series → users）。
  // B 评论过 A 的靶子文章、A 赞过 B 的评论，全按 userId / commentId 双侧精确清理，不会漏。
  try {
    const users = await cleanupProbeAccounts([A.username, B.username]);
    console.log(`\n清理：删除探针账号 ${users} 个（含其自造文章 / 评论 / 评论赞关系与通知）`);
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
