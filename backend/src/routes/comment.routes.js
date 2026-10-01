import { Router } from 'express';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import { createCommentSchema, articleIdParamSchema } from '../validators/comment.validator.js';
import { create, listByArticle } from '../controllers/comment.controller.js';

// 评论的两个接口挂在不同前缀下，所以这里导出两个 router，
// 由 routes/index.js 分别挂载，避免把 POST /api/comments 误挂到 /api/articles 下。

// 挂载在 /api/comments：POST /api/comments
export const commentRootRouter = Router();

commentRootRouter.post('/', auth, validate({ body: createCommentSchema }), create);

// 挂载在 /api/articles：GET /api/articles/:id/comments
export const commentArticleRouter = Router();

commentArticleRouter.get('/:id/comments', validate({ params: articleIdParamSchema }), listByArticle);
