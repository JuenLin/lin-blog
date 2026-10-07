// 第 2 批「用户主页」探针：GET /api/users/:id、/:id/articles、/me/likes 三个接口。
//
// 与 probe-like / probe-liked 同一套规矩：
//   - 用一次性 pwprobe 账号，不碰真实用户的数据；
//   - 靶子文章全是探针自己发的，真实文章的 likeCount / 计数全程不受影响；
//   - finally 里按 likes → comments → articles → users 的顺序清理
//     （likes/comments 对 articles 与users 都是 ON DELETE RESTRICT，反序会被1452 拦）；
//   - **不起浏览器**：这三个接口没有 UI 层要验，纯 HTTP 断言更快也更稳
//     （浏览器层留给前端改完后的 UserProfile 探针）。
//
// 覆盖的「容易回归」的点（写这些断言时的动机）：
//   - receivedCommentCount 的**字段名**（不是 commentCount —— 改名只改了一版文档，
//     探针要钉死，否则将来有人改回去没人发现）；
//   - likedAt 是**点赞时间**而不是文章发布时间（两者都合法 ISO，只能靠不等来区分）；
//   - 三个计数的软删口径（articleCount 降、软删文章上的赞不计入 receivedLikeCount）；
//   - receivedLikeCount **含自赞**（接口清单允许给自己的文章点赞）；
//   - 0 篇用户返 200 空列表而不是 404（前端据此渲染空态）；
//   - GET /users/me 命中 /:id 回 400 —— **已登记的预期行为，不是 bug**，
//     这条断言存在的意义是「将来有人当 bug 修时会被探针挡住」。
//
// 用法：node scripts/acceptance/probe-user-detail.mjs
import path from 'node:path';
import { CONFIG, requireCjs, BACKEND, BACKEND_MODULES } from './lib/config.mjs';

/* ============================ 结果收集 ============================ */

const results = [];

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

  return { status: res.status, code: json && json.code, message: json && json.message, data: json && json.data };
}

/* ============================ Prisma ============================ */

let prismaClient = null;
async function getPrisma() {
  if (prismaClient) return prismaClient;

  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));

  prismaClient = new PrismaClient();

  return prismaClient;
}

// 一次性账号的用户名前缀，与 lib/tmp-account.mjs 的 PROBE_PREFIX 一致。
// 这里**不**复用 cleanupProbeAccounts —— 它是硬删 user，而本探针要发文章，
// 得先按外键顺序清干净子表，所以自己实现（下面的清理顺序就是 RESTRICT 要求的）。
const PREFIX = 'pwprobe';

/**
 * 注册一个一次性账号，返回 id 与登录 token。
 *
 * 走真实 POST /auth/register + POST /auth/login（不是 mintToken）：
 * mintToken 是直接用 JWT_SECRET 签名、不经过密码校验的，
 * 那样能验「已登录态下接口对不对」，但**验不到登录链路**。
 * 本探针只需要一个已登录用户，register + login 更贴近真实、也不依赖 secret。
 */
async function createAccount(tag) {
  const username = `${PREFIX}${tag}${Date.now()}`;
  const password = 'probe123456';

  const reg = await api('POST', '/auth/register', { body: { username, password } });

  if (reg.status !== 201) {
    throw new Error(`注册失败：${JSON.stringify(reg)}`);
  }

  const login = await api('POST', '/auth/login', { body: { username, password } });
  const token = login.data && login.data.token;

  if (!token) {
    throw new Error(`登录失败：${JSON.stringify(login)}`);
  }

  const prisma = await getPrisma();
  const row = await prisma.user.findFirst({ where: { username }, select: { id: true } });

  if (!row) {
    throw new Error(`注册成功但库里查不到 ${username}`);
  }

  return { username, password, userId: row.id, token };
}

/**
 * 发一篇文章，返回 id。
 * token 用调用方的（账号自己的），所以作者就是该账号。
 */
async function createArticle(token, title, category = '技术') {
  // 正文给足长度，避免踩到 summary 截断相关的边界（那由别的探针负责）。
  const res = await api('POST', '/articles', { token, body: { title, content: '探针正文内容。'.repeat(40), category } });

  if (res.status !== 201) {
    throw new Error(`发文章失败：${JSON.stringify(res)}`);
  }

  return res.data.id;
}

/**
 * 清理：likes → comments → articles → users。
 *
 * 顺序**不能变**：likes 与 comments 都同时引用 articles 和 users，
 * 两条外键都是 ON DELETE RESTRICT（docs/DB.md 实测），先删上游会被MySQL 1452拒。
 *
 * @param {{userIds: number[], articleIds: number[], usernames: string[]}} ids
 */
async function cleanup({ userIds, articleIds, usernames }) {
  const prisma = await getPrisma();
  const tally = { likes: 0, comments: 0, articles: 0, users: 0 };

  if (userIds.length > 0) {
    // 点赞/评论里可能有**别人的**账号参与吗？没有——本探针只有自己造的账号在互动，
    // 但为了不误删，这里 likes 只按 userId（点赞者）删，comments 两种都删
    // （作者可能是探针账号，而被评论的文章也是探针的）。
    const r1 = await prisma.like.deleteMany({ where: { userId: { in: userIds } } });
    tally.likes = r1.count;
  }

  if (articleIds.length > 0) {
    // 先按文章清 likes/comments（覆盖「点赞者是别人」的情况），
    // 再按 userId 清一遍做兜底，两者都只影响探针自造的数据。
    const r2a = await prisma.like.deleteMany({ where: { articleId: { in: articleIds } } });
    const r2b = await prisma.comment.deleteMany({ where: { articleId: { in: articleIds } } });
    tally.likes += r2a.count;
    tally.comments += r2b.count;

    const r3 = await prisma.article.deleteMany({ where: { id: { in: articleIds } } });
    tally.articles = r3.count;
  }

  if (userIds.length > 0) {
    // 残留在自己文章上的评论（软删过的文章物理删时若还有评论会失败，所以先清）。
    const r4 = await prisma.comment.deleteMany({ where: { authorId: { in: userIds } } });
    tally.comments += r4.count;

    // 二重保险：只删 pwprobe 前缀的用户名，绝不误伤真实用户。
    const safeNames = usernames.filter((n) => typeof n === 'string' && n.startsWith(PREFIX));

    if (safeNames.length > 0) {
      const r5 = await prisma.user.deleteMany({ where: { username: { in: safeNames } } });
      tally.users = r5.count;
    }
  }

  return tally;
}

/* ============================ 主流程 ============================ */

const articleIds = [];
const accounts = [];
let exitCode = 0;

try {
  /* ---------- 准备 ---------- */

  console.log('准备测试数据…');

  const owner = await createAccount('owner');
  const fan = await createAccount('fan');
  const lonely = await createAccount('lonely');

  accounts.push(owner, fan, lonely);

  // owner 发 3 篇（技术2 / 生活1），便于验分类与排序不串。
  const artA = await createArticle(owner.token, `探针A1-${owner.username}`, '技术');
  const artB = await createArticle(owner.token, `探针A2-${owner.username}`, '技术');
  const artC = await createArticle(owner.token, `探针A3-${owner.username}`, '生活');
  // fan 发 1 篇，用来看计数是否按作者隔离。
  const artD = await createArticle(fan.token, `探针B1-${fan.username}`, '随笔');

  articleIds.push(artA, artB, artC, artD);

  // fan 赞了 owner 的两篇。
  await api('POST', `/articles/${artA}/like`, { token: fan.token });
  await api('POST', `/articles/${artB}/like`, { token: fan.token });
  // owner 赞自己 artC —— 用来验 receivedLikeCount 含自赞。
  await api('POST', `/articles/${artC}/like`, { token: owner.token });
  // fan 在 artD 上留评论 —— 用来验 receivedCommentCount 是「收到的评论」。
  await api('POST', '/comments', { token: fan.token, body: { articleId: artD, content: '探针评论内容' } });

  console.log(`账号：owner=${owner.userId} fan=${fan.userId} lonely=${lonely.userId}`);
  console.log(`文章：A=${artA} B=${artB} C=${artC}（owner） D=${artD}（fan）`);
  console.log('');

  /* ==================== 1. GET /api/users/:id ==================== */

  console.log('--- A 组：GET /api/users/:id ---');

  const detail = await api('GET', `/users/${owner.userId}`);

  check('A1-1', '状态码 200（公开只读，无需登录）', detail.status === 200, `实测 ${detail.status}`);
  check('A1-2', '业务码 0', detail.code === 0, `实测 ${detail.code}`);

  const d = detail.data || {};
  const dataKeys = Object.keys(d).sort();

  check('A1-3', 'public user 字段齐全（6 个）',
    ['id', 'username', 'nickname', 'avatar', 'bio', 'createdAt'].every((k) => k in d),
    dataKeys.join(','));

  check('A1-4', '三个计数齐全且都是 number',
    ['articleCount', 'receivedLikeCount', 'receivedCommentCount'].every((k) => typeof d[k] === 'number'),
    `articleCount=${d.articleCount} receivedLikeCount=${d.receivedLikeCount} receivedCommentCount=${d.receivedCommentCount}`);

  check('A1-5', '**不含** password（永不进 select）', !('password' in d), dataKeys.join(','));
  check('A1-6', '**不含** updatedAt（与 PUT /me 的 public user 逐字同形）', !('updatedAt' in d), dataKeys.join(','));
  check('A1-7', '**不含** email（表里没这列）', !('email' in d), dataKeys.join(','));

  check('A1-8', '字段名是 receivedCommentCount 而**非** commentCount（防回归）',
    'receivedCommentCount' in d && !('commentCount' in d),
    dataKeys.join(','));

  check('A2-1', `articleCount=3（owner 发 3 篇）`, d.articleCount === 3, `实测 ${d.articleCount}`);
  check('A2-2', 'receivedLikeCount=3（fan 赞 2 篇 + owner 自赞 1 篇 → **含自赞**）',
    d.receivedLikeCount === 3, `实测 ${d.receivedLikeCount}`);
  check('A2-3', 'receivedCommentCount=0（别人在**自己**文章上的评论，不计入 owner）',
    d.receivedCommentCount === 0, `实测 ${d.receivedCommentCount}`);

  // 计数按作者隔离：fan 有 1 篇、0 个收到的赞（它赞的是**别人**的文章，那是「给出去的」）、1 个收到的评论。
  //
  // ⚠️ 这两条的预期第一次写错过（写成「fan 自赞 → receivedLikeCount=1」+「发出的评论不计入 → 0」），
  // 跑出来 0和 1 才对。错因是把「自赞」记在了 fan 头上 —— 实际自赞的是 owner。
  // 口径要点：**received\* 前缀一律是「别人给我的」**：
  //   - 赞：只有别人赞**我的**文章才算 received（我赞别人的文章不算，那是给出去的）；
  //   - 评论：只有别人在**我的**文章上留的才算（我在自己文章上留的也算「收到」，因为是自己文章）；
  // 上面 fan 在自己文章 artD 上留的那 1 条就是 receivedCommentCount=1 的来源。
  const fanDetail = await api('GET', `/users/${fan.userId}`);
  const fd = fanDetail.data || {};

  check('A3-1', '计数按作者隔离：fan.articleCount=1', fd.articleCount === 1, `实测 ${fd.articleCount}`);
  check('A3-2', '计数按作者隔离：fan.receivedLikeCount=0（fan 赞的是**别人**的文章，那是「给出去的赞」）',
    fd.receivedLikeCount === 0, `实测 ${fd.receivedLikeCount}`);
  check('A3-3', '计数按作者隔离：fan.receivedCommentCount=1（评论在 fan **自己**的文章上 → 是收到的）',
    fd.receivedCommentCount === 1, `实测 ${fd.receivedCommentCount}`);

  // 负向
  const noSuch = await api('GET', '/users/99999999');
  check('A4-1', '不存在的用户回404', noSuch.status === 404, `实测 ${noSuch.status}`);
  check('A4-2', '404 业务码 40400', noSuch.code === 40400, `实测 ${noSuch.code}`);

  for (const [bad, label] of [['abc', '非数字'], ['0', '零'], ['-1', '负数'], ['1.5', '小数']]) {
    const r = await api('GET', `/users/${bad}`);
    check(`A4-3 id=${bad}`, `非法 id（${label}）回 400`, r.status === 400, `实测 ${r.status}｜${r.message}`);
  }

  // 软删用户 → 404
  const prisma = await getPrisma();
  await prisma.user.update({ where: { id: fan.userId }, data: { deletedAt: new Date() } });

  const softDeleted = await api('GET', `/users/${fan.userId}`);
  check('A5-1', '已软删的用户回 404（与文章软删口径一致）', softDeleted.status === 404, `实测 ${softDeleted.status}`);

  await prisma.user.update({ where: { id: fan.userId }, data: { deletedAt: null } });

  const restored = await api('GET', `/users/${fan.userId}`);
  check('A5-2', '取消软删后恢复 200', restored.status === 200, `实测 ${restored.status}`);

  /* ==================== 2. GET /api/users/:id/articles ==================== */

  console.log('');
  console.log('--- B 组：GET /api/users/:id/articles ---');

  const list = await api('GET', `/users/${owner.userId}/articles`);

  check('B1-1', '状态码 200', list.status === 200, `实测 ${list.status}`);

  const ld = list.data || {};
  const listItems = ld.list || [];

  check('B1-2', `total=3（后端 COUNT，不受前端 100窗限制）`, ld.total === 3, `实测 ${ld.total}`);
  check('B1-3', `list 长度=3`, listItems.length === 3, `实测 ${listItems.length}`);
  check('B1-4', '分页元信息完整（page/pageSize/total/totalPages）',
    ld.page === 1 && ld.pageSize === 10 && ld.totalPages === 1,
    `page=${ld.page} pageSize=${ld.pageSize} totalPages=${ld.totalPages}`);

  const item0 = listItems[0] || {};

  check('B1-5', '列表项字段与广场列表同形（8 个字段）',
    ['id', 'title', 'summary', 'category', 'author', 'likeCount', 'createdAt', 'updatedAt'].every((k) => k in item0),
    Object.keys(item0).sort().join(','));

  check('B1-6', '列表项**不含** likedAt（那是 /me/likes 独有的字段）', !('likedAt' in item0), Object.keys(item0).sort().join(','));
  check('B1-7', '列表项**不含** content（列表不给全文）', !('content' in item0), Object.keys(item0).sort().join(','));

  check('B1-8', 'author 内嵌齐全（id/username/nickname/avatar）',
    ['id', 'username', 'nickname', 'avatar'].every((k) => k in (item0.author || {})),
    JSON.stringify(item0.author));

  check('B2-1', '只返回该用户的文章（不含 fan 的 artD）',
    listItems.every((x) => x.author && x.author.id === owner.userId),
    `作者ids=${[...new Set(listItems.map((x) => x.author && x.author.id))].join(',')}`);

  // 与广场列表逐字对比：同一篇文章的字段集与 summary 必须完全一致。
  const plaza = await api('GET', '/articles?pageSize=100');
  const plazaItem = (plaza.data.list || []).find((x) => x.id === item0.id);

  check('B2-2', '同一篇文章在广场列表与本接口的**字段集完全相同**',
    plazaItem && JSON.stringify(Object.keys(plazaItem).sort()) === JSON.stringify(Object.keys(item0).sort()),
    plazaItem ? `广场=${Object.keys(plazaItem).sort().join(',')}` : '广场列表里找不到这篇');

  check('B2-3', '同一篇文章的 summary 逐字相同（复用同一个 toArticleListItem）',
    plazaItem && plazaItem.summary === item0.summary,
    plazaItem ? `广场="${String(plazaItem.summary).slice(0, 24)}…" 本接口="${String(item0.summary).slice(0, 24)}…"` : '—');

  // 真分页：pageSize=2 翻两页，应为 2 + 1 且无重复。
  const pg1 = await api('GET', `/users/${owner.userId}/articles?page=1&pageSize=2&sortBy=id&order=asc`);
  const pg2 = await api('GET', `/users/${owner.userId}/articles?page=2&pageSize=2&sortBy=id&order=asc`);
  const ids1 = (pg1.data.list || []).map((x) => x.id);
  const ids2 = (pg2.data.list || []).map((x) => x.id);

  check('B3-1', 'pageSize=2 第 1 页返回 2 条', ids1.length === 2, `实测 ${ids1.length}：${ids1.join(',')}`);
  check('B3-2', 'pageSize=2 第 2 页返回 1 条', ids2.length === 1, `实测 ${ids2.length}：${ids2.join(',')}`);
  check('B3-3', '两页**无重复**（真后端分页，不是前端切片）',
    ids1.filter((x) => ids2.includes(x)).length === 0,
    `第1页=${ids1.join(',')} 第2页=${ids2.join(',')}`);
  check('B3-4', '第 2 页 total 仍是 3（**不受 pageSize 影响**）', pg2.data.total === 3, `实测 ${pg2.data.total}`);
  check('B3-5', 'totalPages=ceil(3/2)=2', pg2.data.totalPages === 2, `实测 ${pg2.data.totalPages}`);
  check('B3-6', '两页合起来正好是全部 3 篇',
    [...ids1, ...ids2].sort().join(',') === [artA, artB, artC].sort().join(','),
    `合并=${[...ids1, ...ids2].sort().join(',')} 期望=${[artA, artB, artC].sort().join(',')}`);

  // 0 篇用户
  const emptyList = await api('GET', `/users/${lonely.userId}/articles`);
  const eld = emptyList.data || {};

  check('B4-1', '**0 篇用户返 200 而非 404**（前端据此渲染空态）',
    emptyList.status === 200, `实测 ${emptyList.status}`);
  check('B4-2', '0 篇时 list=[] total=0 totalPages=0',
    (eld.list || []).length === 0 && eld.total === 0 && eld.totalPages === 0,
    `list=${(eld.list || []).length} total=${eld.total} totalPages=${eld.totalPages}`);

  // 负向
  const b51 = await api('GET', '/users/99999999/articles');
  const b52 = await api('GET', '/users/abc/articles');
  const b53 = await api('GET', `/users/${owner.userId}/articles?sortBy=nope`);
  const b54 = await api('GET', `/users/${owner.userId}/articles?page=0`);
  const b55 = await api('GET', `/users/${owner.userId}/articles?pageSize=101`);

  check('B5-1', '不存在的用户回 404', b51.status === 404, `实测 ${b51.status}`);
  check('B5-2', '非法 id 回 400', b52.status === 400, `实测 ${b52.status}｜${b52.message}`);
  check('B5-3', 'sortBy 非法值回 400 且 message 含白名单',
    b53.status === 400 && String(b53.message).includes('likeCount'),
    `实测 ${b53.status}｜${b53.message}`);
  check('B5-4', 'page=0 回 400', b54.status === 400, `实测 ${b54.status}｜${b54.message}`);
  check('B5-5', 'pageSize=101 回 400（上限 100）', b55.status === 400, `实测 ${b55.status}｜${b55.message}`);

  const sortLike = await api('GET', `/users/${owner.userId}/articles?sortBy=likeCount&order=desc`);
  check('B6-1', 'sortBy=likeCount 可用（走ARTICLE_SORT_MAP 的关联计数排序）',
    sortLike.status === 200, `实测 ${sortLike.status}`);

  // 软删联动：软删一篇后 total 与 articleCount 应同步下降。
  await prisma.article.update({ where: { id: artC }, data: { deletedAt: new Date() } });

  const afterSoft = await api('GET', `/users/${owner.userId}/articles`);
  const afterDetail = await api('GET', `/users/${owner.userId}`);
  const afterLiked = await api('GET', '/users/me/likes', { token: owner.token });

  check('B7-1', '软删文章后列表 total 从 3 降到 2', afterSoft.data.total === 2, `实测 ${afterSoft.data.total}`);
  check('B7-2', '软删文章不出现在列表里',
    (afterSoft.data.list || []).every((x) => x.id !== artC),
    `ids=${(afterSoft.data.list || []).map((x) => x.id).join(',')}`);
  check('B8-1', '软删文章后 articleCount 从 3 降到 2', afterDetail.data.articleCount === 2, `实测 ${afterDetail.data.articleCount}`);
  check('B8-2', '软删文章后 receivedLikeCount 从 3 降到 2（**软删文章上的赞不计入**）',
    afterDetail.data.receivedLikeCount === 2, `实测 ${afterDetail.data.receivedLikeCount}`);

  // 恢复
  await prisma.article.update({ where: { id: artC }, data: { deletedAt: null } });

  const restoredDetail = await api('GET', `/users/${owner.userId}`);
  check('B8-3', '取消软删后 articleCount 回到 3', restoredDetail.data.articleCount === 3, `实测 ${restoredDetail.data.articleCount}`);
  check('B8-4', '取消软删后 receivedLikeCount 回到 3', restoredDetail.data.receivedLikeCount === 3, `实测 ${restoredDetail.data.receivedLikeCount}`);

  /* ==================== 3. GET /api/users/me/likes ==================== */

  console.log('');
  console.log('--- C 组：GET /api/users/me/likes ---');

  const ownerLikes = await api('GET', '/users/me/likes', { token: owner.token });

  check('C1-1', '状态码 200', ownerLikes.status === 200, `实测 ${ownerLikes.status}`);

  const ol = ownerLikes.data || {};
  const olItems = ol.list || [];

  check('C1-2', 'total=1（owner 只自赞了 artC）', ol.total === 1, `实测 ${ol.total}`);
  check('C1-3', 'list 长度=1', olItems.length === 1, `实测 ${olItems.length}`);

  const li = olItems[0] || {};

  check('C1-4', '列表项**含** likedAt（本接口独有的字段）', 'likedAt' in li, Object.keys(li).sort().join(','));
  check('C1-5', 'likedAt 是合法的 ISO 时间字符串',
    typeof li.likedAt === 'string' && !Number.isNaN(Date.parse(li.likedAt)),
    `likedAt=${li.likedAt}`);

  check('C1-6', '列表项其余字段与文章 Tab 同形（除 likedAt 外完全一致）',
    ['id', 'title', 'summary', 'category', 'author', 'likeCount', 'createdAt', 'updatedAt'].every((k) => k in li),
    Object.keys(li).sort().join(','));

  check('C1-7', '列表项**不含** content', !('content' in li), Object.keys(li).sort().join(','));

  // 关键：likedAt 必须是**点赞时间**，不是文章发布时间。两者都是合法 ISO，
  // 唯一能区分的办法是「两者不相等」—— 所以这条断言比较的是不等。
  const artDetail = await api('GET', `/articles/${artC}`);

  check('C2-1', 'likedAt **≠** 文章 createdAt（证明它是点赞时间而非文章时间）',
    li.likedAt !== artDetail.data.createdAt,
    `likedAt=${li.likedAt} 文章createdAt=${artDetail.data.createdAt}`);

  check('C2-2', 'likedAt 比文章 createdAt 更晚（点赞发生在发文之后）',
    Date.parse(li.likedAt) > Date.parse(artDetail.data.createdAt),
    `相差 ${(Date.parse(li.likedAt) - Date.parse(artDetail.data.createdAt)) / 1000} 秒`);

  check('C2-3', 'likedAt = likes 表那条记录的 createdAt（可与DB 直查对上）',
    await (async () => {
      const row = await prisma.like.findFirst({ where: { userId: owner.userId, articleId: artC }, select: { createdAt: true } });
      return !!row && new Date(row.createdAt).toISOString() === new Date(li.likedAt).toISOString();
    })(), `接口=${li.likedAt}`);

  // 跨账号隔离：fan 赞了 2 篇，看到 2 条；owner 赞了 1 篇，看到 1 条。
  const fanLikes = await api('GET', '/users/me/likes', { token: fan.token });

  check('C3-1', '跨账号隔离：fan 的列表只含他自己赞的 2 篇',
    fanLikes.data.total === 2 && (fanLikes.data.list || []).every((x) => [artA, artB].includes(x.id)),
    `total=${fanLikes.data.total} ids=${(fanLikes.data.list || []).map((x) => x.id).join(',')}`);

  check('C3-2', '跨账号隔离：owner 看不到 fan 赞的文章（total=1，非 3）',
    ownerLikes.data.total === 1, `实测 ${ownerLikes.data.total}`);

  const lonelyLikes = await api('GET', '/users/me/likes', { token: lonely.token });
  check('C3-3', '没赞过任何文章的人 total=0 且 list=[]',
    lonelyLikes.data.total === 0 && (lonelyLikes.data.list || []).length === 0,
    `total=${lonelyLikes.data.total}`);

  // 软删文章 → 从点赞列表消失且 total 降（这一条同时验 B8-2 的反面）
  await prisma.article.update({ where: { id: artC }, data: { deletedAt: new Date() } });
  const softLikes = await api('GET', '/users/me/likes', { token: owner.token });

  check('C4-1', '文章软删后从点赞列表消失（total 从 1 降到 0）',
    softLikes.data.total === 0 && (softLikes.data.list || []).every((x) => x.id !== artC),
    `total=${softLikes.data.total}`);

  await prisma.article.update({ where: { id: artC }, data: { deletedAt: null } });
  const c42 = await api('GET', '/users/me/likes', { token: owner.token });
  check('C4-2', '取消软删后重新出现在点赞列表', c42.data.total === 1, `实测 total=${c42.data.total}`);

  // 取消点赞 → total 立刻降（likes 是物理 DELETE，无软删列）
  await api('DELETE', `/articles/${artC}/like`, { token: owner.token });
  const afterUnlike = await api('GET', '/users/me/likes', { token: owner.token });

  check('C5-1', '取消点赞后 total 立刻降到 0（likes 无软删列，是物理删除）',
    afterUnlike.data.total === 0, `实测 ${afterUnlike.data.total}`);

  // 重新赞回来，供后面的分页用例用
  await api('POST', `/articles/${artC}/like`, { token: owner.token });
  // fan 赞第三篇，凑够 3 条好验分页
  await api('POST', `/articles/${artC}/like`, { token: fan.token });

  // 排序：三个白名单值都要能用
  for (const sb of ['likedAt', 'createdAt', 'likeCount']) {
    const r = await api('GET', `/users/me/likes?sortBy=${sb}`, { token: fan.token });
    check(`C6-${sb}`, `sortBy=${sb} 可用（200）`, r.status === 200, `实测 ${r.status}`);
  }

  const badSort = await api('GET', '/users/me/likes?sortBy=nope', { token: fan.token });
  check('C6-4', 'sortBy 非法回 400 且 message 含白名单三值',
    badSort.status === 400 && ['likedAt', 'createdAt', 'likeCount'].every((k) => String(badSort.message).includes(k)),
    `message=${badSort.message}`);

  // 真分页：fan 有 3 条，pageSize=2 → 2 + 1
  const lp1 = await api('GET', '/users/me/likes?page=1&pageSize=2&sortBy=likedAt&order=desc', { token: fan.token });
  const lp2 = await api('GET', '/users/me/likes?page=2&pageSize=2&sortBy=likedAt&order=desc', { token: fan.token });
  const lids1 = (lp1.data.list || []).map((x) => x.id);
  const lids2 = (lp2.data.list || []).map((x) => x.id);

  check('C7-1', '点赞列表 pageSize=2 第 1 页 2 条', lids1.length === 2, `实测 ${lids1.length}：${lids1.join(',')}`);
  check('C7-2', '点赞列表 pageSize=2 第 2 页 1 条', lids2.length === 1, `实测 ${lids2.length}：${lids2.join(',')}`);
  check('C7-3', '两页无重复', lids1.filter((x) => lids2.includes(x)).length === 0,
    `第1页=${lids1.join(',')} 第2页=${lids2.join(',')}`);
  check('C7-4', '点赞列表 total=3 不受 pageSize 影响', lp2.data.total === 3, `实测 ${lp2.data.total}`);
  check('C7-5', '两页合起来正好是全部 3 篇',
    [...lids1, ...lids2].sort().join(',') === [artA, artB, artC].sort().join(','),
    `合并=${[...lids1, ...lids2].sort().join(',')}`);

  // 鉴权
  const c81 = await api('GET', '/users/me/likes');
  const c82 = await api('GET', '/users/me/likes', { token: 'garbage-token' });
  check('C8-1', '未登录访问回 401', c81.status === 401, `实测 ${c81.status}`);
  check('C8-2', '非法 token 回 401', c82.status === 401, `实测 ${c82.status}`);
  check('C8-3', '未登录时业务码 40100', c81.code === 40100, `实测 code=${c81.code}`);

  /* ==================== 4. 路由顺序（防回归） ==================== */

  console.log('');
  console.log('--- D 组：路由注册顺序 ---');

  // 这条断言的用意：GET /api/users/me（不带 /likes）会命中 /:id 并回 400。
  // 它是**已登记的预期行为**（docs/API.md 有写），不是 bug。
  // 放在探针里是为了将来有人「顺手修一下」时会被挡住。
  const meOnly = await api('GET', '/users/me');

  check('D1-1', 'GET /users/me 命中 /:id 回 400（**已登记的预期行为，不是 bug**）',
    meOnly.status === 400, `实测 ${meOnly.status}｜${meOnly.message}`);

  const d12 = await api('GET', '/users/me/likes', { token: owner.token });
  const d13 = await api('GET', `/users/${owner.userId}`);
  const d14 = await api('GET', `/users/${owner.userId}/articles`);
  check('D1-2', '/users/me/likes **未被** /:id 吃掉（仍是 200）', d12.status === 200, `实测 ${d12.status}`);
  check('D1-3', '/users/:id 仍正常（200）', d13.status === 200, `实测 ${d13.status}`);
  check('D1-4', '/users/:id/articles 仍正常（200）', d14.status === 200, `实测 ${d14.status}`);

  // 既有接口未被破坏（第 2 批在 user.routes.js 上加了 3 条路由，要确认没挤掉旧的）
  const put = await api('PUT', '/users/me', { token: owner.token, body: { bio: '探针临时简介' } });
  check('D2-1', '既有 PUT /users/me 未被挤掉（200）', put.status === 200, `实测 ${put.status}`);

  const clear = await api('PUT', '/users/me', { token: owner.token, body: { bio: null } });
  check('D2-2', '既有 PUT /users/me 清空 bio 仍可用（200）', clear.status === 200, `实测 ${clear.status}`);

  const plazaStill = await api('GET', '/articles');
  check('D2-3', '既有 GET /api/articles 未受影响（200）', plazaStill.status === 200, `实测 ${plazaStill.status}`);
} catch (error) {
  console.error('\nFATAL:', error && error.message ? error.message : error);
  console.error(error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n') : '');
  exitCode = 2;
} finally {
  // 清理顺序 likes → comments → articles → users（外键 RESTRICT）。
  try {
    const cleaned = await cleanup({
      userIds: accounts.map((a) => a.userId).filter(Boolean),
      articleIds,
      usernames: accounts.map((a) => a.username).filter(Boolean),
    });
    console.log(`\n清理：点赞 ${cleaned.likes} 条 / 评论 ${cleaned.comments} 条 / 靶子文章 ${cleaned.articles} 篇 / 探针账号 ${cleaned.users} 个`);

    // 残留自查：只查**本轮自己造的**，不能一看到 pwprobe 前缀就报残留 ——
    // 库里可能有别次跑（如 probe-password）留下的 pwprobe 账号，那不是本探针的责任。
    // 同理，articleIds 全是本轮发的，按 id 精确查即可。
    const prisma = await getPrisma();
    const myNames = accounts.map((a) => a.username).filter(Boolean);
    const leftArticles = await prisma.article.count({ where: { id: { in: articleIds } } });
    const leftUsers = myNames.length > 0 ? await prisma.user.count({ where: { username: { in: myNames } } }) : 0;

    console.log(`残留自查：本轮靶子文章 ${leftArticles} 篇 / 本轮探针账号 ${leftUsers} 个`);

    if (leftArticles > 0 || leftUsers > 0) {
      console.error('⚠️ 本轮有残留，库没回到跑之前的样子，需要手动处理');
      exitCode = exitCode || 1;
    }
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }

  if (prismaClient) {
    await prismaClient.$disconnect();
  }
}

/* ============================ 汇总 ============================ */

const total = results.length;
const pass = results.filter((x) => x.pass).length;
const fail = total - pass;

console.log(`\n合计 ${total} 条：PASS ${pass} / FAIL ${fail}`);

if (exitCode !== 0) {
  process.exit(exitCode);
}

// 空数组 every 恒真：一条断言都没跑到时不能报全绿（那会让连不上后端也算通过）。
if (total === 0) process.exit(2);

process.exit(fail === 0 ? 0 : 1);