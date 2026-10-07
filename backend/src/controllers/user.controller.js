import {
  updateProfile as updateProfileService,
  updateAvatar as updateAvatarService,
  getUserDetail as getUserDetailService,
  listArticlesByUser as listArticlesByUserService,
  listLikedArticles as listLikedArticlesService,
} from '../services/user.service.js';
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

/* ---------- 第2 批：用户主页接口 ---------- */

/**
 * 用户详情（公开只读）。对应 docs/API.md 的 GET /api/users/:id。
 *
 * 返回 public user + articleCount / receivedLikeCount / receivedCommentCount，
 * 三个计数在 service 里实时 COUNT(*) 得出（docs/DB.md 第 2 批登记②）。
 *
 * id 取自已通过 zod 校验的路径参数，控制器不再重复校验。
 */
export async function getUserDetail(req, res, next) {
  try {
    const data = await getUserDetailService(req.validated.params.id);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

/**
 * 某用户的文章列表（个人主页「文章」Tab）。对应 docs/API.md 的
 * GET /api/users/:id/articles。
 *
 * req.query 整个透传给 service —— 分页与排序的解析（parsePagination）、
 * 白名单、默认值全在 service 那一层，控制器不重复实现。
 */
export async function listArticlesByUser(req, res, next) {
  try {
    const data = await listArticlesByUserService(req.validated.params.id, req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

/**
 * 当前用户点赞过的文章列表。对应 docs/API.md 的 GET /api/users/me/likes。
 *
 * userId **只取自 token**，不接受路径参数 —— 路径就是 /me/likes，没有 id 可传。
 * 未登录由 auth 中间件先挡掉（401 / 40100），控制器不处理未登录情形。
 */
export async function listLikedArticles(req, res, next) {
  try {
    const data = await listLikedArticlesService({
      userId: req.user.userId,
      query: req.query,
    });

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
