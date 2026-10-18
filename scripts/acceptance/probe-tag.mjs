// 第 7 批「标签系统」探针：纯后端行为验证（无浏览器）。
//
// 与 probe-draft 同一套规矩：
//   - 一次性 pwprobe 账号（A 作者 / B 越权者）；
//   - 全部用探针自己发的文章与标签做靶子（标签名带本趟时间戳后缀，绝不碰真实数据）；
//   - finally 按 articleTag → tag → revisions → articles → users 清理。
//   - 【探针清理铁律】全程收集本趟创建的 article 主键，文章按
//     id: { in: [...] } 精确删；article_tags / revisions 按本趟文章 id
//     （直接外键列）限定；tags 只删本趟时间戳前缀命名空间内的行（先查 id 再删）。
//     绝对禁止跨表关联条件或无条件 deleteMany（2026-10-18 评论全表误删事故的修复）。
//     跑前/跑后各查一次 articles 全表行数，下降即 FAIL-SAFE。
//
// 覆盖（对应 docs/API.md 第 7 批标签契约）：
//   POST 带 tags 创建（name asc 排序）/ 省略 tags 默认 [] / >5 个 40000 /
//   标签名超 20 字与空串 40000 / GET /tags 热门榜（计数只数 PUBLISHED、
//   草稿不计入、0 篇标签不出现）/ ?tag= 精确筛选（命中 / 大小写敏感 /
//   不存在空列表 / 空串不过滤 / 与 category 正交叠加）/ PUT tags 三态 /
//   列表项带 tags / limit 非法 40000。
//
// 用法：node scripts/acceptance/probe-tag.mjs（需先起后端 3000）

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
 * 清理探针自造数据。顺序：article_tags → tags → revisions → articles，
 * 最后一次性账号走 lib/tmp-account.mjs 的通用清理。
 * article_tags 两条外键都是 CASCADE，物理删 article 会自动带走关联——
 * 但显式先删一遍中间表，保证 tags 侧的删除不依赖级联时序。
 *
 * 【探针清理铁律】只删本趟明确创建的实体：文章按主键 id in 精确删；
 * article_tags / revisions 按本趟文章 id（直接外键列）限定，只可能命中
 * 挂在本趟文章上的行；tags 只删本趟时间戳前缀（TAG_PREFIX）命名空间内
 * 的行，先查 id 再按 id 删。绝不使用 article.authorId 之类的跨表关联
 * 条件或无条件 deleteMany（2026-10-18 评论全表误删事故的修复）。
 */
async function cleanupProbeData(usernames, createdArticleIds, tagNamePrefix) {
  const prisma = await getPrisma();
  let links = 0;
  let tags = 0;
  let revisions = 0;
  let articles = 0;

  try {
    if (createdArticleIds.length > 0) {
      const l1 = await prisma.articleTag.deleteMany({ where: { articleId: { in: createdArticleIds } } });
      links = l1.count;
      const r1 = await prisma.articleRevision.deleteMany({ where: { articleId: { in: createdArticleIds } } });
      revisions = r1.count;
      const r2 = await prisma.article.deleteMany({ where: { id: { in: createdArticleIds } } });
      articles = r2.count;
    }

    // 标签行全库共享：只删本趟时间戳前缀命名空间内的，先查 id 再按 id 精确删。
    const tagRows = await prisma.tag.findMany({ where: { name: { startsWith: tagNamePrefix } }, select: { id: true } });
    if (tagRows.length > 0) {
      const t1 = await prisma.tag.deleteMany({ where: { id: { in: tagRows.map((t) => t.id) } } });
      tags = t1.count;
    }
  } finally {
    await prisma.$disconnect();
    prismaClient = null;
  }

  const { cleanupProbeAccounts } = await import('./lib/tmp-account.mjs');
  const users = await cleanupProbeAccounts(usernames);

  return { links, tags, revisions, articles, users };
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
  nickname: '标签探针A',
};
const ACCOUNT_B = {
  username: `pwprobe${Date.now() + 1}${Math.floor(Math.random() * 1000)}`,
  password: PASSWORD,
  nickname: '标签探针B',
};

const state = {
  tokenA: null,
  userIdA: null,
  tokenB: null,
};

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

/* ============================ 标签名（带趟次后缀防撞库） ============================ */

const SUFFIX = String(Date.now()).slice(-8);
const TAG_PREFIX = `pwtag${SUFFIX}`;
const TAG_X = `${TAG_PREFIX}X`; // 大写 X（大小写敏感断言的靶子）
const TAG_Y = `${TAG_PREFIX}y`;
const TAG_Z = `${TAG_PREFIX}Z`;

const state2 = {
  articleX: null, // 绑 TAG_X + TAG_Y 的已发布文章
  articleZ: null, // 绑 TAG_Z 的已发布文章（category=技术，验证正交）
  articleDraft: null, // 绑 TAG_X 的草稿（草稿不计入热门榜计数）
};

// 【探针清理铁律】本趟创建的所有文章主键，finally 只按这些 id 清理。
const createdArticleIds = [];
let articleCountStart = null; // 跑前 articles 全表行数（安全自检用）

function trackArticle(res) {
  if (res.data && res.data.id) createdArticleIds.push(res.data.id);
  return res;
}

/* ============================ 主流程 ============================ */

async function main() {
  await preflight();

  // 跑前基线：articles 全表行数（finally 里比对，下降即误删）。
  const prisma0 = await getPrisma();
  articleCountStart = await prisma0.article.count();

  const a = await registerAndLogin(ACCOUNT_A);
  state.tokenA = a.token;
  state.userIdA = a.userId;
  const b = await registerAndLogin(ACCOUNT_B);
  state.tokenB = b.token;
  check('T0', '探针账号 A/B 注册登录', Boolean(state.tokenA && state.tokenB), `A=${Boolean(state.tokenA)} B=${Boolean(state.tokenB)}`);

  /* ---------- 创建侧 ---------- */

  const c1 = trackArticle(await api('POST', '/articles', {
    token: state.tokenA,
    body: { title: '标签探针文一', content: '正文内容足够长。', category: '生活', tags: [TAG_Y, TAG_X] },
  }));
  state.articleX = c1.data && c1.data.id;
  check(
    'T1',
    'POST 带 tags 创建 201，detail.tags 按 name asc 排序',
    c1.status === 201 && JSON.stringify(c1.data && c1.data.tags) === JSON.stringify([TAG_X, TAG_Y]),
    `status=${c1.status} tags=${JSON.stringify(c1.data && c1.data.tags)}`
  );

  const c2 = trackArticle(await api('POST', '/articles', {
    token: state.tokenA,
    body: { title: '标签探针文二', content: '正文内容足够长。' },
  }));
  check(
    'T2',
    'POST 省略 tags 默认 []（返回键存在且为空数组）',
    c2.status === 201 && Array.isArray(c2.data && c2.data.tags) && c2.data.tags.length === 0,
    `tags=${JSON.stringify(c2.data && c2.data.tags)}`
  );

  const c3 = await api('POST', '/articles', {
    token: state.tokenA,
    body: { title: '标签探针文三', content: '正文内容足够长。', tags: ['1', '2', '3', '4', '5', '6'] },
  });
  check(
    'T3',
    'POST tags 超 5 个 → 400 / 40000，不做静默截断',
    c3.status === 400 && c3.code === 40000,
    `status=${c3.status} code=${c3.code}`
  );

  const c4a = await api('POST', '/articles', {
    token: state.tokenA,
    body: { title: '标签探针文四', content: '正文内容足够长。', tags: ['x'.repeat(21)] },
  });
  const c4b = await api('POST', '/articles', {
    token: state.tokenA,
    body: { title: '标签探针文五', content: '正文内容足够长。', tags: ['   '] },
  });
  check(
    'T4',
    '标签名超 20 字 / 纯空白 → 40000（trim 后为空不算合法标签）',
    c4a.status === 400 && c4a.code === 40000 && c4b.status === 400 && c4b.code === 40000,
    `超长=${c4a.code} 空白=${c4b.code}`
  );

  /* ---------- GET /tags 热门榜 ---------- */

  // 一篇已发布绑 TAG_X（articleX）+ 一篇草稿也绑 TAG_X：计数应只含已发布的 1 篇。
  const d1 = trackArticle(await api('POST', '/articles', {
    token: state.tokenA,
    body: { title: '标签探针草稿', content: '草稿正文内容。', status: 'DRAFT', tags: [TAG_X] },
  }));
  state.articleDraft = d1.data && d1.data.id;

  const c5 = trackArticle(await api('POST', '/articles', {
    token: state.tokenA,
    body: { title: '标签探针文六', content: '正文内容足够长。', category: '技术', tags: [TAG_Z] },
  }));
  state.articleZ = c5.data && c5.data.id;

  const hot = await api('GET', '/tags?limit=100');
  const byName = new Map((hot.data && hot.data.list || []).map((t) => [t.name, t]));
  const cntX = byName.get(TAG_X);
  check(
    'T5',
    'GET /tags 含所建标签，articleCount 只数 PUBLISHED（草稿不计入）',
    hot.status === 200 && cntX && cntX.articleCount === 1,
    `TAG_X count=${cntX && cntX.articleCount}（期望 1 = 1 已发布 + 1 草稿不计）`
  );

  const c6 = await api('GET', `/articles?tag=${encodeURIComponent(TAG_X)}`);
  check(
    'T6',
    '?tag= 精确命中：只返回绑该标签的已发布文章',
    c6.status === 200 && c6.data.list.length === 1 && c6.data.list[0].id === state.articleX,
    `hits=${c6.data.list.length} ids=${JSON.stringify(c6.data.list.map((x) => x.id))}`
  );

  // 实测发现：tags 列为 MySQL utf8mb4_unicode_ci（大小写不敏感），「Vue」与「vue」
  // 是同一个标签（唯一约束也按 ci 判重）。后端零额外代码获得了大小写折叠，
  // 与用户「中文字段没意义、别为大小写费劲」的拍板意图一致；文档已同步为 ci 语义。
  const lowerName = TAG_X.slice(0, -1) + 'x'; // 大写 X → 小写 x
  const c7 = await api('GET', `/articles?tag=${encodeURIComponent(lowerName)}`);
  check(
    'T7',
    '?tag= 大小写不敏感（DB ci 排序规则）：小写变体命中大写标签的文章',
    c7.status === 200 && c7.data.list.length === 1 && c7.data.list[0].id === state.articleX,
    `tag=${lowerName} hits=${c7.data.list.length}`
  );

  const c8 = await api('GET', `/articles?tag=${TAG_PREFIX}NOPE`);
  check(
    'T8',
    '?tag= 标签不存在 → 200 空列表（不是 404）',
    c8.status === 200 && c8.data.list.length === 0 && c8.data.total === 0,
    `status=${c8.status} total=${c8.data.total}`
  );

  const c9a = await api('GET', `/articles?tag=${encodeURIComponent(TAG_Z)}&category=${encodeURIComponent('技术')}`);
  const c9b = await api('GET', `/articles?tag=${encodeURIComponent(TAG_Z)}&category=${encodeURIComponent('生活')}`);
  check(
    'T9',
    '?tag= 与 category 正交叠加：同标签下按分类过滤',
    c9a.data.list.length === 1 && c9b.data.list.length === 0,
    `技术=${c9a.data.list.length}（期望1） 生活=${c9b.data.list.length}（期望0）`
  );

  const c10 = await api('GET', '/articles?tag=');
  const c10b = await api('GET', '/articles');
  check(
    'T10',
    '?tag= 空串视为不筛选（与不传等价，返回全量）',
    c10.status === 200 && c10.data.total === c10b.data.total,
    `空串 total=${c10.data.total} 不传 total=${c10b.data.total}`
  );

  const c11 = await api('GET', `/articles?tag=${'x'.repeat(21)}`);
  check(
    'T11',
    '?tag= 超 20 字 → 400 / 40000（与创建侧同一口径）',
    c11.status === 400 && c11.code === 40000,
    `status=${c11.status} code=${c11.code}`
  );

  /* ---------- PUT 三态 ---------- */

  const p1 = await api('PUT', `/articles/${state.articleX}`, {
    token: state.tokenA,
    body: { title: '标签探针文一', content: '正文内容足够长。' }, // 不带 tags
  });
  check(
    'T12',
    'PUT 不传 tags → 保留原关联（三态之一）',
    p1.status === 200 && JSON.stringify(p1.data.tags) === JSON.stringify([TAG_X, TAG_Y]),
    `tags=${JSON.stringify(p1.data.tags)}`
  );

  const p2 = await api('PUT', `/articles/${state.articleX}`, {
    token: state.tokenA,
    body: { title: '标签探针文一', content: '正文内容足够长。', tags: [TAG_Z] },
  });
  check(
    'T13',
    'PUT 传新值 → 全量替换（删旧建新）',
    p2.status === 200 && JSON.stringify(p2.data.tags) === JSON.stringify([TAG_Z]),
    `tags=${JSON.stringify(p2.data.tags)}`
  );

  const p3 = await api('PUT', `/articles/${state.articleX}`, {
    token: state.tokenA,
    body: { title: '标签探针文一', content: '正文内容足够长。', tags: [] },
  });
  const hotAfter = await api('GET', '/tags?limit=100');
  const namesAfter = (hotAfter.data && hotAfter.data.list || []).map((t) => t.name);
  check(
    'T14',
    'PUT [] 清空关联；0 篇文章的标签不再出现在热门榜',
    p3.status === 200 && p3.data.tags.length === 0 && !namesAfter.includes(TAG_X) && !namesAfter.includes(TAG_Y),
    `articleX tags=${JSON.stringify(p3.data.tags)} 榜中残留=${namesAfter.filter((n) => n.startsWith(TAG_PREFIX)).join(',')}`
  );

  /* ---------- 其他 ---------- */

  const list = await api('GET', '/articles?pageSize=100');
  const hit = list.data.list.find((x) => x.id === state.articleZ);
  check(
    'T15',
    '广场列表项带 tags 字段（数组，含名字）',
    hit && Array.isArray(hit.tags) && hit.tags.includes(TAG_Z),
    `tags=${JSON.stringify(hit && hit.tags)}`
  );

  const drafts = await api('GET', '/users/me/drafts?pageSize=100', { token: state.tokenA });
  const draftHit = (drafts.data.list || []).find((x) => x.id === state.articleDraft);
  check(
    'T16',
    '草稿箱列表项带 tags（编辑器回填数据源）',
    draftHit && Array.isArray(draftHit.tags) && draftHit.tags.includes(TAG_X),
    `draft tags=${JSON.stringify(draftHit && draftHit.tags)}`
  );

  const c17 = await api('GET', '/tags?limit=abc');
  const c17b = await api('GET', '/tags?limit=0');
  check(
    'T17',
    'GET /tags limit 非法（非整数 / 越界）→ 40000',
    c17.status === 400 && c17.code === 40000 && c17b.status === 400 && c17b.code === 40000,
    `abc=${c17.code} zero=${c17b.code}`
  );

  const c18 = await api('GET', '/tags');
  check(
    'T18',
    'GET /tags 无需登录（公开接口，无 token 可访问）',
    c18.status === 200 && Array.isArray(c18.data.list),
    `status=${c18.status}`
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
      createdArticleIds,
      TAG_PREFIX
    );
    console.log(
      `\n清理：标签关联 ${cleaned.links} 条 / 标签 ${cleaned.tags} 个 / 版本 ${cleaned.revisions} 条 / 文章 ${cleaned.articles} 篇（仅本趟创建 ${createdArticleIds.length} 篇）/ 探针账号 ${cleaned.users} 个`
    );

    // 安全自检：① 本趟创建的实体（文章/标签）必须全部物理消失；② articles 全表行数只增不减。
    if (articleCountStart !== null) {
      const prisma = await getPrisma();
      const leftArticles = await prisma.article.findMany({ where: { id: { in: createdArticleIds } }, select: { id: true } });
      const leftTags = await prisma.tag.findMany({ where: { name: { startsWith: TAG_PREFIX } }, select: { id: true } });
      const articleCountEnd = await prisma.article.count();
      await prisma.$disconnect();
      prismaClient = null;
      console.log(`articles 全表行数：跑前 ${articleCountStart} → 跑后 ${articleCountEnd}（本趟创建 ${createdArticleIds.length} 篇）`);
      if (leftArticles.length > 0 || leftTags.length > 0) {
        console.error(
          `FAIL-SAFE | 本趟创建的实体未清干净：articles 残留 ${JSON.stringify(leftArticles.map((a) => a.id))} / tags 残留 ${JSON.stringify(leftTags.map((t) => t.id))}`
        );
        exitCode = 1;
      }
      if (articleCountEnd < articleCountStart) {
        console.error(`FAIL-SAFE | articles 全表行数下降（${articleCountStart} → ${articleCountEnd}），疑似误删库内既有数据！`);
        exitCode = 1;
      }
    }
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== probe-tag 结果：${passed}/${results.length} 通过，exit=${exitCode} =====`);

process.exit(exitCode);
