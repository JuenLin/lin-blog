import { updateProfile as updateProfileService } from '../services/user.service.js';
import { sendOk } from '../utils/response.js';

/**
 * 修改当前用户的资料（头像 / 简介）。对应 docs/API.md 的 PUT /api/users/me。
 *
 * userId 取自 token，不接受请求体传值。请求体整个透传给 service——
 * 三态语义需要「键是否出现」这个信息，service 层用 hasOwnProperty 自行判断，
 * 这里不要提前展开或挑字段，否则会丢掉「键是否存在」的差别。
 */
export async function updateProfile(req, res, next) {
  try {
    const user = await updateProfileService({
      userId: req.user.userId,
      body: req.validated.body,
    });

    return sendOk(res, user, 200, '资料已更新');
  } catch (error) {
    return next(error);
  }
}
