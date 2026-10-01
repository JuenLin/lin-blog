import { Router } from 'express';
import { z } from 'zod';
import validate from '../middlewares/validate.js';
import auth from '../middlewares/auth.js';
import { register, login, me } from '../controllers/auth.controller.js';

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

export default router;
