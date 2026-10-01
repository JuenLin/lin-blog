import { Router } from 'express';
import authRoutes from './auth.routes.js';
import healthRoutes from './health.routes.js';
import articleRoutes from './article.routes.js';
import { commentRootRouter, commentArticleRouter } from './comment.routes.js';

const router = Router();

// 通用骨架路由
router.use('/auth', authRoutes);
router.use('/health', healthRoutes);

// 业务路由：文章
router.use('/articles', articleRoutes);

// 业务路由：评论。
// 评论列表挂在文章下（/api/articles/:id/comments），发表评论是顶层资源（/api/comments），
// 所以 commentArticleRouter 挂 /articles、commentRootRouter 挂 /comments。
router.use('/articles', commentArticleRouter);
router.use('/comments', commentRootRouter);

export default router;
