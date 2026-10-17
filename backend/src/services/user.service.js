import prisma from '../utils/prisma.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { CODE, httpError } from '../utils/response.js';
import { hasField } from '../validators/user.validator.js';
import { deleteLocalAvatar, deleteUploadedFile, toAvatarUrl } from './upload.service.js';
import {
  toArticleListItem,
  ARTICLE_DETAIL_SELECT,
  ARTICLE_SORT_MAP,
  ARTICLE_SORT_FIELDS,
} from './article.service.js';

// 对外返回的 user 字段。
// **与 validators/user.validator.js 的 forbiddenIdentityFields 是两回事**：
// 那里管的是「请求体不许传什么」，这里管的是「响应体返回什么」。
// 两者刻意都包含 username / nickname，因为它们都是公开信息；
// 但 password 永远不出现在这里，也永远不进 select。
const PUBLIC_FIELDS = {
  id: true,
  username: true,
  nickname: true,
  avatar: true,
  bio: true,
  role: true,
  createdAt: true,
};

// 点赞 Tab 的 sortBy 白名单（docs/API.md GET /api/users/me/likes）。
// 默认 likedAt desc（最近点赞的在前）；前端 Tab **不暴露排序控件**，
// 其余两项是给探针与将来用的，与 GET /api/articles 保留 updatedAt 同一做法。
const LIKED_SORT_FIELDS = ['likedAt', 'createdAt', 'likeCount'];

// likedAt / createdAt / likeCount 三个 API 字段名 → Prisma orderBy 片段。
//
// 注意 likedAt 这一项：它是**API 层虚拟名**，likes 表里的列叫 created_at
// （Prisma 侧 createdAt），直接 orderBy { likedAt } 会报 Invalid（实测）。
// 而这里的 `{ createdAt: order }` 因为查询主模型是 Like，解析到的是
// **likes.createdAt**（点赞时间），正是我们要的语义 —— 不是 articles.createdAt。
//
// likeCount 是文章的赞数（计算字段，articles 表无此列），必须走关联计数排序
// { article: { likes: { _count: order } } }，与广场列表的 ARTICLE_SORT_MAP 同机制。
// 若写成 { likes: { _count } } 会把 likes 当成 Like 模型上的关系 —— 报 Invalid。
const LIKED_SORT_MAP = {
  // likedAt 必须显式列在这里：buildOrderBy 只对「map 里有构造器」的字段做翻译，
  // 缺了这一项它会 fallback 成 { likedAt: order } 直传 Prisma →
  // 实测报 Unknown argument `likedAt`（likes 表没有这一列）→ 500。
  // 目标列是 likes.createdAt（点赞时间），不是 articles.createdAt。
  likedAt: (order) => ({ createdAt: order }),
  createdAt: (order) => ({ article: { createdAt: order } }),
  likeCount: (order) => ({ article: { likes: { _count: order } } }),
};

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    avatar: user.avatar,
    bio: user.bio,
    role: user.role,
    createdAt: user.createdAt,
  };
}

/**
 * 修改当前用户的资料（头像 / 简介）。对应 docs/API.md 的 PUT /api/users/me。
 *
 * 身份完全来自 token 的 userId，请求体里的 id / userId / username / password
 * 已由 validators/user.validator.js 拦掉，这里不再考虑。
 *
 * ## 三态语义（本函数的核心）
 * 靠 **hasOwnProperty 判断键是否出现**，而不是判断值：
 *   - 键不出现→ 不把这个字段放进 update.data，Prisma 就不碰这一列
 *   - 键出现且值为 null → 写入 null，即清空该列
 *   - 键出现且值为字符串 → 写入该字符串
 *
 * 为什么不写成 `if (avatar) ...` 之类：
 *   ① `if (avatar)` 会把「空串」和「没传」混为一谈；
 *   ② 用 `avatar !== undefined` 判断同样有坑——zod 的 .optional() 会把
 *      「键缺失」和「键存在但值为 undefined」都归一成 undefined，
 *      于是「显式传 undefined」会被误当成「不改」，而「没传 avatar」
 *      在某些写法下又会被误当成清空。hasOwnProperty 是唯一可靠判据。
 *
 * 空串处理：bio 传 '' 时视为「清空」（docs/API.md 规定），
 * 统一转成 null 存储，不接受「空字符串」这种状态。
 *
 * ## 旧头像文件的清理（第十一批引入）
 * 若本次改动了 avatar，且**旧值是站内路径**（`/uploads/` 开头），写库成功后把旧文件删掉。
 * 顺序是**先写库、再删文件**：反过来（先删后写）一旦写库失败，用户就彻底没头像了；
 * 前者删失败只留一个垃圾文件（登记在 docs/DB.md「已知限制」第 4 条），不影响正确性。
 *
 * 外链下线后，本接口的 avatar **正常只用于清空**（传 null）——设置头像统一走
 * `POST /api/users/me/avatar`（validate 仍接受 /uploads/ 前缀的字符串，是给探针与运维留的窄口）。
 * 「旧值不是 /uploads/ 开头就不删」这条判断仍然保留：它是**脏值防御**，
 * 挡的是手工改库留下的历史值（如第九批的外链），不是「外链分支」。
 *
 * @param {object} params
 * @param {number} params.userId 来自 token
 * @param {object} params.body 已通过 zod 校验的请求体
 * @returns {Promise<object>} 完整的 public user
 */
export async function updateProfile({ userId, body }) {
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id: userId }),
    // 多查一个 avatar：写库成功后要拿旧值清文件，不查就得再发一条 SQL。
    select: { id: true, avatar: true },
  });

  if (!user) {
    throw httpError(404, CODE.NOT_FOUND, '用户不存在');
  }

  const data = {};

  if (hasField(body, 'avatar')) {
    // 空串已被 validator 拒（avatar 空串要传 null），这里只需处理 null / 字符串。
    data.avatar = body.avatar ?? null;
  }

  if (hasField(body, 'bio')) {
    // '' → null：空串代表「清空简介」，与 null 同义。
    data.bio = body.bio === '' ? null : body.bio ?? null;
  }

  // data 至少有一个键（validator 的 superRefine 已保证），
  // 但仍做一次防御：万一 validator 被绕过，不至于发出空 update。
  if (Object.keys(data).length === 0) {
    throw httpError(400, CODE.PARAM_ERROR, 'avatar 与 bio 至少要传一个');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    select: PUBLIC_FIELDS,
  });

  // 写库成功后才清旧文件；改的是 bio 时 avatar 键没出现，不做任何删除。
  // 外链下线后这里的 avatar 只会是 null（清空），下面这行负责把旧文件删掉。
  if (hasField(body, 'avatar')) {
    deleteLocalAvatar(user.avatar);
  }

  return toPublicUser(updated);
}

/**
 * 上传头像：把「multer 已落盘的文件」变成 users.avatar 的站内路径并写库。
 * 对应 docs/API.md 的 POST /api/users/me/avatar。
 *
 * ## 为什么写成三个分支（而不是一个 try 包到底）
 * 磁盘与数据库之间没有事务，只能靠**补偿动作**兜底：
 *   - 用户不存在 → 文件已经落盘了，删掉，不留孤儿
 *   - 写库失败   → 同上，删掉刚落盘的文件（API.md 处理顺序第 5 步的反向操作）
 *   - 写库成功   → 删旧头像（顺序是先写库再删，理由见 updateProfile 的注释）
 *
 * 前两个分支是「回滚」，第三个是「清理」，性质不同，分开写更清楚。
 *
 * @param {object} params
 * @param {number} params.userId 来自 token
 * @param {object} params.file multer 的 file 对象（diskStorage，必有 path）
 * @returns {Promise<object>} 完整的 public user
 */
export async function updateAvatar({ userId, file }) {
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id: userId }),
    select: { id: true, avatar: true },
  });

  if (!user) {
    deleteUploadedFile(file.path);
    throw httpError(404, CODE.NOT_FOUND, '用户不存在');
  }

  const avatar = toAvatarUrl(file);

  let updated;
  try {
    updated = await prisma.user.update({
      where: { id: user.id },
      data: { avatar },
      select: PUBLIC_FIELDS,
    });
  } catch (error) {
    deleteUploadedFile(file.path);
    throw error;
  }

  deleteLocalAvatar(user.avatar);

  return toPublicUser(updated);
}

export { toPublicUser, PUBLIC_FIELDS, requireUserExists };

/* ---------- 第2 批：用户主页接口 ---------- */

/**
 * 用户详情（公开只读）。对应 docs/API.md 的 GET /api/users/:id。
 *
 * 存在的理由：UserProfile.vue 原先靠「从该作者的文章里反推 author」拿昵称与头像，
 * 该用户 0 篇文章时头部会退化成「用户 #id」。本接口让头部信息与文章列表解耦。
 *
 * ## 三个计数一律实时 COUNT(*)，不加冗余列（docs/DB.md 第 2 批登记②）
 *
 * 三条纪律：
 *   ① 全部走 prisma.count() 发独立 SQL，与文章 likeCount（relation count）**机制不同**
 *      ——这里是「三个数字一次返回」，不是每条列表项都要算，用 count 聚合更直白；
 *   ② 只数未软删的内容：articleCount 排除软删文章，另两个计数也只统计
 *      **未软删文章上**的记录（软删文章上的赞/评论不算这个用户的），用 whereNotDeleted；
 *   ③ receivedLikeCount **含自赞**（POST /api/articles/:id/like 允许赞自己的文章），
 *      与 likeCount 同为 all-time 累计，不做时间窗衰减。
 *
 * 四条查询并发发（Promise.all）而不是串行：四条都是主键/索引上的 COUNT，
 * 串行要多等三个 RTT。
 *
 * ## 为什么用 findFirst + whereNotDeleted 而不是 findUnique
 * findUnique({ where: { id } }) 语法上更短，但那样就得在 where 里手写
 * deletedAt: null，违反 docs/DB.md「查询约定」里「禁止手写 deletedAt: null」那一条。
 * 统一走 whereNotDeleted()，与 updateProfile 保持同一种写法。
 *
 * @param {number} id 路径参数，已由 zod 校验为正整数
 * @returns {Promise<object>} public user + articleCount / receivedLikeCount / receivedCommentCount
 */
export async function getUserDetail(id) {
  // 先确认用户存在且未软删：404 必须先于计数，否则无谓发三条 COUNT。
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id }),
    select: PUBLIC_FIELDS,
  });

  if (!user) {
    throw httpError(404, CODE.NOT_FOUND, '用户不存在');
  }

  const [articleCount, receivedLikeCount, receivedCommentCount] = await Promise.all([
    // 第 6 批：articleCount 只数「未软删且已发布」的文章——草稿不计入个人主页文章数。
    prisma.article.count({ where: whereNotDeleted({ authorId: id, status: 'PUBLISHED' }) }),

    // 该用户未软删文章上收到的赞。article: { authorId: id, deletedAt: null } 是
    // 「该用户的文章」+「文章未软删」两个条件的 AND（关系过滤器内部即AND）。
    // 不能写成 { article: { deletedAt: null }, article: { authorId: id } } ——
    // 那是两个同名 key，后者覆盖前者，软删过滤会被悄悄丢掉。
    prisma.like.count({
      where: { article: { authorId: id, deletedAt: null } },
    }),

    // 同理，评论要排除「已被软删的评论」与「文章已软删」两层。
    prisma.comment.count({
      where: {
        article: { authorId: id, deletedAt: null },
        deletedAt: null,
      },
    }),
  ]);

  return {
    ...toPublicUser(user),
    articleCount,
    receivedLikeCount,
    receivedCommentCount,
  };
}

/**
 * 某用户发布的文章列表（个人主页「文章」Tab），真后端分页。
 * 对应 docs/API.md 的 GET /api/users/:id/articles。
 *
 * ## 为什么不能在前端过滤
 * 旧实现是「取广场第一页 100 条 → 前端按 authorId 过滤 → 前端切片分页」，
 * 作者超过 100 篇时后面的文章永远取不到，且 total 是假的。本接口把过滤与分页
 * 全部下推到 SQL，total 由 COUNT 得出（docs/API.md 该节「不受 100 上限约束」）。
 *
 * ## 复用广场列表的全部查询件
 * select / 排序 / 次级排序 / list[] 塑形都直接用 article.service.js 导出的那三样，
 * 所以响应与 GET /api/articles **完全同形**（含 summary 截断长度与 author 内嵌）。
 *
 * ## 不支持 keyword / category
 * 搜索与分类是「广场」维度的筛选，个人主页不叠加（docs/API.md 已注明）。
 * parsePagination 仍只读 page/pageSize/sortBy/order 四个键，多传的其他 query
 * 参数会被 pickRaw 忽略，不会报错。
 *
 * ## 404 与空列表的区分
 * 用户不存在/已软删 → 404；用户存在但0 篇文章 → 200 + list:[] + total:0。
 * 所以先查一次用户存在性再查列表（不能靠 total===0 反推不存在）。
 *
 * @param {number} id 路径参数，已由 zod 校验为正整数
 * @param {object} query Express 的 req.query
 */
export async function listArticlesByUser(id, query) {
  await requireUserExists(id);

  const pagination = parsePagination(query, {
    allowedSort: ARTICLE_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  // 第 6 批：个人主页「文章」Tab 只返回 PUBLISHED，草稿不出现（草稿仅作者本人在草稿箱可见）。
  const where = whereNotDeleted({ authorId: id, status: 'PUBLISHED' });

  const [rows, total] = await Promise.all([
    prisma.article.findMany({
      where,
      select: ARTICLE_DETAIL_SELECT,
      // 排序与广场列表同一套：likeCount 走 ARTICLE_SORT_MAP 翻成关联计数排序，
      // 次级排序 id 自动生效（都是 articles.id —— 本接口主模型就是 Article，无歧义）。
      orderBy: buildOrderBy(pagination, { map: ARTICLE_SORT_MAP }),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.article.count({ where }),
  ]);

  return {
    list: rows.map(toArticleListItem),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/**
 * 当前登录用户点赞过的文章列表（个人主页「点赞」Tab）。
 * 对应 docs/API.md 的 GET /api/users/me/likes。
 *
 * ## 从 likes 表出发，不从 articles 出发
 * 这个选择决定了两件事，都是实测过的：
 *
 *  ① **次级排序的 `{ id }` 就是 likes.id**。查询主模型是 Like，顶层 id 解析成 Like.id。
 *     实测：库中 3 行 like 的 (id → articleId) 是 16→143、156→146、158→147，
 *     两列并不同序；orderBy {id} 返回的正是 16/156/158，故排的是 likes.id。
 *     **不要写成 `{ likes: { id } }`** —— 实测直接报 Invalid（Like 模型上没有 likes 关系）；
 *     **也不要写成 `{ article: { id } }`** —— 它能通过，但悄悄换成articles.id，
 *     是另一个语义，本接口要的是点赞记录主键。
 *
 *  ② **likedAt 就是 row.createdAt**。likes 表有 created_at（点赞时间），
 *     不需要额外字段，更不需要加列（DB.md 第 2 批登记③）。
 *
 * ## likedAt 怎么平铺进去（三条硬约束）
 *   1. **禁止改toArticleListItem()** —— 它被广场列表与文章 Tab 共用，
 *      给它加 likedAt 会污染那两个接口的响应（它们没有点赞记录）。
 *   2. 在 map 之后**单独附加**：`{ ...toArticleListItem(row.article), likedAt: row.createdAt }`。
 *   3. likedAt 是 API 层虚拟名，Prisma 无此字段，排序必须靠 map 翻译。
 *
 * ## 只返回未软删的文章
 * where 里 `article: { deletedAt: null }`：作者删文后该点赞不出现、total 也不计。
 * 取消点赞是物理 DELETE（likes 无软删列），total 会立刻下降。
 *
 * @param {object} params
 * @param {number} params.userId 来自 token
 * @param {object} params.query Express 的 req.query
 */
export async function listLikedArticles({ userId, query }) {
  await requireUserExists(userId);

  const pagination = parsePagination(query, {
    allowedSort: LIKED_SORT_FIELDS,
    defaultSort: 'likedAt',
  });

  const where = {
    userId,
    article: { deletedAt: null },
  };

  const [rows, total] = await Promise.all([
    prisma.like.findMany({
      where,
      // likedAt 走 LIKED_SORT_MAP 翻译成 likes.createdAt；row.createdAt 同时
      // 就是要平铺给前端的 likedAt（一次查询拿到，不用 join 后再取）。
      select: {
        createdAt: true,
        article: { select: ARTICLE_DETAIL_SELECT },
      },
      orderBy: buildOrderBy(pagination, { map: LIKED_SORT_MAP }),
      skip: pagination.skip,
      take: pagination.take,
    }),
    // total 与 list 用同一个 where，保证「条数」与「翻页边界」一致。
    prisma.like.count({ where }),
  ]);

  return {
    // 这里是**唯一**给列表项附加 likedAt 的地方（约束②）。
    list: rows.map((row) => ({ ...toArticleListItem(row.article), likedAt: row.createdAt })),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/**
 * 用户存在性检查，统一回404 / 40400。
 *
 * 「存在但0 篇文章」不是 404，必须显式查一次 —— 不能用 total===0 反推。
 * 单独抽出来是因为listArticlesByUser 与 listLikedArticles 都要用。
 */
async function requireUserExists(id) {
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id }),
    select: { id: true },
  });

  if (!user) {
    throw httpError(404, CODE.NOT_FOUND, '用户不存在');
  }
}
