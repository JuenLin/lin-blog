import { verifyToken } from '../utils/jwt.js';
import prisma from '../utils/prisma.js';
import { CODE, sendFail } from '../utils/response.js';

/**
 * 鉴权中间件（第 5 批增加封禁检查）。
 *
 * 职责：
 * 1. 解析 Bearer token 并验签（失败 401 / 40100）；
 * 2. **封禁检查**：验签通过后按 userId 主键查 status，BANNED → 401 / 40101，
 *    该用户所有已签发的 token 即刻失效。
 *
 * ## 为什么 JWT 不放 status / role
 * 放了能省这次查询，但封禁 / 改角色后旧 token 不失效——安全上不可接受。
 * 必须 DB 实时查，代价是每个已鉴权请求多一次主键查询，项目规模可接受。
 *
 * ## 为什么用户不存在时放行（不拦）
 * 软删用户 + 有效 token 的既有语义是「放行到 service 层，由 service 返回
 * 404 / 40400」（docs/API.md 的 GET /api/auth/me 失败表）。这里不能把它
 * 改判成 401——那会改变现有接口的失败码口径。只有「查到了且 BANNED」
 * 才拦。
 *
 * ## DB 查询错误不进 401
 * verifyToken 的错（格式 / 过期 / 签名）走 401；DB 查询异常交全局
 * errorHandler（next(error) → 500），不冒充 401。
 */
export async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return sendFail(res, CODE.UNAUTHORIZED, '未登录或 token 无效', 401);
  }

  let payload;

  try {
    payload = verifyToken(token);
  } catch (error) {
    return sendFail(res, CODE.UNAUTHORIZED, '未登录或 token 无效', 401);
  }

  req.user = {
    userId: payload.userId,
    username: payload.username,
  };

  try {
    const record = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { status: true },
    });

    if (record && record.status === 'BANNED') {
      return sendFail(res, CODE.ACCOUNT_BANNED, '账号已封禁', 401);
    }
  } catch (error) {
    return next(error);
  }

  return next();
}

export default auth;
