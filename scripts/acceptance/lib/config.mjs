// 验收脚本公共配置：路径全部按「脚本所在位置」推算，和 cwd 无关。
// 只用 Node 内置模块 —— 契约 §13-3 禁止擅自引入项目依赖。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SCRIPT_DIR = path.resolve(here, '..'); // scripts/acceptance
export const ROOT = path.resolve(here, '..', '..', '..'); // 仓库根
export const requireCjs = createRequire(import.meta.url);

// 后端 node_modules：dotenv / @prisma/client 都从这里拿，避免给项目装新依赖。
export const BACKEND = path.join(ROOT, 'backend');
export const BACKEND_MODULES = path.join(BACKEND, 'node_modules');

export const TMP = path.join(os.tmpdir(), 'lin-blog-acceptance');
fs.mkdirSync(TMP, { recursive: true });

export const PREFIX = '验收占位';

export const CONFIG = {
  frontend: process.env.ACCEPTANCE_FRONTEND || 'http://localhost:5173',
  api: process.env.ACCEPTANCE_API || 'http://127.0.0.1:3000/api',
  cdpPort: Number(process.env.CDP_PORT || 9222),
  shots: process.env.ACCEPTANCE_SHOTS || path.join(os.tmpdir(), 'lin-blog-acceptance-shots'),
  adminId: Number(process.env.ACCEPTANCE_ADMIN_ID || 2),
  demoId: Number(process.env.ACCEPTANCE_DEMO_ID || 1),
  pageSize: 10,
  seedCount: 11, // 让总数超过默认每页 10 条，才验得到分页
};

export function ensureDirs() {
  fs.mkdirSync(CONFIG.shots, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 探测本地 HTTP 服务。注意 curl 那套 --noproxy 的坑在这里不存在：
// Node fetch 默认不读 http_proxy，但保留了两个可访问性判断。
export async function httpOk(url, timeout = 4000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ac.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}
