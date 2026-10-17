import { Router } from 'express';
import auth from '../middlewares/auth.js';
import requireAdmin from '../middlewares/requireAdmin.js';
import validate from '../middlewares/validate.js';
import { articleIdParamSchema } from '../validators/article.validator.js';
import { commentIdParamSchema } from '../validators/comment.validator.js';
import { userIdParamSchema } from '../validators/user.validator.js';
import { updateUserStatusSchema } from '../validators/admin.validator.js';
import {
  getStats,
  listUsers,
  updateUserStatus,
  listArticles,
  deleteArticle,
  listComments,
  deleteComment,
} from '../controllers/admin.controller.js';

// 第 5 批管理端路由（docs/API.md「管理端接口（第 5 批）」）。
// 全部走 auth → requireAdmin 链：auth 验签 + 封禁检查（BANNED → 401/40101），
// requireAdmin 查 role（非 ADMIN → 403/40300）。
//
// 列表接口（GET）**不挂 validate({ query })**：分页四参数、keyword、status /
// deleted 筛选全部由 service 层 parse（parsePagination / parseKeyword /
// parseUserStatus / parseDeletedFilter），与 GET /api/articles 同一模式。
// 只有 body 与路径参数走 validate 中间件。

const adminRouter = Router();

adminRouter.get('/stats', auth, requireAdmin, getStats);
adminRouter.get('/users', auth, requireAdmin, listUsers);
adminRouter.patch(
  '/users/:id/status',
  auth,
  requireAdmin,
  validate({ params: userIdParamSchema, body: updateUserStatusSchema }),
  updateUserStatus
);
adminRouter.get('/articles', auth, requireAdmin, listArticles);
adminRouter.delete('/articles/:id', auth, requireAdmin, validate({ params: articleIdParamSchema }), deleteArticle);
adminRouter.get('/comments', auth, requireAdmin, listComments);
adminRouter.delete('/comments/:id', auth, requireAdmin, validate({ params: commentIdParamSchema }), deleteComment);

export default adminRouter;
