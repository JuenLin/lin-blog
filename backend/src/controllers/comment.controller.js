import {
  createComment as createCommentService,
  listCommentsByArticle as listCommentsByArticleService,
  deleteComment as deleteCommentService,
} from '../services/comment.service.js';
import { sendOk, sendCreated } from '../utils/response.js';

// 与 article.controller.js 同构：controller 不做业务判断，只转发 service 的结果或错误。
export async function create(req, res, next) {
  try {
    const comment = await createCommentService(req.validated.body, req.user.userId);

    return sendCreated(res, comment);
  } catch (error) {
    return next(error);
  }
}

export async function listByArticle(req, res, next) {
  try {
    const data = await listCommentsByArticleService(req.validated.params.id, req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

// 与 article.controller.js 的 remove 同构：controller 不做业务判断，只转发 service 结果或错误。
export async function remove(req, res, next) {
  try {
    const data = await deleteCommentService(req.validated.params.id, req.user.userId);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
