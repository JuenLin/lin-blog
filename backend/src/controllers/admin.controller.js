import { sendOk } from '../utils/response.js';
import {
  getStats as getStatsService,
  listUsers as listUsersService,
  updateUserStatus as updateUserStatusService,
  listArticles as listArticlesService,
  deleteArticle as deleteArticleService,
  listComments as listCommentsService,
  deleteComment as deleteCommentService,
} from '../services/admin.service.js';

// 第 5 批管理端控制器。薄封装：解析 req → 调 service → sendOk，
// 错误一律 next(error) 交全局 errorHandler（httpError 的 status / businessCode
// 由它翻成 HTTP 响应）。角色与登录判断在路由层的 auth → requireAdmin 完成。

export async function getStats(req, res, next) {
  try {
    const data = await getStatsService();

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function listUsers(req, res, next) {
  try {
    const data = await listUsersService(req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function updateUserStatus(req, res, next) {
  try {
    const data = await updateUserStatusService(req.validated.params.id, req.validated.body.status);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function listArticles(req, res, next) {
  try {
    const data = await listArticlesService(req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function deleteArticle(req, res, next) {
  try {
    const data = await deleteArticleService(req.validated.params.id);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function listComments(req, res, next) {
  try {
    const data = await listCommentsService(req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function deleteComment(req, res, next) {
  try {
    const data = await deleteCommentService(req.validated.params.id);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
