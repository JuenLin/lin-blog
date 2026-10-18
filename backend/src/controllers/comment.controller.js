import {
  createComment as createCommentService,
  listCommentsByArticle as listCommentsByArticleService,
  deleteComment as deleteCommentService,
} from '../services/comment.service.js';
import {
  likeComment as likeCommentService,
  unlikeComment as unlikeCommentService,
  isCommentLiked as isCommentLikedService,
} from '../services/comment-like.service.js';
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

// 第 11 批：viewerId 来自 optionalAuth（未登录时 req.user 不存在 → null → 列表省略 liked 键）。
export async function listByArticle(req, res, next) {
  try {
    const viewerId = req.user ? req.user.userId : null;
    const data = await listCommentsByArticleService(req.validated.params.id, req.query, viewerId);

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

/* ---------- 第 11 批：评论点赞（幂等 200，与文章点赞的 409/404 刻意相反） ---------- */

export async function like(req, res, next) {
  try {
    const data = await likeCommentService(req.validated.params.id, req.user.userId);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function unlike(req, res, next) {
  try {
    const data = await unlikeCommentService(req.validated.params.id, req.user.userId);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function liked(req, res, next) {
  try {
    const data = await isCommentLikedService(req.validated.params.id, req.user.userId);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
