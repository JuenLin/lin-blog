import { verifyToken } from '../utils/jwt.js';

/**
 * 可选鉴权（第 11 批）：给**公开接口**附加「识别当前用户」的能力，但不强制登录。
 *
 * 与 auth 的区别：
 *   - 无 token / 验签失败 → **静默放行**，req.user 不设置（当匿名处理），
 *     绝不回 401——公开接口对未登录读者必须永远可用；
 *   - 验签成功 → req.user = { userId, username }，service 层据此附加
 *     「当前用户视角」的字段（评论列表的 liked）。
 *
 * **刻意不查 users 表（不校验 status / 存在性）**：本中间件只用于展示侧增强，
 * 不是权限边界——被软删 / 封禁用户的 token 在这里仍能解析出 userId，
 * 最坏情况是他看到自己历史点赞的 liked=true，无任何越权写路径。
 * 需要权限边界的写操作一律用完整 auth（实时查 status，封禁 401/40101）。
 *
 * 为什么不把 liked 做成逐条 GET /comments/:id/liked：一页评论 10 条就是 10 个请求；
 * 也不做 /users/me/comment-likes 全量集合 store：评论赞是稀疏数据（几百条评论赞几条），
 * 全量拉取浪费。列表接口带 token 顺带返回 liked 是两者之间的最小成本方案。
 */
export async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return next();
  }

  try {
    const payload = verifyToken(token);

    req.user = {
      userId: payload.userId,
      username: payload.username,
    };
  } catch {
    // 验签失败（格式 / 过期 / 签名不对）：静默当匿名，与「未登录」同口径。
  }

  return next();
}

export default optionalAuth;
