import { Router } from 'express';
import auth from '../middlewares/auth.js';
import validate from '../middlewares/validate.js';
import { list, unreadCount, markRead, markReadOne } from '../controllers/notification.controller.js';
import { markReadSchema, notificationIdParamSchema } from '../validators/notification.validator.js';

// 挂载在 /api/notifications（第 8 批）。四个接口全部需登录（router.use(auth)）。
const router = Router();

router.use(auth);

router.get('/', list);
router.get('/unread-count', unreadCount);
router.put('/read', validate({ body: markReadSchema }), markRead);
router.put('/:id/read', validate({ params: notificationIdParamSchema }), markReadOne);

export default router;
