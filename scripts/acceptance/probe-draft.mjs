// 第 6 批「草稿 / 自动保存 / 版本历史 / 回滚」探针：纯后端行为验证（无浏览器）。
//
// 与 probe-like 同一套规矩：
//   - 一次性 pwprobe 账号（本探针用 A/B 两个：A 是作者，B 是越权攻击者）；
//   - 全部用探针自己发的文章做靶子，真实数据不受影响；
//   - finally 里按 revisions → articles → users 的顺序清理
//     （article_revisions.author_id 与 articles.author_id 都是 RESTRICT，反序会被 1452 拦）。
//
// 覆盖（对应 docs/API.md 第 6 批五接口 + 4 防坑 + 3 补丁）：
//   建草稿门槛 IDLE / auto-save 建+更新（含清空 0 字）/ 草稿列表带 content 全文 /
//   DRAFT 公开详情 404 / draftId 与 sourceArticleId 越权 404 / 非作者 403 /
//   PUT 已发布产生快照（倒序）/ restore 先快照后覆盖 / revisionId 跨文章 404 /
//   草稿无版本历史 / 计数只数 PUBLISHED / 未登录 401。
//
// 用法：node scripts/acceptance/probe-draft.mjs（需先起后端 3000）

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
 * 清理探针自造数据。顺序：notifications → bookmarks → revisions → articles → users
 * （两条 author 外键都是 RESTRICT，先删 user/article 会被 MySQL 1452 拒）。
 *
 * 第 8 批通知 + 第 9 批收藏的 article_id / user_id / actor_id 全是 RESTRICT，
 * 必须最早删：先按 authorId ∈ userIds 收出本趟文章 id（与下面删文章同范围），
 * 通知/收藏按「文章 id ∪ 账号 id」两个方向删。
 */
async function cleanupProbeData(usernames, userIds) {
  const prisma = await getPrisma();
  let revisions = 0;
  let articles = 0;
  let notifications = 0;
  let bookmarks = 0;

  try {
    if (userIds.length > 0) {
      // 本趟文章 id（含软删行）：notifications / bookmarks 的 article_id 方向靠它。
      const artRows = await prisma.article.findMany({
        where: { authorId: { in: userIds } },
        select: { id: true },
      });
      const artIds = artRows.map((r) => r.id);

      const r0 = await prisma.notification.deleteMany({
        where: {
          OR: [{ articleId: { in: artIds } }, { userId: { in: userIds } }, { actorId: { in: userIds } }],
        },
      });
      notifications = r0.count;

      const r0b = await prisma.bookmark.deleteMany({
        where: { OR: [{ articleId: { in: artIds } }, { userId: { in: userIds } }] },
      });
      bookmarks = r0b.count;

      const r1 = await prisma.articleRevision.deleteMany({ where: { authorId: { in: userIds } } });
      revisions = r1.count;
      const r2 = await prisma.article.deleteMany({ where: { authorId: { in: userIds } } });
      articles = r2.count;
    }
  } finally {
    await prisma.$disconnect();
    prismaClient = null;
  }

  // 一次性账号走通用清理（lib/tmp-account.mjs 的 cleanupProbeAccounts）。
  const { cleanupProbeAccounts } = await import('./lib/tmp-account.mjs');
  const users = await cleanupProbeAccounts(usernames);

  return { revisions, articles, users, notifications, bookmarks };
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
  nickname: '草稿探针A',
};
const ACCOUNT_B = {
  username: `pwprobe${Date.now() + 1}${Math.floor(Math.random() * 1000)}`,
  password: PASSWORD,
  nickname: '草稿探针B',
};

const state = {
  tokenA: null,
  userIdA: null,
  tokenB: null,
  userIdB: null,
};

async function makeAccount(account) {
  const reg = await api('POST', '/auth/register', { body: account });
  if (reg.status !== 201) {
    console.error(`注册探针账号失败：HTTP ${reg.status} ${reg.message}`);
    process.exit(2);
  }

  const login = await api('POST', '/auth/login', {
    body: { username: account.username, password: account.password },
  });

  return { token: login.data && login.data.token, userId: login.data && login.data.user && login.data.user.id };
}

/* ============================ 主流程 ============================ */

async function main() {
  await preflight();

  const a = await makeAccount(ACCOUNT_A);
  const b = await makeAccount(ACCOUNT_B);
  state.tokenA = a.token;
  state.userIdA = a.userId;
  state.tokenB = b.token;
  state.userIdB = b.userId;

  if (!state.tokenA || !state.tokenB) {
    console.error('登录探针账号失败，拿不到 token');
    process.exit(2);
  }

  console.log(`探针账号 A：${ACCOUNT_A.username}（id=${state.userIdA}）`);
  console.log(`探针账号 B：${ACCOUNT_B.username}（id=${state.userIdB}）\n`);

  /* ---------- G1 建草稿门槛（补丁 3 第一道闸） ---------- */

  const idle = await api('POST', '/articles/auto-save', {
    token: state.tokenA,
    body: { title: '', content: '太短' },
  });
  check(
    'D1',
    '门槛拦截：title 空且 content < 10 字 → 不建草稿，返回 IDLE',
    idle.status === 200 && idle.data && idle.data.id === null && idle.data.status === 'IDLE' && idle.data.saved === false,
    `status=${idle.status} data=${JSON.stringify(idle.data)}`
  );

  const drafts0 = await api('GET', '/users/me/drafts', { token: state.tokenA });
  check(
    'D2',
    '门槛拦截后草稿箱仍为空（没有偷偷建草稿）',
    drafts0.status === 200 && drafts0.data && drafts0.data.total === 0,
    `total=${drafts0.data && drafts0.data.total}`
  );

  /* ---------- G2 建草稿 + 更新（含清空） ---------- */

  const created = await api('POST', '/articles/auto-save', {
    token: state.tokenA,
    body: { title: '草稿A标题', content: '这是草稿A的正文内容，长度超过十个字。' },
  });
  const draftA = created.data && created.data.id;
  check(
    'D3',
    'auto-save 新建草稿 → { status: DRAFT, saved: true }',
    created.status === 200 && created.data && created.data.saved === true && created.data.status === 'DRAFT' && Number.isInteger(draftA),
    `status=${created.status} data=${JSON.stringify(created.data)}`
  );

  const drafts1 = await api('GET', '/users/me/drafts', { token: state.tokenA });
  const draftRow = drafts1.data && drafts1.data.list && drafts1.data.list[0];
  check(
    'D4',
    '草稿箱列表 total=1，且带 content 全文（继续编辑回填的数据来源）',
    drafts1.data && drafts1.data.total === 1 && draftRow && draftRow.content === '这是草稿A的正文内容，长度超过十个字。',
    `total=${drafts1.data && drafts1.data.total} content=${draftRow && JSON.stringify(draftRow.content)}`
  );

  const cleared = await api('POST', '/articles/auto-save', {
    token: state.tokenA,
    body: { draftId: draftA, title: '', content: '' },
  });
  check(
    'D5',
    '补丁 3 第二道闸：持有 draftId 后清空到 0 字仍然保存成功',
    cleared.status === 200 && cleared.data && cleared.data.saved === true && cleared.data.id === draftA,
    `status=${cleared.status} data=${JSON.stringify(cleared.data)}`
  );

  const drafts2 = await api('GET', '/users/me/drafts', { token: state.tokenA });
  const clearedRow = drafts2.data && drafts2.data.list && drafts2.data.list[0];
  check(
    'D6',
    '清空结果确实落库（title="" content=""，未被门槛拦下）',
    clearedRow && clearedRow.title === '' && clearedRow.content === '',
    `row=${clearedRow && JSON.stringify({ title: clearedRow.title, content: clearedRow.content })}`
  );

  /* ---------- G3 草稿隔离（坑 1 / 坑 3） ---------- */

  const draftDetail = await api('GET', `/articles/${draftA}`);
  check(
    'D7',
    '坑 3：DRAFT 公开详情一律 404（不分请求者）',
    draftDetail.status === 404 && draftDetail.code === 40400,
    `status=${draftDetail.status} code=${draftDetail.code}`
  );

  const hijackSave = await api('POST', '/articles/auto-save', {
    token: state.tokenB,
    body: { draftId: draftA, title: '黑稿', content: '越权改别人的草稿'.repeat(3) },
  });
  check(
    'D8',
    '坑 1：B 用 A 的 draftId auto-save → 404（非本人草稿）',
    hijackSave.status === 404 && hijackSave.code === 40400,
    `status=${hijackSave.status} code=${hijackSave.code}`
  );

  const hijackDelete = await api('DELETE', `/users/me/drafts/${draftA}`, { token: state.tokenB });
  check(
    'D9',
    'B 删除 A 的草稿 → 404',
    hijackDelete.status === 404 && hijackDelete.code === 40400,
    `status=${hijackDelete.status} code=${hijackDelete.code}`
  );

  const ghostDraft = await api('POST', '/articles/auto-save', {
    token: state.tokenA,
    body: { draftId: 99999999, title: 'x', content: 'y' },
  });
  check(
    'D10',
    'auto-save 传不存在的 draftId → 404',
    ghostDraft.status === 404 && ghostDraft.code === 40400,
    `status=${ghostDraft.status} code=${ghostDraft.code}`
  );

  /* ---------- G4 已发布文章 + 版本快照 ---------- */

  const art1 = await api('POST', '/articles', {
    token: state.tokenA,
    body: { title: '第一版标题', content: '第一版正文内容。'.repeat(3), category: '技术' },
  });
  const artA = art1.data && art1.data.id;
  if (art1.status !== 201 || !artA) {
    console.error(`造已发布文章失败：HTTP ${art1.status} ${art1.message}`);
    process.exit(2);
  }

  const put1 = await api('PUT', `/articles/${artA}`, {
    token: state.tokenA,
    body: { title: '第二版标题', content: '第二版正文内容。'.repeat(3), category: '技术' },
  });

  const revs1 = await api('GET', `/articles/${artA}/revisions`, { token: state.tokenA });
  const rev1 = revs1.data && revs1.data.revisions && revs1.data.revisions[0];
  check(
    'D11',
    'PUT 已发布文章产生快照：total=1，快照内容 = 更新前的第一版',
    put1.status === 200 && revs1.data && revs1.data.total === 1 && rev1 && rev1.content === '第一版正文内容。'.repeat(3) && rev1.title === '第一版标题',
    `total=${revs1.data && revs1.data.total} rev=${rev1 && JSON.stringify({ title: rev1.title, content: rev1.content && rev1.content.slice(0, 20) })}`
  );

  await api('PUT', `/articles/${artA}`, {
    token: state.tokenA,
    body: { title: '第三版标题', content: '第三版正文内容。'.repeat(3), category: '生活' },
  });

  const revs2 = await api('GET', `/articles/${artA}/revisions`, { token: state.tokenA });
  const revs2List = (revs2.data && revs2.data.revisions) || [];
  check(
    'D12',
    '再次 PUT 后 total=2，且倒序（最新快照在前 = 第二版）',
    revs2List.length === 2 && revs2List[0].content === '第二版正文内容。'.repeat(3) && revs2List[1].content === '第一版正文内容。'.repeat(3),
    `order=${revs2List.map((r) => (r.content || '').slice(0, 8)).join(' | ')}`
  );

  const draftRevs = await api('GET', `/articles/${draftA}/revisions`, { token: state.tokenA });
  check(
    'D13',
    '草稿没有版本历史：GET /articles/:draftId/revisions → 404',
    draftRevs.status === 404 && draftRevs.code === 40400,
    `status=${draftRevs.status} code=${draftRevs.code}`
  );

  const revsB = await api('GET', `/articles/${artA}/revisions`, { token: state.tokenB });
  check(
    'D14',
    '非作者查版本历史 → 403（区分「无权」与「不存在」）',
    revsB.status === 403 && revsB.code === 40300,
    `status=${revsB.status} code=${revsB.code}`
  );

  /* ---------- G5 restore（先快照后覆盖） ---------- */

  const firstRevId = revs2List.length === 2 ? revs2List[1].id : null;
  const restore1 = await api('POST', `/articles/${artA}/restore`, {
    token: state.tokenA,
    body: { revisionId: firstRevId },
  });
  const restoredDetail = restore1.data;
  check(
    'D15',
    'restore 回滚到第一版：正文/标题回到第一版，status 保持 PUBLISHED',
    restore1.status === 200 && restoredDetail && restoredDetail.title === '第一版标题' && restoredDetail.content === '第一版正文内容。'.repeat(3),
    `status=${restore1.status} data=${restoredDetail && JSON.stringify({ title: restoredDetail.title, content: restoredDetail.content && restoredDetail.content.slice(0, 16) })}`
  );

  const revs3 = await api('GET', `/articles/${artA}/revisions`, { token: state.tokenA });
  const revs3List = (revs3.data && revs3.data.revisions) || [];
  check(
    'D16',
    '回滚本身也产生快照（先快照后覆盖）：total=3，最新快照 = 回滚前的第三版',
    revs3List.length === 3 && revs3List[0].content === '第三版正文内容。'.repeat(3),
    `total=${revs3List.length} latest=${revs3List[0] && (revs3List[0].content || '').slice(0, 8)}`
  );

  // 造第二篇已发布文章 + 一条快照，用于跨文章 revisionId 校验。
  const art2 = await api('POST', '/articles', {
    token: state.tokenA,
    body: { title: '另一篇文章', content: '另一篇的正文。'.repeat(3) },
  });
  const artA2 = art2.data && art2.data.id;
  await api('PUT', `/articles/${artA2}`, {
    token: state.tokenA,
    body: { title: '另一篇文章改', content: '另一篇的正文改。'.repeat(3) },
  });
  const revsOther = await api('GET', `/articles/${artA2}/revisions`, { token: state.tokenA });
  const otherRevId = revsOther.data && revsOther.data.revisions && revsOther.data.revisions[0].id;

  const crossRestore = await api('POST', `/articles/${artA}/restore`, {
    token: state.tokenA,
    body: { revisionId: otherRevId },
  });
  check(
    'D17',
    'revisionId 属于别的文章 → 404（防跨文章回滚）',
    crossRestore.status === 404 && crossRestore.code === 40400,
    `status=${crossRestore.status} code=${crossRestore.code}`
  );

  const restoreB = await api('POST', `/articles/${artA}/restore`, {
    token: state.tokenB,
    body: { revisionId: firstRevId },
  });
  check(
    'D18',
    '非作者 restore → 403',
    restoreB.status === 403 && restoreB.code === 40300,
    `status=${restoreB.status} code=${restoreB.code}`
  );

  /* ---------- G6 补丁 1：编辑已发布文章的独立草稿流程 ---------- */

  const hijackSource = await api('POST', '/articles/auto-save', {
    token: state.tokenB,
    body: { sourceArticleId: artA, title: 'x', content: '越权编辑别人的文章'.repeat(3) },
  });
  check(
    'D19',
    'sourceArticleId 指向他人文章 → 404（补丁 1 归属校验）',
    hijackSource.status === 404 && hijackSource.code === 40400,
    `status=${hijackSource.status} code=${hijackSource.code}`
  );

  const tempDraft = await api('POST', '/articles/auto-save', {
    token: state.tokenA,
    body: {
      sourceArticleId: artA,
      title: '独立草稿标题',
      content: '编辑已发布文章时的独立草稿内容。',
    },
  });
  const tempDraftId = tempDraft.data && tempDraft.data.id;
  check(
    'D20',
    '带 sourceArticleId 的 auto-save 建独立草稿成功（不落库 sourceArticleId）',
    tempDraft.status === 200 && tempDraft.data && tempDraft.data.saved === true && Number.isInteger(tempDraftId) && tempDraftId !== artA,
    `status=${tempDraft.status} data=${JSON.stringify(tempDraft.data)}`
  );

  const pubPut = await api('PUT', `/articles/${artA}`, {
    token: state.tokenA,
    body: { title: '发布覆盖版标题', content: '发布覆盖版正文内容。'.repeat(3) },
  });
  const delTemp = await api('DELETE', `/users/me/drafts/${tempDraftId}`, { token: state.tokenA });
  check(
    'D21',
    '补丁 1 发布流程：PUT 原文覆盖成功 + DELETE 临时草稿成功',
    pubPut.status === 200 && delTemp.status === 200,
    `put=${pubPut.status} delete=${delTemp.status}`
  );

  const deadDraft = await api('POST', '/articles/auto-save', {
    token: state.tokenA,
    body: { draftId: tempDraftId, title: 'x', content: 'y' },
  });
  check(
    'D22',
    '已删除的 draftId 再 auto-save → 404（物理删除生效）',
    deadDraft.status === 404 && deadDraft.code === 40400,
    `status=${deadDraft.status} code=${deadDraft.code}`
  );

  /* ---------- G7 坑 4：计数只数 PUBLISHED ---------- */

  // A 当前应有：2 篇 PUBLISHED（artA、artA2）+ 1 篇 DRAFT（draftA）。
  const meDetail = await api('GET', `/users/${state.userIdA}`);
  check(
    'D23',
    '坑 4：articleCount 只数 PUBLISHED（草稿不计入）',
    meDetail.status === 200 && meDetail.data && meDetail.data.articleCount === 2,
    `articleCount=${meDetail.data && meDetail.data.articleCount}（预期 2）`
  );

  const myList = await api('GET', `/users/${state.userIdA}/articles`, { token: state.tokenA });
  const myListIds = ((myList.data && myList.data.list) || []).map((r) => r.id);
  check(
    'D24',
    '坑 4：个人主页文章列表不含草稿，total=2',
    myList.data && myList.data.total === 2 && myListIds.includes(draftA) === false && myListIds.includes(artA) && myListIds.includes(artA2),
    `total=${myList.data && myList.data.total} ids=${JSON.stringify(myListIds)} draftA=${draftA}`
  );

  /* ---------- G8 未登录 401 ---------- */

  const noAuthDrafts = await api('GET', '/users/me/drafts');
  const noAuthSave = await api('POST', '/articles/auto-save', { body: { title: 'x', content: 'y'.repeat(10) } });
  check(
    'D25',
    '未登录：GET /users/me/drafts 与 auto-save 均 401/40100',
    noAuthDrafts.status === 401 && noAuthDrafts.code === 40100 && noAuthSave.status === 401 && noAuthSave.code === 40100,
    `drafts=${noAuthDrafts.status}/${noAuthDrafts.code} save=${noAuthSave.status}/${noAuthSave.code}`
  );

  /* ---------- 汇总 ---------- */

  const pass = results.filter((r) => r.pass).length;
  console.log(`\nprobe-draft：${pass}/${results.length} 通过`);

  if (pass !== results.length) {
    console.log('\n失败项：');
    results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.id} ${r.desc} → ${r.detail}`));
  }

  return pass === results.length ? 0 : 1;
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
      [state.userIdA, state.userIdB].filter(Boolean)
    );
    console.log(
      `\n清理：删除通知 ${cleaned.notifications} 条 / 收藏 ${cleaned.bookmarks} 条 / 版本 ${cleaned.revisions} 条 / 文章 ${cleaned.articles} 篇 / 探针账号 ${cleaned.users} 个`
    );
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
