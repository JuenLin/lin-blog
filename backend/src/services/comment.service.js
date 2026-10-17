import prisma from '../utils/prisma.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { CODE, httpError } from '../utils/response.js';

// docs/API.md：评论列表 sortBy 白名单为 createdAt / id，默认 createdAt desc。
export const COMMENT_SORT_FIELDS = ['createdAt', 'id'];

// 内嵌 author 的查询字段。
// avatar 为第九批新增（可空），role 为第 5 批新增（USER / ADMIN）。
// bio **刻意不加**：理由见 article.service.js 里的同一处注释。
// article.service.js 有一份内容相同的重复定义，
// 本期按「只加字段、不做重构」处理。
const AUTHOR_SELECT = {
  id: true,
  username: true,
  nickname: true,
  avatar: true,
  role: true,
};

const COMMENT_SELECT = {
  id: true,
  articleId: true,
  content: true,
  createdAt: true,
  author: {
    select: AUTHOR_SELECT,
  },
};

function toAuthor(author) {
  return {
    id: author.id,
    username: author.username,
    nickname: author.nickname,
    avatar: author.avatar,
    role: author.role,
  };
}

function toComment(comment) {
  return {
    id: comment.id,
    content: comment.content,
    author: toAuthor(comment.author),
    createdAt: comment.createdAt,
  };
}

/**
 * 校验文章存在且未软删除。评论相关的两个接口都需要这个前置判断：
 * 文章不存在或已删除时，评论接口统一返回 404。
 */
async function requireArticle(articleId) {
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id: articleId }),
    select: { id: true },
  });

  if (!article) {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在');
  }

  return article;
}

/**
 * 发表评论。评论者取 token 中的 userId，不接受请求体里的作者字段。
 *
 * @param {{ articleId: number, content: string }} payload 已校验的请求体
 * @param {number} authorId
 */
export async function createComment(payload, authorId) {
  await requireArticle(payload.articleId);

  const comment = await prisma.comment.create({
    data: {
      articleId: payload.articleId,
      content: payload.content,
      authorId,
    },
    select: COMMENT_SELECT,
  });

  return {
    id: comment.id,
    articleId: comment.articleId,
    content: comment.content,
    author: toAuthor(comment.author),
    createdAt: comment.createdAt,
  };
}

/**
 * 文章评论列表，无需登录。文章不存在或已软删除返回 404，
 * 这也保证文章删除后其评论随文章一起不可见。
 *
 * @param {number} articleId
 * @param {object} query Express 的 req.query
 */
export async function listCommentsByArticle(articleId, query) {
  await requireArticle(articleId);

  const pagination = parsePagination(query, {
    allowedSort: COMMENT_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  const where = whereNotDeleted({ articleId });

  const [rows, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      select: COMMENT_SELECT,
      orderBy: buildOrderBy(pagination),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.comment.count({ where }),
  ]);

  return {
    list: rows.map(toComment),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/**
 * 删除评论（软删除）。判断顺序固定为「先存在（404）后权限（403）」：
 * 反过来会让非作者通过 403 / 404 的差异枚举出真实存在的评论 id。
 *
 * 权限规则：评论作者 ∨（文章作者 ∧ 文章未软删）。
 * 文章已软删 / 不存在时，whereNotDeleted 查不到，article 为 null，
 * 此时只有评论作者本人可删（docs/API.md「文章已软删边界」）；其余一律 403。
 * 显式判 null，绝不读 `article.authorId`，避免空指针崩溃，也不把数据异常落为 500。
 *
 * @param {number} id
 * @param {number} userId
 * @returns {null}
 */
export async function deleteComment(id, userId) {
  const comment = await prisma.comment.findFirst({
    where: whereNotDeleted({ id }),
    select: { id: true, authorId: true, articleId: true },
  });

  // 先存在性：评论不存在或已软删除 → 404（含重复删除）。
  if (!comment) {
    throw httpError(404, CODE.NOT_FOUND, '评论不存在或已删除');
  }

  // 文章已软删 / 不存在 → article 为 null。这里不读 article.authorId。
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id: comment.articleId }),
    select: { authorId: true },
  });

  const isCommentAuthor = comment.authorId === userId;
  const isArticleAuthor = article !== null && article.authorId === userId;

  // 后权限：两者都不是 → 403。
  if (!isCommentAuthor && !isArticleAuthor) {
    throw httpError(403, CODE.FORBIDDEN, '无权删除该评论');
  }

  await prisma.comment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return null;
}
