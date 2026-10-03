// ⚠️ 不能写 `import { PrismaClientKnownRequestError } from '@prisma/client'`：
// 顶层导出里**没有**这个名字（实测为 undefined），`error instanceof undefined` 会直接抛
// TypeError，重复点赞会变成 500 而不是 409。正确写法是从 `Prisma` 命名空间上取。
import { Prisma } from '@prisma/client';

import prisma from '../utils/prisma.js';
import { CODE, httpError } from '../utils/response.js';
import { requireArticleForWrite } from './article.service.js';

/**
 * 把「重复点赞」翻译成 409。
 *
 * 为什么必须捕获 P2002 而不是先查后写：
 * 应用层的「先 findUnique 查是否已赞、再 create」存在竞态窗口 —— 两个并发请求
 * 都在对方写入前查到「未赞过」，然后都会执行 INSERT。只有 `likes` 表上的
 * 唯一约束 `likes_user_id_article_id_key` 能真正拦住第二个。
 * 所以这里**直接 create**，把数据库抛的 P2002（底层 MySQL 1062）转成业务错误。
 *
 * @param {number} articleId
 * @param {number} userId 来自 token，不接受请求体里的身份字段
 * @returns {Promise<{ liked: true, likeCount: number }>}
 */
export async function likeArticle(articleId, userId) {
  // 文章不存在或已软删一律 404。必须在任何写操作之前，与 DELETE /api/articles/:id
  // 的判断顺序一致（先存在性、后权限/写入）。
  await requireArticleForWrite(articleId);

  try {
    await prisma.like.create({
      data: { userId, articleId },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw httpError(409, CODE.CONFLICT, '已点赞过这篇文章');
    }

    throw error;
  }

  return {
    liked: true,
    likeCount: await countLikes(articleId),
  };
}

/**
 * 取消点赞。
 *
 * 用 `deleteMany` 而不是 `delete`：后者在记录不存在时抛 P2025，
 * 前者返回 `{ count }`，用 `count === 0` 判断「本来就没赞过」更直接。
 *
 * @param {number} articleId
 * @param {number} userId
 * @returns {Promise<{ liked: false, likeCount: number }>}
 */
export async function unlikeArticle(articleId, userId) {
  await requireArticleForWrite(articleId);

  const { count } = await prisma.like.deleteMany({
    where: { userId, articleId },
  });

  if (count === 0) {
    // 返回 404 而不是静默成功：两个状态语义不同（「文章不存在」与「你没赞过」），
    // 静默成功会让前端分不清「已取消」和「本来就没赞」。
    throw httpError(404, CODE.NOT_FOUND, '还没有点赞过这篇文章');
  }

  return {
    liked: false,
    likeCount: await countLikes(articleId),
  };
}

/**
 * 某篇文章的点赞数。实时 COUNT(*)，不在 articles 表存冗余列。
 *
 * @param {number} articleId
 * @returns {Promise<number>}
 */
async function countLikes(articleId) {
  return prisma.like.count({ where: { articleId } });
}
