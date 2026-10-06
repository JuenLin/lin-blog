import { Router } from 'express';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import { articleIdParamSchema } from '../validators/article.validator.js';
import { like, unlike, hasLiked } from '../controllers/like.controller.js';

// 点赞挂在文章下（/api/articles/:id/like），所以这里只导出一个 router，
// 由 routes/index.js 挂到 /articles。不新建 validators/like.validator.js ——
// 路径参数 :id 的校验与文章接口完全相同，直接复用 articleIdParamSchema。
export const likeArticleRouter = Router();

// 中间件顺序：auth 必须在 validate 之前。
// 反过来会让未登录用户在参数非法时先拿到 400，暴露了参数校验细节（第九批的教训）。
likeArticleRouter.post('/:id/like', auth, validate({ params: articleIdParamSchema }), like);
likeArticleRouter.delete('/:id/like', auth, validate({ params: articleIdParamSchema }), unlike);
// 第十四批：刷新详情页后还原点赞按钮态。同样「auth → validate」，
// 未登录一律 401，不因参数非法先回 400。
likeArticleRouter.get('/:id/liked', auth, validate({ params: articleIdParamSchema }), hasLiked);
