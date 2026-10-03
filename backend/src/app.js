import express from 'express';
import cors from 'cors';
import routes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middlewares/error.js';
import { UPLOAD_DIR } from './utils/upload.js';

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 静态资源：/uploads/avatars/{userId}/{filename}
//
// 三个选项都是安全项，不是性能项：
//   index: false      —— 关目录列表，否则 GET /uploads/avatars/ 会把用户目录结构列出来
//   dotfiles: 'deny'  —— 拒绝点文件，避免有人在目录里放 .env 之类被取走
//   fallthrough       —— 故意不设成 false。设成 false 时「文件不存在」会走 next(err)，
//                        落到 errorHandler 变成 HTTP 404 + 业务码 50000（服务器错误），
//                        既和全站 404 口径不一致，还会为每个破图打一条 error 堆栈。
//                        用默认的 true，缺失文件继续往下走到 notFoundHandler，
//                        返回 HTTP 404 + 40400「资源不存在」，与其余接口一致。
//
// 注意挂在 /uploads 而不是 /api/uploads：这是静态资源，不是接口，
// 前端拼 URL 时要去掉 baseURL 末尾的 /api（见 docs/API.md 前端调用约定）。
app.use('/uploads', express.static(UPLOAD_DIR, { index: false, dotfiles: 'deny' }));

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
