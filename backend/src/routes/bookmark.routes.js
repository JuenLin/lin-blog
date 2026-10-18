import { Router } from 'express';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import { articleIdParamSchema } from '../validators/article.validator.js';
import { bookmark, unbookmark, hasBookmarked } from '../controllers/bookmark.controller.js';

// 收藏挂在文章下（/api/articles/:id/bookmark），与 like.routes.js 完全同构：
// 只导出一个 router，由 routes/index.js 挂到 /articles。
// 不新建 validators/bookmark.validator.js —— 路径参数 :id 的校验与文章接口
// 完全相同，直接复用 articleIdParamSchema（同 like 的先例）。
export const bookmarkArticleRouter = Router();

// 中间件顺序：auth 必须在 validate 之前。
// 反过来会让未登录用户在参数非法时先拿到 400，暴露参数校验细节（第 9 批的教训）。
//
// ⚠️ 与点赞路由逐行对称、语义相反：这里三个接口全是**幂等 200**
//（重复收藏 / 取消未收藏都不报错），点赞是 409 / 404。差异在 service 层，路由无异样。
bookmarkArticleRouter.post('/:id/bookmark', auth, validate({ params: articleIdParamSchema }), bookmark);
bookmarkArticleRouter.delete('/:id/bookmark', auth, validate({ params: articleIdParamSchema }), unbookmark);
bookmarkArticleRouter.get('/:id/bookmarked', auth, validate({ params: articleIdParamSchema }), hasBookmarked);
