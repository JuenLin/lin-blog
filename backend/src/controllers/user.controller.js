import { updateProfile as updateProfileService, updateAvatar as updateAvatarService } from '../services/user.service.js';
import { sendOk, sendCreated, httpError, CODE } from '../utils/response.js';

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

/**
 * 上传头像。对应 docs/API.md 的 POST /api/users/me/avatar。
 *
 * 到这里时文件**已经落盘**（multer 在路由里跑在前面），req.file 是磁盘上的文件信息。
 * 剩下的事交给 service：写库、失败回滚删文件、成功删旧头像。
 *
 * 为什么这里还要判一次 req.file：multer 对**非 multipart** 请求是直接 next() 放行的
 * （见 multer/lib/make-middleware.js 首行），此时既不报错也没有文件。
 * 不判的话 service 会拿到 undefined 去读 file.path，崩成 500。
 */
export async function uploadAvatar(req, res, next) {
  try {
    if (!req.file) {
      throw httpError(400, CODE.PARAM_ERROR, '请选择要上传的图片');
    }

    const user = await updateAvatarService({
      userId: req.user.userId,
      file: req.file,
    });

    return sendCreated(res, user, '头像已更新');
  } catch (error) {
    return next(error);
  }
}
