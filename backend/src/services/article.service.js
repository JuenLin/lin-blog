import prisma from '../utils/prisma.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { parseKeyword } from '../validators/article.validator.js';
import { CODE, httpError } from '../utils/response.js';

// docs/API.md：文章列表 sortBy 白名单为 createdAt / updatedAt / id，默认 createdAt desc。
export const ARTICLE_SORT_FIELDS = ['createdAt', 'updatedAt', 'id'];

// 列表的 summary 取正文前 100 个字符。
const SUMMARY_LENGTH = 100;

// 内嵌 author 的查询字段。
// avatar 为第九批新增（可空）。bio **刻意不加**：简介只在个人主页展示，
// 塞进每条列表项的 author 里是纯粹的响应体浪费。
// 注意：comment.service.js 里有一份**内容相同**的重复定义，
// 本期按「只加字段、不做重构」处理，抽取公共定义单独排一批。
const AUTHOR_SELECT = {
  id: true,
  username: true,
  nickname: true,
  avatar: true,
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
  // 第十批：点赞数。用 relation count 而不是单独发 COUNT 查询，
  // 否则列表接口每篇文章一次 COUNT 就是 N+1。Prisma 会把它编成一条
  // 关联子查询（或 join 后聚合），**列表接口只发一次 SQL**。
  // 不加 articles.like_count 冗余列（docs/API.md 通用约定）。
  _count: {
    select: { likes: true },
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
    avatar: author.avatar,
  };
}

function toArticleDetail(article) {
  return {
    id: article.id,
    title: article.title,
    content: article.content,
    author: toAuthor(article.author),
    likeCount: article._count ? article._count.likes : 0,
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
    // 与详情口径一致：实时 COUNT(*)。_count 缺失时降级为 0 而不是 undefined，
    // 这样「接口没返回」和「确实是 0」对前端是同一个值（docs/API.md 的约定）。
    likeCount: article._count ? article._count.likes : 0,
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
 * @param {object} query Express 的 req.query，分页与排序由 parsePagination 校验，
 *                      keyword（搜索）由 parseKeyword 解析
 */
export async function listArticles(query) {
  const pagination = parsePagination(query, {
    allowedSort: ARTICLE_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  // 搜索：标题 OR 正文 命中即返回（docs/API.md）。空串在 parseKeyword 里已转成 null，
  // 即「不传」，所以这里只在真有 keyword 时才叠加 OR 条件。
  // 不搜作者昵称 —— 作者维度筛选不在本期范围。
  const keyword = parseKeyword(query);
  const searchWhere = keyword
    ? {
        OR: [{ title: { contains: keyword } }, { content: { contains: keyword } }],
      }
    : {};

  // whereNotDeleted 内部是 { ...where, deletedAt: null }，
  // 所以 OR 条件与软删除过滤是 AND 关系：软删除的文章搜不到（docs/API.md 语义第 5 条）。
  const where = whereNotDeleted(searchWhere);

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
// 导出供 like.service.js 复用：点赞/取消点赞要的是同一套「文章存在且未软删」判定，
// 与其在 like.service 里再写一遍，不如共用一处，避免两边口径漂移。
export async function requireArticleForWrite(id) {
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
