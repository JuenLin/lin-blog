import prisma from '../utils/prisma.js';
import { CODE, httpError } from '../utils/response.js';
import { buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';

// 第 8 批：通知中心。
// 通知由评论 / 关注 / 点赞三个 service 在动作成功后调用本文件的 notifyOn* 自动产生，
// 接收者（userId）取被通知的人，触发者（actorId）取做动作的人，业务层保证 actorId !== userId。

const NOTIFICATION_SORT_FIELDS = ['createdAt', 'id'];

const NOTIFICATION_ACTOR_SELECT = {
  id: true,
  nickname: true,
  username: true,
  avatar: true,
  deletedAt: true,
};

const NOTIFICATION_ARTICLE_SELECT = {
  id: true,
  title: true,
  deletedAt: true,
};

/**
 * 写入一条通知。调用方（notifyOn*）已保证自通知抑制，这里只负责落地。
 *
 * @param {{ userId: number, actorId: number, type: string, articleId?: number|null, commentId?: number|null }} payload
 */
export async function createNotification(payload) {
  return prisma.notification.create({
    data: {
      userId: payload.userId,
      actorId: payload.actorId,
      type: payload.type,
      articleId: payload.articleId ?? null,
      commentId: payload.commentId ?? null,
    },
  });
}

/**
 * 评论动作后的通知编排。
 *   - parentAuthorId 非空（回复）：通知父评论作者，type = REPLY；
 *   - 顶层评论：查文章作者并通知，type = COMMENT。
 * 自通知抑制（actorId === 接收者）直接不写，绝不发给自己。
 */
export async function notifyOnComment({ articleId, commentId, commentAuthorId, parentAuthorId }) {
  if (parentAuthorId != null) {
    if (commentAuthorId === parentAuthorId) return;
    await createNotification({
      userId: parentAuthorId,
      actorId: commentAuthorId,
      type: 'REPLY',
      articleId,
      commentId,
    });
    return;
  }

  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { authorId: true },
  });
  if (!article) return;
  if (commentAuthorId === article.authorId) return;

  await createNotification({
    userId: article.authorId,
    actorId: commentAuthorId,
    type: 'COMMENT',
    articleId,
    commentId,
  });
}

/** 关注动作后的通知编排。followUser 已拒绝「关注自己」，这里再兜底一道。 */
export async function notifyOnFollow({ followerId, followingId }) {
  if (followerId === followingId) return;
  await createNotification({ userId: followingId, actorId: followerId, type: 'FOLLOW' });
}

/** 点赞动作后的通知编排。自赞（actorId === 文章作者）不写。 */
export async function notifyOnLike({ articleId, likerId }) {
  const article = await prisma.article.findUnique({
    where: { id: articleId },
    select: { authorId: true },
  });
  if (!article) return;
  if (likerId === article.authorId) return;

  await createNotification({ userId: article.authorId, actorId: likerId, type: 'LIKE', articleId });
}

/**
 * 评论被赞后的通知编排（第 11 批）。评论作者收到 COMMENT_LIKE。
 * 自赞（actorId === 评论作者）**不写通知**——自赞允许计数（与文章点赞第 9 批
 * 「允许自收藏/自计数」同口径），但通知给自己没有信息量，抑制掉。
 */
export async function notifyOnCommentLike({ commentId, commentAuthorId, articleId, likerId }) {
  if (likerId === commentAuthorId) return;

  await createNotification({
    userId: commentAuthorId,
    actorId: likerId,
    type: 'COMMENT_LIKE',
    articleId,
    commentId,
  });
}

/**
 * @提及通知编排（第 11 批）。
 *
 * 提取规则（docs/API.md「评论点赞与 @提及」）：
 *   - 正则 /@(\w+)/g 提取用户名（字母/数字/下划线，与 username 字符集一致）；
 *   - 去重：同一篇内 @ 同一个人只发一条；
 *   - 过滤自己：绝不给自己发提及（作者 @ 自己是写作习惯，不是通知需求）；
 *   - 查库过滤：只通知**存在且未软删**的用户（已注销的不打扰）；
 *   - 上限：单篇最多通知 20 人（防长文 @ 轰炸；超出部分静默丢弃）。
 *
 * 通知失败不影响主操作——调用方（评论/文章发布）把本函数包在 try/catch 里，
 * 本函数内部对**单个用户**的失败也继续处理其余用户（一次 create 失败不该吞掉全部提及）。
 *
 * @param {{ articleId: number, commentId?: number|null, content: string, authorId: number }} payload
 * @returns {Promise<number>} 实际发出的通知条数（仅用于日志）
 */
export async function notifyOnMentions({ articleId, commentId = null, content, authorId }) {
  const MENTION_LIMIT = 20;

  // 提取 + 去重 + 过滤自己（Set 保序去重）。
  const matches = content.match(/@(\w+)/g) || [];
  const names = [...new Set(matches.map((m) => m.slice(1)))].filter((name) => name.length > 0 && name.length <= 50);

  if (names.length === 0) return 0;

  // 一次查询拿全部命中用户（存在且未软删），再排除自己。
  const users = await prisma.user.findMany({
    where: { username: { in: names }, deletedAt: null },
    select: { id: true },
  });

  const targets = users.map((u) => u.id).filter((id) => id !== authorId).slice(0, MENTION_LIMIT);

  let sent = 0;
  for (const userId of targets) {
    try {
      await createNotification({
        userId,
        actorId: authorId,
        type: 'MENTION',
        articleId,
        commentId,
      });
      sent += 1;
    } catch (error) {
      console.error(`[notify] MENTION 通知失败（userId=${userId}，继续处理其余提及）:`, error.message);
    }
  }

  return sent;
}

/**
 * 我的通知列表（扁平分页），含 actor 摘要 + 文章标题摘要。
 * join + 空值降级：actor / article 软删或不存在 → 显示「已注销用户」/「内容已删除」。
 *
 * @param {number} userId
 * @param {object} query Express 的 req.query
 */
export async function listNotifications(userId, query) {
  const pagination = parsePagination(query, {
    allowedSort: NOTIFICATION_SORT_FIELDS,
    defaultSort: 'createdAt',
  });

  const where = { userId };

  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      include: {
        actor: { select: NOTIFICATION_ACTOR_SELECT },
        article: { select: NOTIFICATION_ARTICLE_SELECT },
      },
      orderBy: buildOrderBy(pagination),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.notification.count({ where }),
  ]);

  return {
    list: rows.map(toNotification),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/** 未读数：userId 下 readAt 为 null 的条数。 */
export async function countUnread(userId) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/**
 * 批量标记已读。
 *   - ids 未传 或 空数组 → 全部已读（WHERE userId AND readAt IS NULL）；
 *   - ids 非空 → 只标属于本人且未读的那些（越权 id 自动过滤，防越权标他人已读）。
 *
 * @param {number} userId
 * @param {number[]|undefined} ids
 * @returns {Promise<{ count: number }>}
 */
export async function markRead(userId, ids) {
  const markAll = ids === undefined || (Array.isArray(ids) && ids.length === 0);

  if (markAll) {
    const r = await prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { count: r.count };
  }

  if (!Array.isArray(ids) || ids.length === 0) {
    return { count: 0 };
  }

  const r = await prisma.notification.updateMany({
    where: { userId, id: { in: ids }, readAt: null },
    data: { readAt: new Date() },
  });

  return { count: r.count };
}

/**
 * 单条标记已读。已读 / 不存在 / 不属于自己 → 200 幂等（不报 404，与取消关注同口径）。
 *
 * @param {number} userId
 * @param {number} id
 * @returns {Promise<null>}
 */
export async function markReadOne(userId, id) {
  const numericId = Number(id);

  if (!Number.isInteger(numericId)) {
    throw httpError(400, CODE.PARAM_ERROR, '通知 id 无效');
  }

  await prisma.notification.updateMany({
    where: { userId, id: numericId, readAt: null },
    data: { readAt: new Date() },
  });

  return null;
}

/**
 * 把 DB 行翻译成 API 返回（后端拼文案，前端只渲染）。
 * join + 空值降级：actor 软删 → 已注销用户；article 软删 / 不存在 → 内容已删除。
 */
function toNotification(n) {
  const actorDeleted = !n.actor || n.actor.deletedAt !== null;
  const actorName = actorDeleted ? '已注销用户' : n.actor.nickname || n.actor.username;
  const actorAvatar = actorDeleted ? null : n.actor.avatar;

  const articleMissing = n.articleId == null || !n.article || n.article.deletedAt !== null;
  const targetTitle = n.articleId == null ? null : articleMissing ? '内容已删除' : n.article.title;

  return {
    id: n.id,
    type: n.type,
    actorId: n.actorId,
    actorName,
    actorAvatar,
    targetTitle,
    articleId: n.articleId,
    commentId: n.commentId,
    isRead: n.readAt !== null,
    createdAt: n.createdAt,
  };
}
