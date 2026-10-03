import prisma from '../utils/prisma.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { CODE, httpError } from '../utils/response.js';

// docs/API.md：评论列表 sortBy 白名单为 createdAt / id，默认 createdAt desc。
export const COMMENT_SORT_FIELDS = ['createdAt', 'id'];

// 内嵌 author 的查询字段。
// avatar 为第九批新增（可空）。bio **刻意不加**：理由见 article.service.js
// 里的同一处注释。article.service.js 有一份内容相同的重复定义，
// 本期按「只加字段、不做重构」处理。
const AUTHOR_SELECT = {
  id: true,
  username: true,
  nickname: true,
  avatar: true,
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
