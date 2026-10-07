import { Router } from 'express';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import {
  updateProfile,
  uploadAvatar,
  getUserDetail,
  listArticlesByUser,
  listLikedArticles,
} from '../controllers/user.controller.js';
import { updateProfileSchema, userIdParamSchema } from '../validators/user.validator.js';
import { avatarUpload } from '../services/upload.service.js';

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

/**
 * 上传头像（第十一批）。对应 docs/API.md 的 POST /api/users/me/avatar。
 *
 * 中间件顺序：**auth → avatarUpload（multer）**。
 * auth 必须在前，未登录的请求根本不进入 multipart 解析——解析是要收完整请求体的，
 * 让匿名请求触发文件解析等于白送一个放大攻击面。
 *
 * 这里**没有 validate**：请求体是 multipart 不是 JSON，字段规则由 multer 的
 * limits / fileFilter 承担（大小、格式、字段名），不走 zod 那一套。
 *
 * 注意 `/me/avatar` 与 `PUT /me` 是两个独立路径，不是 `/me` 的子资源路由：
 * 前者收文件、后者收字符串，语义不同，合成一个反而要在本函数里分叉。
 */
router.post('/me/avatar', auth, avatarUpload, uploadAvatar);

/**
 * 第 2 批：用户主页三个接口的**注册顺序有硬约束**（docs/API.md 已注明）。
 *
 * `/me/likes` 必须注册在 `/:id` **之前**：Express 按注册先后匹配，
 * 虽然 `/me/likes`（两段）与 `/:id`（一段）段数不同、今天不会真的误匹配，
 * 但一旦将来新增 `/:id/xxx` 形式的两段路径，顺序颠倒就会让 `/me/likes` 被吃掉。
 *先注册具体的、再注册带参数的，是这类路由的通用写法。
 *
 * 中间件顺序：
 *   - getUserDetail / listArticlesByUser **无 auth**（公开只读，匿名可访问）。
 *     validate 只校验路径参数 id是正整数。
 *   - listLikedArticles **只有 auth**：它没有路径参数（id 来自 token），
 *     所以**不挂 validate** —— req.params 是空对象，userIdParamSchema 要求 id 必填，
 *     挂上去会让这个接口恒返回 400。
 *
 * 已知行为：`GET /api/users/me`（不带 /likes）会命中 `/:id` 并回 400，
 * 因为 zod 的 coerce.number() 对'me' 报 NaN。这是**预期行为**（docs/API.md 已登记），
 * 不是 bug —— 不为此加 `GET /me` 别名。
 */
router.get('/me/likes', auth, listLikedArticles);

router.get('/:id/articles', validate({ params: userIdParamSchema }), listArticlesByUser);

router.get('/:id', validate({ params: userIdParamSchema }), getUserDetail);

export default router;
