import { Router } from 'express';
import authRoutes from './auth.routes.js';
import healthRoutes from './health.routes.js';
import articleRoutes from './article.routes.js';
import userRoutes from './user.routes.js';
import { commentRootRouter, commentArticleRouter } from './comment.routes.js';
import { likeArticleRouter } from './like.routes.js';
import { bookmarkArticleRouter } from './bookmark.routes.js';
import adminRoutes from './admin.routes.js';
import tagRoutes from './tag.routes.js';
import notificationRoutes from './notification.routes.js';

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

// 业务路由：收藏（第 9 批）。/api/articles/:id/bookmark 三个方法，挂 /articles。
// 与点赞同构：幂等 200（重复收藏 / 取消未收藏都不报错），语义差异在 service 层。
router.use('/articles', bookmarkArticleRouter);

// 业务路由：标签（第 7 批）。GET /api/tags，公开无需登录。
router.use('/tags', tagRoutes);

// 业务路由：通知中心（第 8 批）。/api/notifications 四个接口，全部需登录。
router.use('/notifications', notificationRoutes);

// 业务路由：管理端（第 5 批）。/api/admin/* 全部走 auth → requireAdmin 链，
// 与 /api/users/* 是两套（管理端用户管理不走 /api/users，见 docs/API.md）。
router.use('/admin', adminRoutes);

export default router;
