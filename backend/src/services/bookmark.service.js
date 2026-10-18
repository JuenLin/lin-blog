// 第 9 批：收藏服务（收藏夹数据源）。
//
// ⚠️ 与 like.service.js 的**刻意相反**之处（docs/API.md「收藏与阅读量」）：
//   - 重复收藏（撞唯一约束 P2002）→ **幂等成功 200**，不是 409；
//   - 取消未收藏的文章（deleteMany count === 0）→ **幂等成功 200**，不是 404。
// 语义与 follow.service 一致：收藏是「关系状态」，重复操作意味着目标状态已达成，
// 没有冲突可言。数据层与 follows 同族（唯一约束 + 物理 DELETE + RESTRICT 外键），
// 错误码语义随家族，不随 likes。
//
// 收藏**不产生通知**（第 8 批通知中心只覆盖评论 / 回复 / 关注 / 点赞）——
// 收藏是纯个人整理行为，不打扰任何人。
import { Prisma } from '@prisma/client';

import prisma from '../utils/prisma.js';
import { requireArticleForWrite } from './article.service.js';

/**
 * 收藏文章（幂等）。
 *
 * 实现**直接 create**，与 like / follow 同一纪律：应用层「先查后写」有竞态窗口，
 * DB 唯一约束 `bookmarks_user_id_article_id_key` 是唯一真相。区别只在拦截后的
 * 语义 —— P2002 在这里**不是错误**，当作「已收藏」成功返回。
 *
 * @param {number} articleId
 * @param {number} userId 来自 token，不接受请求体里的身份字段
 * @returns {Promise<{ bookmarked: true, bookmarkCount: number }>}
 */
export async function bookmarkArticle(articleId, userId) {
  // 文章不存在或已软删一律 404。必须在任何写操作之前（与 like / 评论同顺序）。
  await requireArticleForWrite(articleId);

  try {
    await prisma.bookmark.create({
      data: { userId, articleId },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // 已收藏过：目标状态（「这篇文章在我的收藏夹里」）已达成，幂等成功。
      // 注意与 like.service 的同一段代码逐行相似、语义相反——那是刻意的。
    } else {
      throw error;
    }
  }

  return {
    bookmarked: true,
    bookmarkCount: await countBookmarks(articleId),
  };
}

/**
 * 取消收藏（幂等）。
 *
 * 用 `deleteMany` 而不是 `delete`：后者在记录不存在时抛 P2025，
 * 前者返回 `{ count }`。count === 0（本来就没收藏）**仍然 200**——
 * 「没收藏」就是目标状态本身，不是调用方的错误（与 unlike 的 404 刻意相反）。
 *
 * @param {number} articleId
 * @param {number} userId
 * @returns {Promise<{ bookmarked: false, bookmarkCount: number }>}
 */
export async function unbookmarkArticle(articleId, userId) {
  await requireArticleForWrite(articleId);

  await prisma.bookmark.deleteMany({
    where: { userId, articleId },
  });

  return {
    bookmarked: false,
    bookmarkCount: await countBookmarks(articleId),
  };
}

/**
 * 当前登录用户对某篇文章是否已收藏（`GET /api/articles/:id/bookmarked`）。
 *
 * 与 hasLiked 同构：只返回 `{ bookmarked }`，**不带 bookmarkCount**
 * （计数唯一来源是文章接口，两个口径将来无法判断哪个对）。
 * 文章不存在或已软删返回 404，而不是 `{ bookmarked: false }` ——
 * 返回 false 会让前端渲染成「未收藏 + 可点」，用户一点就吃 404。
 *
 * @param {number} articleId
 * @param {number} userId 来自 token
 * @returns {Promise<{ bookmarked: boolean }>}
 */
export async function hasBookmarked(articleId, userId) {
  await requireArticleForWrite(articleId);

  const row = await prisma.bookmark.findFirst({
    where: { userId, articleId },
    select: { id: true },
  });

  return { bookmarked: Boolean(row) };
}

/**
 * 某篇文章的收藏数。实时 COUNT(*)，不在 articles 表存冗余列（同 likeCount 纪律）。
 *
 * @param {number} articleId
 * @returns {Promise<number>}
 */
async function countBookmarks(articleId) {
  return prisma.bookmark.count({ where: { articleId } });
}
