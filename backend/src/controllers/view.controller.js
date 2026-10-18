import { recordView as recordViewService } from '../services/view.service.js';
import { sendOk } from '../utils/response.js';

/**
 * 记录一次阅读。对应 docs/API.md 的 POST /api/articles/:id/view。
 *
 * **无需登录**（路由上不挂 auth）：ip 取 req.ip 供 service 层判重。
 * 判重命中 / 文章不存在（含草稿、软删）的语义都在 service，
 * 控制器只转发。
 */
export async function recordView(req, res, next) {
  try {
    const data = await recordViewService(req.validated.params.id, req.ip);

    return sendOk(res, data, 200, 'ok');
  } catch (error) {
    return next(error);
  }
}
