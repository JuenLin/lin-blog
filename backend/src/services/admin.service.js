import prisma from '../utils/prisma.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { parseKeyword } from '../validators/article.validator.js';
import { parseUserStatus, parseDeletedFilter } from '../validators/admin.validator.js';
import { CODE, httpError } from '../utils/response.js';
import {
  toArticleListItem,
  ARTICLE_SORT_FIELDS,
  ARTICLE_SORT_MAP,
  ARTICLE_DETAIL_SELECT,
} from './article.service.js';
import { COMMENT_SORT_FIELDS } from './comment.service.js';

// 第 5 批管理端 service（docs/API.md「管理端接口（第 5 批）」）。
// 所有函数都要求调用方已过 auth → requireAdmin 双中间件，
// 因此这里**不再做任何角色 / 登录判断**，只做业务。

// 管理端用户列表 sortBy 白名单（比公开用户接口少——管理端不需要按资料字段排）。
const USER_SORT_FIELDS = ['createdAt', 'id'];

// 管理端用户列表 select：含 role / status（管理页职责），永远不含 password。
const ADMIN_USER_SELECT = {
  id: true,
  username: true,
  nickname: true,
  avatar: true,
  role: true,
  status: true,
  createdAt: true,
};

// 管理端文章列表 select = 广场的 ARTICLE_DETAIL_SELECT + deletedAt。
// 复用同一份 select 保证 list[] 与广场**逐字同形**（docs/API.md）；
// deletedAt 单独加，公开接口的 select 不受影响。
const ADMIN_ARTICLE_SELECT = {
  ...ARTICLE_DETAIL_SELECT,
  deletedAt: true,
};

// 管理端评论列表 select：比公开评论列表多 articleTitle（一条关联，
// 让管理端知道评论归属哪篇文章）与 deletedAt。
const ADMIN_COMMENT_SELECT = {
  id: true,
  content: true,
  createdAt: true,
  deletedAt: true,
  articleId: true,
  article: {
    select: { title: true },
  },
  author: {
    select: {
      id: true,
      username: true,
      nickname: true,
      avatar: true,
      role: true,
    },
  },
};

function toAdminComment(comment) {
  return {
    id: comment.id,
    content: comment.content,
    author: {
      id: comment.author.id,
      username: comment.author.username,
      nickname: comment.author.nickname,
      avatar: comment.author.avatar,
      role: comment.author.role,
    },
    articleId: comment.articleId,
    articleTitle: comment.article.title,
    createdAt: comment.createdAt,
    deletedAt: comment.deletedAt,
  };
}

/**
 * 数据概览：6 个实时 COUNT，一次 Promise.all 并发。
 *
 * users / articles / comments 只数未软删；likes / follows 数全表
 * （与 likeCount / followerCount 的口径一致）；deletedArticles 是管理端
 * 专属视角（已软删文章数），公开接口不返回。
 *
 * **不含「待办举报数」**：reports 表第 12 批已建，但 stats 响应形状是已登记契约
 * （前端数据概览页按 6 字段渲染），加字段属契约变更——挂账，不在本批顺手改。
 */
export async function getStats() {
  const [users, articles, comments, likes, follows, deletedArticles] = await Promise.all([
    prisma.user.count({ where: whereNotDeleted() }),
    prisma.article.count({ where: whereNotDeleted() }),
    prisma.comment.count({ where: whereNotDeleted() }),
    prisma.like.count(),
    prisma.follow.count(),
    prisma.article.count({ where: { deletedAt: { not: null } } }),
  ]);

  return { users, articles, comments, likes, follows, deletedArticles };
}

/**
 * 用户列表（分页 / keyword 搜 username+nickname / status 筛选）。
 *
 * **不含软删用户**：与所有用户只读接口口径一致（软删用户对任何接口都是 404），
 * PATCH /api/admin/users/:id/status 对软删用户同样 404。
 */
export async function listUsers(query) {
  const pagination = parsePagination(query, {
    allowedSort: USER_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  const keyword = parseKeyword(query);
  const status = parseUserStatus(query);

  const where = whereNotDeleted({
    ...(keyword
      ? { OR: [{ username: { contains: keyword } }, { nickname: { contains: keyword } }] }
      : {}),
    ...(status ? { status } : {}),
  });

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: ADMIN_USER_SELECT,
      orderBy: buildOrderBy(pagination),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    list: rows,
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/**
 * 封禁 / 解禁用户。
 *
 * 幂等：已是目标状态也正常 update 并返回 200（状态机 set，非动作计数，
 * 与「重复关注 200」同族）。
 *
 * **一刀切防呆规则**：目标用户 role = 'ADMIN' 时直接 400 / 40000
 * 「不能封禁或解禁管理员账号」，**不计算「是不是最后一个管理员」**
 * （并发下算不清，且规则越简单越可断言）。自己封自己也走这条分支。
 * 管理员的任命 / 罢免 / 封禁只由开发者直接改数据库——有意的运维边界。
 */
export async function updateUserStatus(id, status) {
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id }),
    select: { id: true, role: true },
  });

  if (!user) {
    throw httpError(404, CODE.NOT_FOUND, '用户不存在');
  }

  if (user.role === 'ADMIN') {
    throw httpError(400, CODE.PARAM_ERROR, '不能封禁或解禁管理员账号');
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { status },
    select: ADMIN_USER_SELECT,
  });

  return updated;
}

/**
 * 文章列表（管理视角）：默认**含软删**，deleted=true/false 可筛选。
 * list[] 与广场逐字同形（同一份 toArticleListItem），附加 deletedAt。
 */
export async function listArticles(query) {
  const pagination = parsePagination(query, {
    allowedSort: ARTICLE_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  const keyword = parseKeyword(query);
  const deleted = parseDeletedFilter(query);

  const where = {
    ...(keyword
      ? { OR: [{ title: { contains: keyword } }, { content: { contains: keyword } }] }
      : {}),
    ...(deleted === true ? { deletedAt: { not: null } } : {}),
    ...(deleted === false ? { deletedAt: null } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.article.findMany({
      where,
      select: ADMIN_ARTICLE_SELECT,
      orderBy: buildOrderBy(pagination, { map: ARTICLE_SORT_MAP }),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.article.count({ where }),
  ]);

  return {
    // toArticleListItem 不含 deletedAt（公开接口不该看到它），map 之后单独附加，
    // 同 likedAt 的机制——不污染公开塑形函数。
    list: rows.map((row) => ({ ...toArticleListItem(row), deletedAt: row.deletedAt })),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/**
 * 管理端删除文章：软删，**无视作者权限**。
 *
 * 刻意用 findFirst({ where: { id } }) 而不过滤软删：已软删的文章也要能被
 * 发现并返回 404（与公开删除接口「已删 → 404」口径一致）。
 */
export async function deleteArticle(id) {
  const article = await prisma.article.findFirst({
    where: { id },
    select: { id: true, deletedAt: true },
  });

  if (!article || article.deletedAt) {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在或已删除');
  }

  await prisma.article.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return null;
}

/**
 * 评论列表（管理视角）：默认含软删，可筛选。
 *
 * **不过滤文章的软删状态**：已软删文章的评论也要能管（管理页职责），
 * 与公开评论列表（随文章不可见）语义不同。
 */
export async function listComments(query) {
  const pagination = parsePagination(query, {
    allowedSort: COMMENT_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  const keyword = parseKeyword(query);
  const deleted = parseDeletedFilter(query);

  const where = {
    ...(keyword ? { content: { contains: keyword } } : {}),
    ...(deleted === true ? { deletedAt: { not: null } } : {}),
    ...(deleted === false ? { deletedAt: null } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      select: ADMIN_COMMENT_SELECT,
      orderBy: buildOrderBy(pagination),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.comment.count({ where }),
  ]);

  return {
    list: rows.map(toAdminComment),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/**
 * 管理端删除评论：软删，**无视作者权限**（公开接口的「评论作者 ∨ 文章作者」
 * 规则不适用）。已软删或不存在 → 404。
 *
 * 第 12 批顺带修挂账（用户拍板并入本批）：补**级联软删子评论**——原先只删单条，
 * 与用户侧 deleteComment（$transaction + updateMany 子树）口径不一致，属历史遗留。
 * 两层硬限制下，子评论的 parentId 直接指向本评论，一条 updateMany 覆盖整个子树
 * （无需递归）；`deletedAt: null` 条件保证已软删的子评论不重复置时间戳。
 */
export async function deleteComment(id) {
  const comment = await prisma.comment.findFirst({
    where: { id },
    select: { id: true, deletedAt: true },
  });

  if (!comment || comment.deletedAt) {
    throw httpError(404, CODE.NOT_FOUND, '评论不存在或已删除');
  }

  await prisma.$transaction([
    prisma.comment.update({
      where: { id },
      data: { deletedAt: new Date() },
    }),
    prisma.comment.updateMany({
      where: { parentId: id, deletedAt: null },
      data: { deletedAt: new Date() },
    }),
  ]);

  return null;
}
