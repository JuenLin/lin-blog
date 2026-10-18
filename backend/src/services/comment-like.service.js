import prisma from '../utils/prisma.js';
import { whereNotDeleted } from '../utils/query.js';
import { CODE, httpError } from '../utils/response.js';
import { notifyOnCommentLike } from './notification.service.js';

/**
 * 评论点赞（第 11 批）。对应 docs/API.md「评论点赞与 @提及（第 11 批）」的 3 个接口。
 *
 * 与文章点赞（like.service）的**刻意差异**：
 *   - 幂等 200：重复赞 / 取消未赞都成功（bookmark / follow 族），不是 409 / 404；
 *   - 并发拦截同纪律：直接 create 靠唯一约束（comment_likes_user_id_comment_id_key），
 *     P2002 在评论侧转幂等成功，不回 409。
 *
 * 计数双口径：`comments.like_count` 是响应回显用的累加计数器（increment / decrement
 * 原子维护）；`comment_likes` 行是唯一真相（幂等判定 / liked 判定走行存在性）。
 * 取消赞只在**确实删掉了行**时才 decrement——幂等重放永远不变更计数，
 * 计数永不因重复取消而变负。
 */

/**
 * 校验评论可见：评论存在且未软删，且所属文章未软删且 PUBLISHED。
 * 与评论列表 / 发表评论的可见口径完全一致（草稿的评论区对外封闭，第 7 批）。
 *
 * ⚠️ Prisma **不支持**关系级 where 过滤（`select: { article: { where } }` 会报
 * Unknown argument `where`）——文章可见性查回 status / deletedAt 后在应用层判定，
 * 与 comment.service 的 requireArticle 同口径。
 *
 * 三个接口的 404 语义都是「评论不可见」——**不是**「没赞过」（那是幂等成功）。
 *
 * @returns {Promise<{id: number, articleId: number, authorId: number}>}
 */
async function requireVisibleComment(commentId) {
  const comment = await prisma.comment.findFirst({
    where: whereNotDeleted({ id: commentId }),
    select: {
      id: true,
      articleId: true,
      authorId: true,
      article: { select: { status: true, deletedAt: true } },
    },
  });

  const articleVisible = comment && comment.article && comment.article.deletedAt === null && comment.article.status === 'PUBLISHED';

  if (!articleVisible) {
    throw httpError(404, CODE.NOT_FOUND, '评论不存在或不可见');
  }

  return comment;
}

/**
 * 赞一条评论。幂等：已赞过（P2002）直接回当前状态，不重复计数、不重复通知。
 *
 * @param {number} commentId
 * @param {number} userId
 * @returns {Promise<{liked: true, likeCount: number}>}
 */
export async function likeComment(commentId, userId) {
  const comment = await requireVisibleComment(commentId);

  let created = true;
  try {
    await prisma.commentLike.create({
      data: { userId, commentId },
    });
  } catch (error) {
    // P2002 = 唯一约束冲突 = 已经赞过 → 幂等成功（与 bookmark 同款兜底，
    // 应用层「先查后写」存在竞态窗口，DB 唯一约束是唯一真相）。
    if (error && error.code === 'P2002') {
      created = false;
    } else {
      throw error;
    }
  }

  // 只有真正插入了行才 increment——幂等重放不变更计数。
  if (created) {
    await prisma.comment.update({
      where: { id: commentId },
      data: { likeCount: { increment: 1 } },
    });

    // 通知是附加价值，绝不因通知失败把点赞变成 500（对镜 createComment 的通知纪律）。
    try {
      await notifyOnCommentLike({
        commentId,
        commentAuthorId: comment.authorId,
        articleId: comment.articleId,
        likerId: userId,
      });
    } catch (notifyError) {
      console.error('[notify] 评论点赞通知发送失败（不影响点赞）:', notifyError);
    }
  }

  const row = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { likeCount: true },
  });

  return { liked: true, likeCount: row ? row.likeCount : 0 };
}

/**
 * 取消赞。幂等：没赞过的也 200（与文章取消赞的 404 刻意相反）。
 *
 * 404 的语义是「评论不可见」（软删评论 / 草稿文章下的评论），不是「没赞过」——
 * 即使评论已软删，也不能让删除者通过 404/200 差异枚举出评论 id（对镜 deleteComment）。
 *
 * @param {number} commentId
 * @param {number} userId
 * @returns {Promise<{liked: false, likeCount: number}>}
 */
export async function unlikeComment(commentId, userId) {
  await requireVisibleComment(commentId);

  // deleteMany 的返回值就是幂等判据：count=0 本来就没赞过（什么都不做）。
  const removed = await prisma.commentLike.deleteMany({
    where: { userId, commentId },
  });

  // 只在确实删掉了行时 decrement，计数永不因幂等重放而变负。
  if (removed.count > 0) {
    await prisma.comment.update({
      where: { id: commentId },
      data: { likeCount: { decrement: 1 } },
    });
  }

  const row = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { likeCount: true },
  });

  return { liked: false, likeCount: row ? row.likeCount : 0 };
}

/**
 * 查当前用户是否已赞该评论。只回 { liked }，不带 likeCount——计数唯一来源是
 * 评论列表 / 点赞响应，同一个值两个口径将来无法判断哪个对（对镜 GET /articles/:id/liked）。
 *
 * @param {number} commentId
 * @param {number} userId
 * @returns {Promise<{liked: boolean}>}
 */
export async function isCommentLiked(commentId, userId) {
  await requireVisibleComment(commentId);

  // findFirst 而非 findUnique：@@unique 自定义了 name（comment_likes_user_id_comment_id_key），
  // 复合 where 的输入键会随 name 走，字段名拼接键（userId_commentId）反而无效——
  // likes / bookmarks 族一律用 findFirst 判存在（行存在性语义也更直白）。
  const row = await prisma.commentLike.findFirst({
    where: { userId, commentId },
    select: { id: true },
  });

  return { liked: row !== null };
}

/**
 * 批量判定「当前用户赞过哪些评论」（评论列表 liked 字段的数据源）。
 *
 * 一次 IN 查询拿本页全部答案，绝不逐条查（N+1 防坑，同 listSeriesByUser 的 groupBy）。
 * viewerId 为 null / undefined（未登录）→ 空集合，列表项省略 liked 键。
 *
 * @param {number|null} viewerId
 * @param {number[]} commentIds 本页评论 id
 * @returns {Promise<Set<number>>} 已赞的评论 id 集合
 */
export async function findLikedCommentIds(viewerId, commentIds) {
  if (!viewerId || commentIds.length === 0) {
    return new Set();
  }

  const rows = await prisma.commentLike.findMany({
    where: { userId: viewerId, commentId: { in: commentIds } },
    select: { commentId: true },
  });

  return new Set(rows.map((r) => r.commentId));
}
