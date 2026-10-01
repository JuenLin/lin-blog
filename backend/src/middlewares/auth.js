import { verifyToken } from '../utils/jwt.js';
import { CODE, sendFail } from '../utils/response.js';

export function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return sendFail(res, CODE.UNAUTHORIZED, '未登录或 token 无效', 401);
  }

  try {
    const payload = verifyToken(token);

    req.user = {
      userId: payload.userId,
      username: payload.username,
    };

    return next();
  } catch (error) {
    return sendFail(res, CODE.UNAUTHORIZED, '未登录或 token 无效', 401);
  }
}

export default auth;
