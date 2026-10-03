import { Router } from 'express';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import { updateProfile } from '../controllers/user.controller.js';
import { updateProfileSchema } from '../validators/user.validator.js';

const router = Router();

/**
 * 修改当前用户的资料。
 *
 * 路径用 `/me` 而不是 `/:id`：本接口**只允许改自己**，不接受路径参数指定用户。
 * 理由见 docs/API.md 的 PUT /api/users/me 章节——用 `/:id` 会把「用户管理」
 * 语义一并打开，且路径参数可枚举。契约第 5 节列的 PUT /api/users/:id
 * 保持未实现，两者不是同一个路径。
 *
 * 中间件顺序：**auth 必须在 validate 之前**。先确认身份再校验请求体，
 * 避免未登录的人拿构造的请求体探测参数错误信息。
 */
router.put('/me', auth, validate({ body: updateProfileSchema }), updateProfile);

export default router;
