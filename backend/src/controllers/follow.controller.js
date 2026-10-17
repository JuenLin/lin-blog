import {
  followUser as followUserService,
  unfollowUser as unfollowUserService,
  listFollowers as listFollowersService,
  listFollowing as listFollowingService,
} from '../services/follow.service.js';
import { sendOk } from '../utils/response.js';

// 与 user.controller / like.controller 同构：不做业务判断，只转发 service 的结果或错误。
// 关注者身份取 req.user.userId（由 auth 中间件注入），**不接受请求体里的任何身份字段**。

export async function follow(req, res, next) {
  try {
    const data = await followUserService(req.validated.params.id, req.user.userId);

    return sendOk(res, data, 200, '已关注');
  } catch (error) {
    return next(error);
  }
}

export async function unfollow(req, res, next) {
  try {
    const data = await unfollowUserService(req.validated.params.id, req.user.userId);

    return sendOk(res, data, 200, '已取消关注');
  } catch (error) {
    return next(error);
  }
}

export async function listFollowers(req, res, next) {
  try {
    // 公开只读：userId 取路径参数，不要求登录，故不从 req.user 取值。
    const data = await listFollowersService(req.validated.params.id, req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function listFollowing(req, res, next) {
  try {
    const data = await listFollowingService(req.validated.params.id, req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
