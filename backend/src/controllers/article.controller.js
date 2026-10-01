import {
  createArticle as createArticleService,
  listArticles as listArticlesService,
  getArticleDetail as getArticleDetailService,
  updateArticle as updateArticleService,
  deleteArticle as deleteArticleService,
} from '../services/article.service.js';
import { sendOk, sendCreated } from '../utils/response.js';

// controller 只做三件事：取参数、调 service、统一响应。
// 业务判断（404 / 403）都在 service 里抛 httpError，这里不翻译、不吞掉。
export async function create(req, res, next) {
  try {
    const article = await createArticleService(req.validated.body, req.user.userId);

    return sendCreated(res, article);
  } catch (error) {
    return next(error);
  }
}

export async function list(req, res, next) {
  try {
    const data = await listArticlesService(req.query);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

export async function detail(req, res, next) {
  try {
    const article = await getArticleDetailService(req.validated.params.id);

    return sendOk(res, article);
  } catch (error) {
    return next(error);
  }
}

export async function update(req, res, next) {
  try {
    const article = await updateArticleService(req.validated.params.id, req.validated.body, req.user.userId);

    return sendOk(res, article);
  } catch (error) {
    return next(error);
  }
}

export async function remove(req, res, next) {
  try {
    const data = await deleteArticleService(req.validated.params.id, req.user.userId);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}
