// 第 7 批「评论嵌套（楼中楼）」探针：纯后端行为验证（无浏览器）。
//
// 与 probe-draft 同一套规矩：
//   - 一次性 pwprobe 账号（A 作者 / B 评论者）；
//   - 全部用探针自己发的文章做靶子，真实数据不受影响；
//   - finally 按 comments → revisions → articles → users 清理
//     （comments.article_id 外键 RESTRICT，删文章前必须先物理删评论——
//      含软删行）。
//   - 【探针清理铁律】全程收集本趟创建的 comment / article 主键，
//     只按 id: { in: [...] } 精确删除；绝对禁止 article.authorId 之类的
//     跨表关联条件或无条件 deleteMany（2026-10-18 评论全表误删事故的修复）。
//     跑前/跑后各查一次 comments 全表行数，下降即 FAIL-SAFE。
//
// 覆盖（对应 docs/API.md 第 7 批评论契约 + 存量洞修复）：
//   顶层 parentId/replyToAuthor 为 null / 回复成功落库 + replyToAuthor /
//   父不存在 404 / 跨文章挂接 40000 / 回复的回复 40000（两层硬限制）/
//   扁平列表含 parentId+replyToAuthor、total=全部评论数 / 删父级联软删子 /
//   删子不影响父 / 软删父不可再回复 / 草稿评论封闭（POST+GET 404，存量洞）/
//   未登录 401 / 非作者删他人评论 403 / 文章作者删评论（连带确认）/
//   parentId 非法值 40000 / 重复删除 404。
//
// 用法：node scripts/acceptance/probe-nested-comment.mjs（需先起后端 3000）

/* ============================ 结果收集 ============================ */

const results = [];

function check(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} | ${desc} | ${detail}`);
}

/* ============================ HTTP 小工具 ============================ */

const API = process.env.PROBE_API || 'http://localhost:3000/api';

async function api(method, urlPath, { token = null, body = null } = {}) {
  const res = await fetch(`${API}${urlPath}`, {
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

/* ============================ Prisma（仅供清理） ============================ */

import path from 'node:path';
import { BACKEND, BACKEND_MODULES } from './lib/config.mjs';

const requireCjs = (await import('node:module')).createRequire(import.meta.url);

let prismaClient = null;
async function getPrisma() {
  if (prismaClient) return prismaClient;

  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));

  prismaClient = new PrismaClient();

  return prismaClient;
}

/**
 * 清理探针自造数据。顺序：comments → revisions → articles → users。
 * comments.article_id 外键是 RESTRICT：**物理删文章前必须先物理删评论**，
 * 且要连软删行一起删（deleteMany 不过滤 deletedAt，天然全删）。
 *
 * 【探针清理铁律】只删本趟明确创建的实体：评论/文章按主键 id in 精确删；
 * revisions 的主键由后端分配、探针拿不到，先按 articleId ∈ 本趟文章
 * 查出 id 再删——绝不使用 article.authorId 之类的跨表关联条件或
 * 无条件 deleteMany（2026-10-18 评论全表误删事故的修复）。
 */
async function cleanupProbeData(usernames, createdCommentIds, createdArticleIds) {
  const prisma = await getPrisma();
  let comments = 0;
  let revisions = 0;
  let articles = 0;

  try {
    if (createdCommentIds.length > 0) {
      const c1 = await prisma.comment.deleteMany({ where: { id: { in: createdCommentIds } } });
      comments = c1.count;
    }

    if (createdArticleIds.length > 0) {
      // revisions 主键探针拿不到：先按本趟文章 id（直接外键列）收集，再按 id 精确删。
      const revRows = await prisma.articleRevision.findMany({
        where: { articleId: { in: createdArticleIds } },
        select: { id: true },
      });
      if (revRows.length > 0) {
        const r1 = await prisma.articleRevision.deleteMany({ where: { id: { in: revRows.map((r) => r.id) } } });
        revisions = r1.count;
      }
      const r2 = await prisma.article.deleteMany({ where: { id: { in: createdArticleIds } } });
      articles = r2.count;
    }
  } finally {
    await prisma.$disconnect();
    prismaClient = null;
  }

  const { cleanupProbeAccounts } = await import('./lib/tmp-account.mjs');
  const users = await cleanupProbeAccounts(usernames);

  return { comments, revisions, articles, users };
}

/* ============================ 前置检查 ============================ */

async function preflight() {
  const health = await api('GET', '/health').catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    console.error(`后端不可用（${API}/health → ${health.status}），先起后端再跑探针`);
    process.exit(2);
  }
}

/* ============================ 账号造数 ============================ */

const PASSWORD = 'probe123456';

const ACCOUNT_A = {
  username: `pwprobe${Date.now()}${Math.floor(Math.random() * 1000)}`,
  password: PASSWORD,
  nickname: '嵌套探针A',
};
const ACCOUNT_B = {
  username: `pwprobe${Date.now() + 1}${Math.floor(Math.random() * 1000)}`,
  password: PASSWORD,
  nickname: '嵌套探针B',
};

const state = {
  tokenA: null,
  userIdA: null,
  tokenB: null,
  articleA: null, // A 的已发布文章（主靶子）
  articleA2: null, // A 的另一篇文章（跨文章挂接断言的靶子）
  articleDraft: null, // A 的草稿（草稿评论封闭断言）
};

// 【探针清理铁律】本趟创建的所有评论/文章主键，finally 只按这些 id 清理。
const createdCommentIds = [];
const createdArticleIds = [];
let commentCountStart = null; // 跑前 comments 全表行数（安全自检用）

function trackArticle(res) {
  if (res.data && res.data.id) createdArticleIds.push(res.data.id);
  return res;
}
function trackComment(res) {
  if (res.data && res.data.id) createdCommentIds.push(res.data.id);
  return res;
}

async function registerAndLogin(account) {
  const reg = await api('POST', '/auth/register', { body: account });
  if (reg.status !== 201) {
    throw new Error(`注册失败：${reg.status} ${reg.message}`);
  }

  const login = await api('POST', '/auth/login', {
    body: { username: account.username, password: account.password },
  });

  return { token: login.data && login.data.token, userId: login.data && login.data.user && login.data.user.id };
}

/* ============================ 主流程 ============================ */

async function main() {
  await preflight();

  // 跑前基线：comments 全表行数（finally 里比对，下降即误删）。
  const prisma0 = await getPrisma();
  commentCountStart = await prisma0.comment.count();

  const a = await registerAndLogin(ACCOUNT_A);
  state.tokenA = a.token;
  state.userIdA = a.userId;
  const b = await registerAndLogin(ACCOUNT_B);
  state.tokenB = b.token;
  check('C0', '探针账号 A/B 注册登录', Boolean(state.tokenA && state.tokenB), `A=${Boolean(state.tokenA)} B=${Boolean(state.tokenB)}`);

  // 造靶：A 发两篇已发布 + 一篇草稿。
  const art = trackArticle(await api('POST', '/articles', { token: state.tokenA, body: { title: '嵌套探针文一', content: '正文内容足够长。' } }));
  state.articleA = art.data && art.data.id;
  const art2 = trackArticle(await api('POST', '/articles', { token: state.tokenA, body: { title: '嵌套探针文二', content: '正文内容足够长。' } }));
  state.articleA2 = art2.data && art2.data.id;
  const draft = trackArticle(await api('POST', '/articles', { token: state.tokenA, body: { title: '嵌套探针草稿', content: '草稿正文内容。', status: 'DRAFT' } }));
  state.articleDraft = draft.data && draft.data.id;

  /* ---------- 发表与结构 ---------- */

  const r1 = trackComment(await api('POST', '/comments', { token: state.tokenB, body: { articleId: state.articleA, content: '顶层评论一' } }));
  const rootId = r1.data && r1.data.id;
  check(
    'C1',
    '顶层评论：parentId=null、replyToAuthor=null',
    r1.status === 201 && r1.data.parentId === null && r1.data.replyToAuthor === null,
    `parentId=${JSON.stringify(r1.data && r1.data.parentId)} replyTo=${JSON.stringify(r1.data && r1.data.replyToAuthor)}`
  );

  const r2 = trackComment(await api('POST', '/comments', { token: state.tokenA, body: { articleId: state.articleA, content: 'A 回复 B', parentId: rootId } }));
  const replyId = r2.data && r2.data.id;
  check(
    'C2',
    '回复成功：parentId 落库 + replyToAuthor=被回复人昵称',
    r2.status === 201 && r2.data.parentId === rootId && r2.data.replyToAuthor === ACCOUNT_B.nickname,
    `parentId=${r2.data && r2.data.parentId} replyTo=${JSON.stringify(r2.data && r2.data.replyToAuthor)}`
  );

  const r3 = await api('POST', '/comments', { token: state.tokenA, body: { articleId: state.articleA, content: '父不存在', parentId: 99999999 } });
  check(
    'C3',
    '父评论不存在 → 404 / 40400',
    r3.status === 404 && r3.code === 40400,
    `status=${r3.status} code=${r3.code}`
  );

  // 跨文章挂接：B 在 articleA2 发顶层，然后尝试把 articleA 的回复挂到它下——
  // 正确的跨文章断言是「回复时 articleId 与父评论的 articleId 不一致」：
  // 用 articleA2 的 id + articleA 的父评论 id 发请求（父存在、但属于另一篇文章）。
  const r4p = trackComment(await api('POST', '/comments', { token: state.tokenA, body: { articleId: state.articleA2, content: '第二篇的顶层' } }));
  const otherRootId = r4p.data && r4p.data.id;
  const r4 = await api('POST', '/comments', { token: state.tokenA, body: { articleId: state.articleA2, content: '跨文章挂接', parentId: rootId } });
  check(
    'C4',
    '跨文章挂接 → 400 / 40000（父评论属于另一篇文章）',
    r4.status === 400 && r4.code === 40000,
    `status=${r4.status} code=${r4.code}`
  );

  const r5 = await api('POST', '/comments', { token: state.tokenB, body: { articleId: state.articleA, content: '回复的回复', parentId: replyId } });
  check(
    'C5',
    '回复的回复 → 400 / 40000（两层硬限制）',
    r5.status === 400 && r5.code === 40000,
    `status=${r5.status} code=${r5.code}`
  );

  const l1 = await api('GET', `/articles/${state.articleA}/comments`);
  const replyRow = (l1.data.list || []).find((c) => c.id === replyId);
  check(
    'C6',
    '扁平列表含 parentId / replyToAuthor（结构只增字段）',
    l1.status === 200 && replyRow && replyRow.parentId === rootId && replyRow.replyToAuthor === ACCOUNT_B.nickname,
    `list=${(l1.data.list || []).length} replyRow.parentId=${replyRow && replyRow.parentId}`
  );

  check(
    'C7',
    'total = 全部未删评论数（顶层 + 回复）',
    l1.data.total === 2,
    `total=${l1.data.total}（期望 2）`
  );

  /* ---------- 删除与级联 ---------- */

  // B（评论作者）删自己的顶层评论 → 级联软删 A 的回复。
  const d1 = await api('DELETE', `/comments/${rootId}`, { token: state.tokenB });
  const l2 = await api('GET', `/articles/${state.articleA}/comments`);
  const idsAfter = (l2.data.list || []).map((c) => c.id);
  check(
    'C8',
    '删父评论 → 级联软删子评论（GET 同时消失，total 同步下降）',
    d1.status === 200 && !idsAfter.includes(rootId) && !idsAfter.includes(replyId) && l2.data.total === 0,
    `status=${d1.status} total=${l2.data.total} ids=${JSON.stringify(idsAfter)}`
  );

  const dup = await api('DELETE', `/comments/${rootId}`, { token: state.tokenB });
  check(
    'C9',
    '重复删除（已软删）→ 404',
    dup.status === 404 && dup.code === 40400,
    `status=${dup.status} code=${dup.code}`
  );

  // 删子不影响父：新造一棵树，B 删自己的回复，父保留。
  const t2 = trackComment(await api('POST', '/comments', { token: state.tokenB, body: { articleId: state.articleA, content: '顶层评论二' } }));
  const root2 = t2.data && t2.data.id;
  const t3 = trackComment(await api('POST', '/comments', { token: state.tokenA, body: { articleId: state.articleA, content: '回复甲', parentId: root2 } }));
  const reply2 = t3.data && t3.data.id;
  const t3b = trackComment(await api('POST', '/comments', { token: state.tokenA, body: { articleId: state.articleA, content: '回复乙', parentId: root2 } }));
  const d2 = await api('DELETE', `/comments/${reply2}`, { token: state.tokenA });
  const l3 = await api('GET', `/articles/${state.articleA}/comments`);
  const root2After = (l3.data.list || []).find((c) => c.id === root2);
  check(
    'C10',
    '删子评论不影响父与其余子回复',
    d2.status === 200 && root2After && l3.data.total === 2,
    `status=${d2.status} total=${l3.data.total}（期望2=父+回复乙）`
  );

  // 软删后的父不可再被回复：删掉 root2（级联乙），再对它回复 → 404。
  await api('DELETE', `/comments/${root2}`, { token: state.tokenB });
  const r12 = await api('POST', '/comments', { token: state.tokenB, body: { articleId: state.articleA, content: '回复已删的父', parentId: root2 } });
  check(
    'C11',
    '已软删的父评论不可再被回复 → 404',
    r12.status === 404 && r12.code === 40400,
    `status=${r12.status} code=${r12.code}`
  );

  /* ---------- 草稿评论封闭（存量洞修复回归） ---------- */

  const g1 = await api('POST', '/comments', { token: state.tokenB, body: { articleId: state.articleDraft, content: '草稿下的评论' } });
  const g2 = await api('GET', `/articles/${state.articleDraft}/comments`);
  check(
    'C12',
    '草稿发评论 → 404（存量洞修复：requireArticle 加 PUBLISHED 过滤）',
    g1.status === 404 && g1.code === 40400,
    `status=${g1.status} code=${g1.code}`
  );
  check(
    'C13',
    '草稿评论列表 → 404（与发评论同口径，草稿对外完全封闭）',
    g2.status === 404 && g2.code === 40400,
    `status=${g2.status} code=${g2.code}`
  );

  /* ---------- 鉴权与越权 ---------- */

  const u1 = await api('POST', '/comments', { body: { articleId: state.articleA, content: '未登录评论' } });
  const u2 = await api('POST', '/comments', { body: { articleId: state.articleA, content: '未登录回复', parentId: otherRootId } });
  check(
    'C14',
    '未登录发评论 / 回复 → 401',
    u1.status === 401 && u2.status === 401,
    `评论=${u1.status} 回复=${u2.status}`
  );

  // B 尝试删 A 的回复（B 既不是评论作者也不是文章作者）→ 403。
  // 造新树：B 发顶层（B 是作者），A 回复，然后 B 删 A 的回复。
  const t4 = trackComment(await api('POST', '/comments', { token: state.tokenB, body: { articleId: state.articleA, content: 'B 的顶层' } }));
  const bRoot = t4.data && t4.data.id;
  const t5 = trackComment(await api('POST', '/comments', { token: state.tokenA, body: { articleId: state.articleA, content: 'A 的回复', parentId: bRoot } }));
  const aReply = t5.data && t5.data.id;
  const d3 = await api('DELETE', `/comments/${aReply}`, { token: state.tokenB });
  check(
    'C15',
    '非作者删他人评论 → 403（B 既不是 A 回复的作者，也不是文章 A 的作者）',
    d3.status === 403 && d3.code === 40300,
    `status=${d3.status} code=${d3.code}`
  );

  // 文章作者（A）可删 B 的顶层评论 → 200（现有权限规则：评论作者 ∨ 文章作者）。
  const d4 = await api('DELETE', `/comments/${bRoot}`, { token: state.tokenA });
  check(
    'C16',
    '文章作者可删他人评论（现有规则保持）',
    d4.status === 200,
    `status=${d4.status}`
  );

  const bad1 = await api('POST', '/comments', { token: state.tokenB, body: { articleId: state.articleA, content: 'parentId 为 0', parentId: 0 } });
  const bad2 = await api('POST', '/comments', { token: state.tokenB, body: { articleId: state.articleA, content: 'parentId 为负', parentId: -1 } });
  check(
    'C17',
    'parentId 非法值（0 / 负数）→ 40000（zod 格式校验）',
    bad1.status === 400 && bad1.code === 40000 && bad2.status === 400 && bad2.code === 40000,
    `zero=${bad1.code} neg=${bad2.code}`
  );

  // 第二篇的顶层评论还在（跨文章隔离没有误伤）。
  const l4 = await api('GET', `/articles/${state.articleA2}/comments`);
  check(
    'C18',
    '跨文章隔离：第二篇文章的评论不受主靶子操作影响',
    l4.status === 200 && l4.data.total === 1 && l4.data.list[0].id === otherRootId,
    `total=${l4.data.total}`
  );
}

/* ============================ 入口 ============================ */

let exitCode = 1;

try {
  await main();
  exitCode = results.some((r) => !r.pass) ? 1 : 0;
} catch (error) {
  console.error('\n探针异常终止：', error && error.message ? error.message : error);
  exitCode = 1;
} finally {
  try {
    const cleaned = await cleanupProbeData(
      [ACCOUNT_A.username, ACCOUNT_B.username],
      createdCommentIds,
      createdArticleIds
    );
    console.log(
      `\n清理：评论 ${cleaned.comments} 条（仅本趟创建 ${createdCommentIds.length} 条，含软删行）/ 版本 ${cleaned.revisions} 条 / 文章 ${cleaned.articles} 篇 / 探针账号 ${cleaned.users} 个`
    );

    // 安全自检：① 本趟创建的实体必须全部物理消失；② comments 全表行数只增不减。
    // 注意 deleteMany 的 count 不含 DB 级级联（物理删父行时 ON DELETE CASCADE
    // 带走子行且不计入 count），所以不能只看 count，必须按 id 复核残留。
    if (commentCountStart !== null) {
      const prisma = await getPrisma();
      const leftComments = await prisma.comment.findMany({ where: { id: { in: createdCommentIds } }, select: { id: true } });
      const leftArticles = await prisma.article.findMany({ where: { id: { in: createdArticleIds } }, select: { id: true } });
      const commentCountEnd = await prisma.comment.count();
      await prisma.$disconnect();
      prismaClient = null;
      console.log(`comments 全表行数：跑前 ${commentCountStart} → 跑后 ${commentCountEnd}（本趟创建 ${createdCommentIds.length} 条）`);
      if (cleaned.comments < createdCommentIds.length) {
        console.log(
          `NOTE 清理计数 ${cleaned.comments} < 创建数 ${createdCommentIds.length}：物理删父行触发 parent_id 级联带走子行、不计入 count，非漏删（以残留复核为准）。`
        );
      }
      if (leftComments.length > 0 || leftArticles.length > 0) {
        console.error(
          `FAIL-SAFE | 本趟创建的实体未清干净：comments 残留 ${JSON.stringify(leftComments.map((c) => c.id))} / articles 残留 ${JSON.stringify(leftArticles.map((a) => a.id))}`
        );
        exitCode = 1;
      }
      if (commentCountEnd < commentCountStart) {
        console.error(`FAIL-SAFE | comments 全表行数下降（${commentCountStart} → ${commentCountEnd}），疑似误删库内既有数据！`);
        exitCode = 1;
      }
    }
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== probe-nested-comment 结果：${passed}/${results.length} 通过，exit=${exitCode} =====`);

process.exit(exitCode);
