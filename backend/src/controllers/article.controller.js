import {
  createArticle as createArticleService,
  listArticles as listArticlesService,
  getArticleDetail as getArticleDetailService,
  updateArticle as updateArticleService,
  deleteArticle as deleteArticleService,
  autoSaveArticle as autoSaveArticleService,
  listRevisions as listRevisionsService,
  restoreArticle as restoreArticleService,
} from '../services/article.service.js';
import { toUploadUrl } from '../services/upload.service.js';
import { CODE, httpError } from '../utils/response.js';
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

/* ---------- 第 6 批：草稿 / 自动保存 / 版本历史 / 回滚 ---------- */

/**
 * 自动保存草稿。对应 docs/API.md 的 POST /api/articles/auto-save。
 *
 * 返回体由 service 决定：可能是 { id, status:"DRAFT", saved:true }（已建/已更新），
 * 或 { id:null, status:"IDLE", saved:false }（建草稿门槛未过，前端保持 idle）。
 */
export async function autoSave(req, res, next) {
  try {
    const data = await autoSaveArticleService(req.validated.body, req.user.userId);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

/**
 * 文章版本历史。对应 docs/API.md 的 GET /api/articles/:id/revisions。
 * 全量 content（方案 A），前端抽屉直接预览。
 */
export async function revisions(req, res, next) {
  try {
    const data = await listRevisionsService(req.validated.params.id, req.user.userId);

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

/**
 * 回滚到指定版本。对应 docs/API.md 的 POST /api/articles/:id/restore。
 * revisionId 来自已校验的请求体。
 */
export async function restore(req, res, next) {
  try {
    const data = await restoreArticleService(
      req.validated.params.id,
      req.validated.body.revisionId,
      req.user.userId,
    );

    return sendOk(res, data);
  } catch (error) {
    return next(error);
  }
}

/* ---------- 第 10 批：文章配图上传 ---------- */

/**
 * 上传文章配图。对应 docs/API.md 的 POST /api/articles/upload-image。
 *
 * **只落盘、不写库**：返回站内 URL，由前端插入正文 Markdown（![](url)），
 * 随文章 content 一起存储。articles 表不加图片列——图片就是正文的一部分。
 *
 * req.file 为 undefined 的两种路径：① 非 multipart 请求（multer 直接放行）；
 * ② multipart 但没带文件。都按 400 / 40000 处理（字段名规则见 multer 错误翻译）。
 */
export async function uploadImage(req, res, next) {
  try {
    if (!req.file) {
      throw httpError(400, CODE.PARAM_ERROR, '请选择要上传的图片（字段名 image）');
    }

    return sendOk(res, { url: toUploadUrl(req.file) });
  } catch (error) {
    return next(error);
  }
}
