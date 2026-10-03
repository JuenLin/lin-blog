import {
  likeArticle as likeArticleService,
  unlikeArticle as unlikeArticleService,
} from '../services/like.service.js';
import { sendOk } from '../utils/response.js';

// 与 article/comment controller 同构：不做业务判断，只转发 service 的结果或错误。
// 点赞者身份取 req.user.userId（由 auth 中间件注入），**不接受请求体里的任何身份字段**。

export async function like(req, res, next) {
  try {
    const data = await likeArticleService(req.validated.params.id, req.user.userId);

    return sendOk(res, data, 200, '已点赞');
  } catch (error) {
    return next(error);
  }
}

export async function unlike(req, res, next) {
  try {
    const data = await unlikeArticleService(req.validated.params.id, req.user.userId);

    return sendOk(res, data, 200, '已取消点赞');
  } catch (error) {
    return next(error);
  }
}
