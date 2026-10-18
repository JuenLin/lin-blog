import { Router } from 'express';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import {
  createSeriesSchema,
  updateSeriesSchema,
  seriesIdParamSchema,
} from '../validators/series.validator.js';
import { userIdParamSchema } from '../validators/user.validator.js';
import {
  create,
  detail,
  update,
  remove,
  listByUser,
} from '../controllers/series.controller.js';

/**
 * 专栏系列路由（第 10 批）。挂 /api/series：
 *   POST   /            创建系列（需登录）
 *   GET    /:id         系列详情含有序文章列表（公开）
 *   PUT    /:id         更新系列（作者或 ADMIN）
 *   DELETE /:id         删除系列（作者或 ADMIN，SET NULL 解绑文章）
 *
 * GET /api/users/:id/series 不在这里——它是用户子资源，由同文件的
 * userSeriesRouter 提供，在 routes/index.js 挂到 /users 下。
 */

const seriesRouter = Router();

// 写操作中间件顺序 auth → validate：先确认身份再校验请求体，
// 避免未登录的人拿构造的请求体探测参数错误信息（同 PUT /api/users/me 的纪律）。
seriesRouter.post('/', auth, validate({ body: createSeriesSchema }), create);

// GET 详情公开：只校验路径参数，无 auth（匿名可看系列）。
seriesRouter.get('/:id', validate({ params: seriesIdParamSchema }), detail);

// PUT / DELETE：auth → validate（作者或 ADMIN 的判断在 service 层，
// 需要 DB 里的 role，中间件里判不了——req.user 不带 role）。
seriesRouter.put('/:id', auth, validate({ params: seriesIdParamSchema, body: updateSeriesSchema }), update);
seriesRouter.delete('/:id', auth, validate({ params: seriesIdParamSchema }), remove);

/**
 * 用户子资源：GET /api/users/:id/series（挂在 /users 下）。
 *
 * 单独一个 Router 而不是塞进 user.routes.js：series 的 controller / service
 * 都在 series 模块，路由也放一起，避免「改系列要动三个文件」。
 * 与 user.routes.js 的 `/:id/articles` 等两段路径无冲突（段数相同但路径字面不同，
 * Express 按注册顺序匹配也不会互相截获）。
 */
const userSeriesRouter = Router();

userSeriesRouter.get('/:id/series', validate({ params: userIdParamSchema }), listByUser);

export { seriesRouter, userSeriesRouter };

export default seriesRouter;
