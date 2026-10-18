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
  // 第 7 批：嵌套回复。parent 只取作者展示名（replyToAuthor 的数据来源），
  // 不取父评论正文——前端树形渲染时正文在父节点上，降级场景用「回复 @昵称」即可。
  parentId: true,
  parent: {
    select: {
      author: { select: { nickname: true, username: true } },
    },
  },
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
    // 第 7 批：顶层评论 parentId 恒为 null；replyToAuthor 是被回复人的展示昵称
    // （nickname 为空回退 username，与 author 展示名同一规则），顶层恒为 null。
    // 分页可能把父子拆到两页，前端靠它渲染「回复 @某某」降级文案。
    parentId: comment.parentId,
    replyToAuthor: comment.parent
      ? comment.parent.author.nickname || comment.parent.author.username
      : null,
    author: toAuthor(comment.author),
    createdAt: comment.createdAt,
  };
}

/**
 * 校验文章可评论：存在、未软删除、且 status = PUBLISHED。
 * 评论相关的两个接口都需要这个前置判断。
 *
 * 第 7 批（存量洞修复）：补上 `status: 'PUBLISHED'` 过滤——此前只过滤 deletedAt，
 * 导致可对 DRAFT 草稿发评论 / 拉评论列表（草稿的公开详情虽然 404，评论接口却绕过了
 * 这层）。修复后草稿的评论区与公开详情同口径 404，草稿整个对外封闭。
 */
async function requireArticle(articleId) {
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id: articleId, status: 'PUBLISHED' }),
    select: { id: true },
  });

  if (!article) {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在');
  }

  return article;
}

/**
 * 发表评论（含回复）。评论者取 token 中的 userId，不接受请求体里的作者字段。
 *
 * parentId 校验链（docs/API.md，按序判定，第 7 批）：
 *   ① 文章可评论（requireArticle：存在 / 未软删 / PUBLISHED）→ 否则 404；
 *   ② 父评论存在且未软删 → 否则 404（message「父评论不存在或已删除」）；
 *   ③ 父评论 articleId 必须等于本次 articleId → 否则 400（防跨文章挂接）；
 *   ④ 父评论必须是顶层（自身 parentId 为 null）→ 否则 400（两层硬限制，
 *      用户拍板 2026-10-18，杜绝无限递归把 UI 撑爆）。
 *
 * @param {{ articleId: number, content: string, parentId?: number }} payload 已校验的请求体
 * @param {number} authorId
 */
export async function createComment(payload, authorId) {
  // ① 文章可评论（草稿 / 软删 / 不存在一律 404）。
  await requireArticle(payload.articleId);

  let parentId = null;
  if (payload.parentId !== undefined && payload.parentId !== null) {
    const parent = await prisma.comment.findFirst({
      where: whereNotDeleted({ id: payload.parentId }),
      select: { id: true, articleId: true, parentId: true },
    });

    // ② 父评论存在且未软删。
    if (!parent) {
      throw httpError(404, CODE.NOT_FOUND, '父评论不存在或已删除');
    }

    // ③ 同文章：不能把 A 文章的回复挂到 B 文章下。
    if (parent.articleId !== payload.articleId) {
      throw httpError(400, CODE.PARAM_ERROR, '父评论与文章不匹配，不能跨文章回复');
    }

    // ④ 父必须是顶层：两层硬限制，回复的回复直接拦截。
    if (parent.parentId !== null) {
      throw httpError(400, CODE.PARAM_ERROR, '评论最多两层，不能回复回复');
    }

    parentId = parent.id;
  }

  const comment = await prisma.comment.create({
    data: {
      articleId: payload.articleId,
      content: payload.content,
      authorId,
      parentId,
    },
    select: COMMENT_SELECT,
  });

  return toComment(comment);
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

  // 第 7 批：软删 + 级联软删子评论在同一事务内。
  // 两层硬限制下，子评论的 parentId 直接指向本评论，一条 updateMany 覆盖整个子树
  //（无需递归）；`deletedAt: null` 条件保证已软删的子评论不重复置时间戳。
  // 删除子评论（parentId 非 null）时 updateMany 命中 0 行，天然无副作用。
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
