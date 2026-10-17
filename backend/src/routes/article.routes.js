import { Router } from 'express';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import {
  createArticleSchema,
  updateArticleSchema,
  articleIdParamSchema,
  autoSaveSchema,
  restoreSchema,
} from '../validators/article.validator.js';
import {
  create,
  list,
  detail,
  update,
  remove,
  autoSave,
  revisions,
  restore,
} from '../controllers/article.controller.js';

const router = Router();

// 挂载在 /api/articles。
// 需要登录的接口：发布 / 编辑 / 删除；列表与详情公开。

// 第 6 批：自动保存草稿。必须注册在 `/:id` 之前——否则 `auto-save` 会被 `/:id`
// 的 articleIdParamSchema 当成 id 去 coerce('auto-save') → NaN → 400。
router.post('/auto-save', auth, validate({ body: autoSaveSchema }), autoSave);
router.post('/', auth, validate({ body: createArticleSchema }), create);
router.get('/', list);
router.get('/:id', validate({ params: articleIdParamSchema }), detail);
router.put('/:id', auth, validate({ params: articleIdParamSchema, body: updateArticleSchema }), update);
router.delete('/:id', auth, validate({ params: articleIdParamSchema }), remove);

// 第 6 批：版本历史 / 回滚，挂在文章资源下，需登录且限作者本人。
// `/:id/revisions` 与 `/:id/restore` 是两段路径，不会与上面的 `/:id` 单段冲突。
router.get('/:id/revisions', auth, validate({ params: articleIdParamSchema }), revisions);
router.post('/:id/restore', auth, validate({ params: articleIdParamSchema, body: restoreSchema }), restore);

export default router;
