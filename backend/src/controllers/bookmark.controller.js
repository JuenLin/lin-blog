import {
  bookmarkArticle as bookmarkArticleService,
  unbookmarkArticle as unbookmarkArticleService,
  hasBookmarked as hasBookmarkedService,
} from '../services/bookmark.service.js';
import { sendOk } from '../utils/response.js';

// 与 like.controller.js 同构：不做业务判断，只转发 service 的结果或错误。
// 收藏者身份取 req.user.userId（由 auth 中间件注入），**不接受请求体里的任何身份字段**。

export async function bookmark(req, res, next) {
  try {
    const data = await bookmarkArticleService(req.validated.params.id, req.user.userId);

    return sendOk(res, data, 200, '已收藏');
  } catch (error) {
    return next(error);
  }
}

export async function unbookmark(req, res, next) {
  try {
    const data = await unbookmarkArticleService(req.validated.params.id, req.user.userId);

    return sendOk(res, data, 200, '已取消收藏');
  } catch (error) {
    return next(error);
  }
}

export async function hasBookmarked(req, res, next) {
  try {
    const data = await hasBookmarkedService(req.validated.params.id, req.user.userId);

    return sendOk(res, data, 200, 'ok');
  } catch (error) {
    return next(error);
  }
}
