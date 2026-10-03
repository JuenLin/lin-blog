import { Router } from 'express';
import { z } from 'zod';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import { register, login, me, changePassword } from '../controllers/auth.controller.js';
import { changePasswordSchema } from '../validators/auth.validator.js';

const router = Router();

const registerSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6).max(100),
  nickname: z.string().max(50).optional(),
});

const loginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(100),
});

router.post('/register', validate({ body: registerSchema }), register);
router.post('/login', validate({ body: loginSchema }), login);
router.get('/me', auth, me);

// 修改密码：auth 中间件必须在 validate 之前——先确认身份，再校验请求体，
// 避免未登录的人拿构造的请求体探测参数错误信息。
router.put('/password', auth, validate({ body: changePasswordSchema }), changePassword);

export default router;
