import { Router } from 'express';
import { sendOk } from '../utils/response.js';

const router = Router();

router.get('/', (req, res) => {
  return sendOk(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
});

export default router;
