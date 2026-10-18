import { Router } from 'express';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import optionalAuth from '../middlewares/optional-auth.js';
import { createCommentSchema, articleIdParamSchema, commentIdParamSchema } from '../validators/comment.validator.js';
import { create, listByArticle, remove, like, unlike, liked } from '../controllers/comment.controller.js';

// 评论的两组接口挂在不同前缀下，所以这里导出两个 router，
// 由 routes/index.js 分别挂载，避免把 POST /api/comments 误挂到 /api/articles 下。

// 挂载在 /api/comments：POST /api/comments、DELETE /api/comments/:id、
// 第 11 批的评论点赞三件套（POST / DELETE /:id/like、GET /:id/liked）。
export const commentRootRouter = Router();

commentRootRouter.post('/', auth, validate({ body: createCommentSchema }), create);
commentRootRouter.delete('/:id', auth, validate({ params: commentIdParamSchema }), remove);

// 第 11 批：评论点赞。**幂等 200**（bookmark / follow 族），与文章点赞的 409/404 刻意相反。
// 顺序与文章侧同构：auth 在 validate 前——先确认身份再校验参数，
// 避免未登录的人拿构造的参数探测校验错误信息。
commentRootRouter.post('/:id/like', auth, validate({ params: commentIdParamSchema }), like);
commentRootRouter.delete('/:id/like', auth, validate({ params: commentIdParamSchema }), unlike);
commentRootRouter.get('/:id/liked', auth, validate({ params: commentIdParamSchema }), liked);

// 挂载在 /api/articles：GET /api/articles/:id/comments
// 第 11 批：列表是公开接口，但挂 optionalAuth——携带合法 token 时每项附加 liked 布尔；
// 无 token / 验签失败静默当匿名（绝不 401，公开接口对未登录读者永远可用）。
export const commentArticleRouter = Router();

commentArticleRouter.get('/:id/comments', optionalAuth, validate({ params: articleIdParamSchema }), listByArticle);
