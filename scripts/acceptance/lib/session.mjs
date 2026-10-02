// 登录态构造：**不碰用户密码**。
// 借用 backend/.env 里的 JWT_SECRET，按后端 utils/jwt.js 的 payload（{userId, username}）签一个会话 token。
// 密钥只存在于进程内存中，脚本只输出长度，不输出任何值（契约 §13-16）。
import fs from 'node:fs';
import path from 'node:path';
import { TMP, BACKEND, BACKEND_MODULES, requireCjs } from './config.mjs';

let envLoaded = false;
export function loadBackendEnv() {
  if (envLoaded) return;
  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  envLoaded = true;
}

export function mintToken(userId, username) {
  loadBackendEnv();
  const jwt = requireCjs(path.join(BACKEND_MODULES, 'jsonwebtoken'));
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('取不到 JWT_SECRET，请检查 backend/.env');

  const token = jwt.sign({ userId, username }, secret, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

  const file = path.join(TMP, `token-${userId}-${username}.txt`);
  fs.writeFileSync(file, token, 'utf8');

  // 返回值里刻意不含 secret
  return { token, file, secretLen: secret.length };
}

// 拿 token 反查真实用户资料，避免脚本里的 id / 名字写死。
export async function whoami(token) {
  const res = await fetch(`${process.env.ACCEPTANCE_API || 'http://127.0.0.1:3000/api'}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data;
}
