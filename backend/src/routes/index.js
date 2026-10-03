import { Router } from 'express';
import authRoutes from './auth.routes.js';
import healthRoutes from './health.routes.js';
import articleRoutes from './article.routes.js';
import userRoutes from './user.routes.js';
import { commentRootRouter, commentArticleRouter } from './comment.routes.js';
import { likeArticleRouter } from './like.routes.js';

const router = Router();

// 通用骨架路由
router.use('/auth', authRoutes);
router.use('/health', healthRoutes);

// 业务路由：文章
router.use('/articles', articleRoutes);

// 业务路由：用户（第九批起只有 PUT /api/users/me，见 docs/API.md）
router.use('/users', userRoutes);

// 业务路由：评论。
// 评论列表挂在文章下（/api/articles/:id/comments），发表评论是顶层资源（/api/comments），
// 所以 commentArticleRouter 挂 /articles、commentRootRouter 挂 /comments。
router.use('/articles', commentArticleRouter);
router.use('/comments', commentRootRouter);

// 业务路由：点赞（第十批）。只有 /api/articles/:id/like 两个方法，挂 /articles。
// 挂在 articleRoutes 之后不影响路由匹配：articleRoutes 只注册了 '/', '/:id' 的
// GET/PUT/DELETE，不会截获 POST|DELETE /:id/like。
router.use('/articles', likeArticleRouter);

export default router;
