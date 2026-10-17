import prisma from '../utils/prisma.js';
import { CODE, sendFail } from '../utils/response.js';

/**
 * 管理员权限中间件（第 5 批）。
 *
 * **必须挂在 auth 之后**：auth 先验签 + 封禁检查（BANNED → 401 / 40101），
 * 这里再查 role。反过来会让未登录用户先撞 401，非登录用户撞 403——
 * 失败码顺序应为「先认证后授权」。
 *
 * 判据是 DB 实时查 role：JWT payload 不放 role（放了则任命 / 罢免后旧 token
 * 不失效），与 auth 中间件查 status 同一机制。
 *
 * 查不到用户（已软删）或 role !== 'ADMIN' 一律 403 / 40300：
 * 权限判定失败不区分「用户不存在」与「不是管理员」，不泄露存在性。
 */
export async function requireAdmin(req, res, next) {
  try {
    const record = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { role: true },
    });

    if (!record || record.role !== 'ADMIN') {
      return sendFail(res, CODE.FORBIDDEN, '需要管理员权限', 403);
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

export default requireAdmin;
