import { Router } from 'express';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import {
  createArticleSchema,
  updateArticleSchema,
  articleIdParamSchema,
} from '../validators/article.validator.js';
import { create, list, detail, update, remove } from '../controllers/article.controller.js';

const router = Router();

// 挂载在 /api/articles。
// 需要登录的接口：发布 / 编辑 / 删除；列表与详情公开。
router.post('/', auth, validate({ body: createArticleSchema }), create);
router.get('/', list);
router.get('/:id', validate({ params: articleIdParamSchema }), detail);
router.put('/:id', auth, validate({ params: articleIdParamSchema, body: updateArticleSchema }), update);
router.delete('/:id', auth, validate({ params: articleIdParamSchema }), remove);

export default router;
