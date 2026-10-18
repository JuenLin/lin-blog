import { Router } from 'express';
import { listHotTags } from '../controllers/tag.controller.js';

// 挂载在 /api/tags（第 7 批）。只有 GET /（热门标签列表），公开无需登录。
const router = Router();

router.get('/', listHotTags);

export default router;
