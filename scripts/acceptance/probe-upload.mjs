// 第十一批 头像上传（POST /api/users/me/avatar）量化探针：把 docs/API.md 写死的语义逐条变成可度量的断言。
// 与 probe-profile-edit.mjs 同构：只打后端 API + 直接核对磁盘，**不依赖 Chrome**。
//
// 覆盖 docs/API.md「POST /api/users/me/avatar」：
//   A. 成功路径（4 条）
//      1. 真传 PNG → 201，avatar 是 /uploads/avatars/{userId}/{ts}-{16hex}.{ext} 格式
//      2. originalname 不参与命名（故意传 ../../evil.html）
//      3. 文件确实落在 backend/uploads/ 下，字节数与上传一致
//      4. 静态可访问：GET /uploads/... → 200 + image/*
//   B. 静态目录的两个安全项（2 条）
//      5. 目录列表已关（GET /uploads/avatars/{id}/ → 404）
//      6. 点文件被拒（GET /uploads/.env → 404）
//   C. 失败分支（6 条）
//      7. 非 multipart（JSON）→ 40000
//      8. multipart 但无文件 → 40000
//      9. 字段名不是 avatar → 40000
//     10. mimetype 不在白名单（image/gif）→ 40000
//     11. 超过 2MB → 40000
//     12. 未登录 → 40100
//   D. 旧文件清理（2 条，磁盘核对）
//     13. 二次上传 → 旧文件删、新文件在
//     14. PUT /me 传 avatar: null → 清空且旧文件删
//   E. 放宽后的 avatar 校验（2 条，与 probe-profile-edit.mjs 的 PE-B5 呼应）
//     15. PUT /me 传 /uploads/ 站内路径 → 放行
//     16. PUT /me 传 javascript: → 40000（伪协议仍挡）
//   F. 回收与基线（2 条）
//     17. 上传目录已清空
//     18. users 表条数与跑之前一致（一次性账号已删）
//
// **为什么写操作全用一次性账号**：本接口只认 token 里的 userId，
// 用 admin / demo 会改真实用户资料。注册 pwprobe 前缀账号后所有写操作只动它自己，
// finally 里硬删除（lib/tmp-account.mjs 只接受带该前缀的用户名，二次保险）。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, BACKEND, BACKEND_MODULES, requireCjs, httpOk } from './lib/config.mjs';
import { cleanupProbeAccounts } from './lib/tmp-account.mjs';

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `upload-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

// 静态目录挂在 /uploads（不带 /api），接口在 /api —— 拼 URL 时必须去掉 /api。
const ORIGIN = CONFIG.api.replace(/\/api$/, '');
const AVATAR_URL = `${CONFIG.api}/users/me/avatar`;
const ME_URL = `${CONFIG.api}/users/me`;
const REGISTER_URL = `${CONFIG.api}/auth/register`;
const LOGIN_URL = `${CONFIG.api}/auth/login`;
const UPLOAD_ROOT = path.join(BACKEND, 'uploads');

// 一次性账号。用户名必须带 pwprobe 前缀 —— lib/tmp-account.mjs 只删带该前缀的账号。
const ACCOUNT = {
  username: `pwprobe${Date.now()}${Math.floor(Math.random() * 1000)}`,
  password: 'Original#2026',
};

async function jsonCall(url, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 响应体非 JSON 时留 null */
  }
  return { status: res.status, json };
}

// 1×1 PNG（真实字节）—— 保证落盘后确实是一张合法图片，静态访问能返回 image/png
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeFile(sizeBytes, mime = 'image/png') {
  // 需要 >2MB 时在合法 PNG 尾部补零：只为触发 limits.fileSize，不追求仍是合法图
  const buf = Buffer.alloc(Math.max(sizeBytes, PNG_1X1.length));
  PNG_1X1.copy(buf);
  return new Blob([buf], { type: mime });
}

/**
 * 发一次 multipart 上传。
 *
 * 文件名**故意用 `../../evil.html`**：用来验证服务端不拿原始文件名参与命名 / 拼路径。
 * 这是本接口最重要的一条安全断言——文件名完全由客户端控制，一旦参与命名就是路径穿越。
 */
async function upload(token, { blob = makeFile(PNG_1X1.length), field = 'avatar', textOnly = false } = {}) {
  const form = new FormData();

  if (textOnly) {
    form.append('nickname', 'x');
  } else {
    form.append(field, blob, '../../evil.html');
  }

  const res = await fetch(AVATAR_URL, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 忽略 */
  }
  return { status: res.status, json };
}

const codeOf = (r) => (r.json && r.json.code) !== undefined ? r.json.code : null;
const msgOf = (r) => (r.json && r.json.message) || '';

// 站内相对路径 → 磁盘绝对路径
const toDisk = (avatar) => path.join(UPLOAD_ROOT, String(avatar || '').replace(/^\/uploads\//, ''));

async function countUsers() {
  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));
  const prisma = new PrismaClient();
  try {
    return await prisma.user.count();
  } finally {
    await prisma.$disconnect();
  }
}

let accountCreated = false;

try {
  if ((await httpOk(`${CONFIG.api}/articles?page=1&pageSize=1`)) !== 200) {
    throw new Error(`后端 ${CONFIG.api} 探不到。请先起后端 3000。`);
  }

  const before = await countUsers();

  // ---------- 准备：一次性账号 ----------
  const reg = await jsonCall(REGISTER_URL, { method: 'POST', body: ACCOUNT });
  if (reg.status !== 201 || codeOf(reg) !== 0) {
    throw new Error(`注册一次性账号失败：status=${reg.status} body=${JSON.stringify(reg.json)}`);
  }
  accountCreated = true;

  const login = await jsonCall(LOGIN_URL, { method: 'POST', body: ACCOUNT });
  const token = login.json && login.json.data && login.json.data.token;
  if (!token) throw new Error(`登录失败：status=${login.status} body=${JSON.stringify(login.json)}`);

  const userId = reg.json.data.id;
  console.log(`一次性账号 ${ACCOUNT.username}（id=${userId}）已就绪\n`);

  let firstFile = null;
  let firstAvatar = null;

  // ---------- A1. 真传一个文件 → 201 ----------
  const up = await upload(token);
  const okA1 = up.status === 201 && codeOf(up) === 0;
  log('UP-A1 真传 PNG → 201 且 code=0', okA1, `status=${up.status} code=${codeOf(up)} avatar=${up.json && up.json.data && up.json.data.avatar}`);
  if (!okA1) throw new Error('上传失败，后续用例无意义，提前中止');

  firstAvatar = up.json.data.avatar;

  // ---------- A2. avatar 形状 ----------
  const shapeOk = /^\/uploads\/avatars\/\d+\/\d+-[0-9a-f]{16}\.(png|jpg|webp)$/.test(firstAvatar);
  log('UP-A2 avatar 形状 = /uploads/avatars/{userId}/{ts}-{16hex}.{ext}', shapeOk, firstAvatar);

  // ---------- A3. originalname 不参与命名 ----------
  const safe = !/evil|\.\.|\.html/i.test(firstAvatar);
  log('UP-A3 originalname 未参与命名（上传时传的是 ../../evil.html）', safe, firstAvatar);

  // ---------- A4. 落盘 + 字节数一致 ----------
  firstFile = toDisk(firstAvatar);
  const size = fs.existsSync(firstFile) ? fs.statSync(firstFile).size : -1;
  log('UP-A4 文件落在 backend/uploads/ 下且字节数一致', size === PNG_1X1.length, `${firstFile} size=${size} 期望=${PNG_1X1.length}`);

  // ---------- A5. 静态可访问 ----------
  const img = await fetch(`${ORIGIN}${firstAvatar}`);
  const ct = img.headers.get('content-type') || '';
  log('UP-A5 GET /uploads/... 可访问且 content-type 是 image/*', img.status === 200 && ct.startsWith('image/'), `status=${img.status} content-type=${ct}`);

  // ---------- B1. 目录列表已关 ----------
  const dir = await fetch(`${ORIGIN}/uploads/avatars/${userId}/`);
  log('UP-B1 目录列表已关（index: false）→ 404', dir.status === 404, `status=${dir.status}`);

  // ---------- B2. 点文件被拒 ----------
  const dot = await fetch(`${ORIGIN}/uploads/.env`);
  log('UP-B2 点文件被拒（dotfiles: deny）→ 404', dot.status === 404, `status=${dot.status}`);

  // ---------- C1. 非 multipart ----------
  const c1 = await jsonCall(AVATAR_URL, { method: 'POST', body: { avatar: 'x' }, token });
  log('UP-C1 非 multipart（JSON）→ 400/40000', c1.status === 400 && codeOf(c1) === 40000, `status=${c1.status} code=${codeOf(c1)} msg=${msgOf(c1)}`);

  // ---------- C2. multipart 但无文件 ----------
  const c2 = await upload(token, { textOnly: true });
  log('UP-C2 multipart 无文件 → 400/40000', c2.status === 400 && codeOf(c2) === 40000, `status=${c2.status} code=${codeOf(c2)} msg=${msgOf(c2)}`);

  // ---------- C3. 字段名不对 ----------
  const c3 = await upload(token, { field: 'file' });
  log('UP-C3 字段名不是 avatar → 400/40000', c3.status === 400 && codeOf(c3) === 40000, `status=${c3.status} code=${codeOf(c3)} msg=${msgOf(c3)}`);

  // ---------- C4. mimetype 不在白名单 ----------
  const c4 = await upload(token, { blob: makeFile(PNG_1X1.length, 'image/gif') });
  log('UP-C4 image/gif → 400/40000（只放行 JPG/PNG/WebP）', c4.status === 400 && codeOf(c4) === 40000, `status=${c4.status} code=${codeOf(c4)} msg=${msgOf(c4)}`);

  // ---------- C5. 超过 2MB ----------
  const c5 = await upload(token, { blob: makeFile(2 * 1024 * 1024 + 1) });
  log('UP-C5 超过 2MB → 400/40000', c5.status === 400 && codeOf(c5) === 40000, `status=${c5.status} code=${codeOf(c5)} msg=${msgOf(c5)}`);

  // ---------- C6. 未登录 ----------
  const c6 = await upload(null);
  log('UP-C6 未登录 → 401/40100', c6.status === 401 && codeOf(c6) === 40100, `status=${c6.status} code=${codeOf(c6)}`);

  // ---------- D1. 二次上传：旧文件删、新文件在 ----------
  const up2 = await upload(token);
  const secondAvatar = up2.json && up2.json.data && up2.json.data.avatar;
  const secondFile = toDisk(secondAvatar);
  const oldGone = !fs.existsSync(firstFile);
  const newThere = fs.existsSync(secondFile);
  log('UP-D1 二次上传 → 旧文件被删、新文件在（磁盘核对）', up2.status === 201 && oldGone && newThere, `旧存在=${!oldGone} 新=${secondAvatar} 新存在=${newThere}`);

  // ---------- E1. PUT /me 接受站内路径 ----------
  const e1 = await jsonCall(ME_URL, { method: 'PUT', body: { avatar: secondAvatar }, token });
  log('UP-E1 PUT /me 传 /uploads/ 站内路径 → 放行（第十一批放宽）', e1.status === 200 && codeOf(e1) === 0, `status=${e1.status} code=${codeOf(e1)} msg=${msgOf(e1)}`);

  // ---------- E2. PUT /me 仍挡伪协议 ----------
  const e2 = await jsonCall(ME_URL, { method: 'PUT', body: { avatar: 'javascript:alert(1)' }, token });
  log('UP-E2 PUT /me 传 javascript: → 400/40000（伪协议仍挡）', e2.status === 400 && codeOf(e2) === 40000, `status=${e2.status} code=${codeOf(e2)}`);

  // ---------- D2. avatar: null 清空 + 删文件 ----------
  const d2 = await jsonCall(ME_URL, { method: 'PUT', body: { avatar: null }, token });
  const cleared = d2.json && d2.json.data && d2.json.data.avatar === null;
  const gone = !fs.existsSync(secondFile);
  log('UP-D2 PUT /me avatar:null → 头像清空且旧文件被删（磁盘核对）', d2.status === 200 && cleared && gone, `avatar=${d2.json && d2.json.data && d2.json.data.avatar} 文件还在=${!gone}`);

  // ---------- F. 回收与基线 ----------
  const userDir = path.join(UPLOAD_ROOT, 'avatars', String(userId));
  if (fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true });
  log('UP-F1 已清空该账号的上传目录', !fs.existsSync(userDir), userDir);

  const removed = await cleanupProbeAccounts([ACCOUNT.username]);
  const after = await countUsers();
  log('UP-F2 一次性账号已删且 users 条数复原', removed === 1 && after === before, `删除=${removed} users ${before} → ${after}`);
} catch (e) {
  console.log('\n[执行中断] ' + (e && e.message ? e.message : String(e)));
} finally {
  if (accountCreated) {
    await cleanupProbeAccounts([ACCOUNT.username]);
  }
}

const passN = summary.filter((x) => x.ok).length;
console.log(`\n截图目录：${OUT}`);
console.log('===== 头像上传（POST /api/users/me/avatar）探针汇总 =====');
console.log(`通过 ${passN}/${summary.length}`);
summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));

const report = [
  `# 头像上传（POST /api/users/me/avatar）探针报告`,
  ``,
  `- 时间戳目录：${OUT}`,
  `- 结果：${passN}/${summary.length} 通过`,
  `- 自建一次性账号：${ACCOUNT.username}（跑完已删除）`,
  `- 写操作全部发生在一次性账号上；磁盘核对直连 backend/uploads/，不动真实用户文件`,
  ``,
  `| 结果 | 断言 | 证据 |`,
  `| --- | --- | --- |`,
  ...summary.map((x) => `| ${x.ok ? 'PASS' : 'FAIL'} | ${x.label} | ${String(x.detail).replace(/\|/g, '\\|')} |`),
  ``,
].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), report, 'utf8');
console.log(`报告已写入：${path.join(OUT, 'report.md')}`);

process.exit(summary.length > 0 && passN === summary.length ? 0 : 1);
