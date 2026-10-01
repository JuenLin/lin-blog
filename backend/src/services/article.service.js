import prisma from '../utils/prisma.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { CODE, httpError } from '../utils/response.js';

// docs/API.md：文章列表 sortBy 白名单为 createdAt / updatedAt / id，默认 createdAt desc。
export const ARTICLE_SORT_FIELDS = ['createdAt', 'updatedAt', 'id'];

// 列表的 summary 取正文前 100 个字符。
const SUMMARY_LENGTH = 100;

const AUTHOR_SELECT = {
  id: true,
  username: true,
  nickname: true,
};

// 显式 select，不使用 SELECT *（契约第 11 节）。
// author 直接内嵌查询，作者即使被软删除也照常返回（docs/API.md 通用约定）。
const ARTICLE_DETAIL_SELECT = {
  id: true,
  title: true,
  content: true,
  createdAt: true,
  updatedAt: true,
  author: {
    select: AUTHOR_SELECT,
  },
};

// 写入类操作只需要判断存在性与作者，不取正文。
const ARTICLE_OWNER_SELECT = {
  id: true,
  authorId: true,
};

/**
 * 截取正文前 100 个字符作为 summary。
 *
 * 必须用 [...content] 按码点展开再截取：String.prototype.slice 按 UTF-16 码元切，
 * 会把 emoji 等代理对拦腰截断，产生半个代理项（渲染为乱码或替换字符）。
 */
function buildSummary(content) {
  return [...content].slice(0, SUMMARY_LENGTH).join('');
}

function toAuthor(author) {
  return {
    id: author.id,
    username: author.username,
    nickname: author.nickname,
  };
}

function toArticleDetail(article) {
  return {
    id: article.id,
    title: article.title,
    content: article.content,
    author: toAuthor(article.author),
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

function toArticleListItem(article) {
  return {
    id: article.id,
    title: article.title,
    summary: buildSummary(article.content),
    author: toAuthor(article.author),
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

/**
 * 发布文章。作者取 token 中的 userId，不接受请求体里的作者字段。
 *
 * @param {{ title: string, content: string }} payload 已校验的请求体
 * @param {number} authorId
 */
export async function createArticle(payload, authorId) {
  const article = await prisma.article.create({
    data: {
      title: payload.title,
      content: payload.content,
      authorId,
    },
    select: ARTICLE_DETAIL_SELECT,
  });

  return toArticleDetail(article);
}

/**
 * 博客广场列表，无需登录。
 *
 * @param {object} query Express 的 req.query，分页与排序由 parsePagination 校验
 */
export async function listArticles(query) {
  const pagination = parsePagination(query, {
    allowedSort: ARTICLE_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  const where = whereNotDeleted();

  // 列表要生成 summary，必须取 content。pageSize 上限 100，100 条 MEDIUMTEXT 对 MVP 可接受。
  const [rows, total] = await Promise.all([
    prisma.article.findMany({
      where,
      select: ARTICLE_DETAIL_SELECT,
      orderBy: buildOrderBy(pagination),
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
 * 文章详情，返回全文。
 *
 * @param {number} id
 */
export async function getArticleDetail(id) {
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id }),
    select: ARTICLE_DETAIL_SELECT,
  });

  if (!article) {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在');
  }

  return toArticleDetail(article);
}

/**
 * 取文章用于「存在性 / 权限」判断。不存在或已软删除一律 404。
 */
async function requireArticleForWrite(id) {
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id }),
    select: ARTICLE_OWNER_SELECT,
  });

  if (!article) {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在');
  }

  return article;
}

/**
 * 非作者一律 403。403 直接在这里抛，controller 不做二次翻译。
 */
function assertAuthor(article, userId) {
  if (article.authorId !== userId) {
    throw httpError(403, CODE.FORBIDDEN, '无权限，只能操作自己的文章');
  }
}

/**
 * 编辑文章（全量更新）。
 *
 * 判断顺序固定为「先存在（404）后作者（403）」：
 * 反过来会让非作者通过 403 / 404 的差异枚举出真实存在的文章 id。
 */
export async function updateArticle(id, payload, userId) {
  const article = await requireArticleForWrite(id);

  assertAuthor(article, userId);

  const updated = await prisma.article.update({
    where: { id },
    data: {
      title: payload.title,
      content: payload.content,
    },
    select: ARTICLE_DETAIL_SELECT,
  });

  return toArticleDetail(updated);
}

/**
 * 删除文章（软删除）。判断顺序同 updateArticle。
 *
 * 只 UPDATE deleted_at，物理行保留，因此不触发外键：评论不被连带删除，
 * 之后由接口层保证它们随文章一起不可见（docs/DB.md「软删除与外键的交互」）。
 */
export async function deleteArticle(id, userId) {
  const article = await requireArticleForWrite(id);

  assertAuthor(article, userId);

  await prisma.article.update({
    where: { id },
    data: {
      deletedAt: new Date(),
    },
  });

  return null;
}
