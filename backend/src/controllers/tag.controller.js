import { listHotTags as listHotTagsService } from '../services/article.service.js';
import { sendOk } from '../utils/response.js';

/**
 * GET /api/tags —— 热门标签列表（第 7 批）。公开无需登录。
 * limit 校验在 service 层（listHotTags），与 parseTag / parseCategory 同层风格。
 */
export async function listHotTags(req, res, next) {
  try {
    const data = await listHotTagsService(req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
