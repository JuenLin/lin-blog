// 第 10 批「文章配图上传」探针：U API 语义 / V 落盘核对 / W UI 编辑器插入与粘贴拦截
//
// ⚠️ 环境坑（2026-10-18 实证）：本环境 Git Bash 里 curl -F multipart 必 exit=26
//（连第 11 批已知良好的头像上传一样挂）——本探针全程 **Node fetch + FormData**，
// 不要改成 curl，也不要怀疑是服务端坏了。
//
// 与其他探针同一套规矩：一次性 pwprobe 账号、上传文件用完即删（磁盘 + 目录）、
// 自己起的 Chrome 自己关；前置失败 exit 2、有 FAIL 或清理失败 exit 1、全绿 exit 0。
//
// 用法：node scripts/acceptance/probe-image-upload.mjs
import path from 'node:path';
import fs from 'node:fs';
import { CONFIG, sleep, requireCjs, BACKEND, BACKEND_MODULES, ensureDirs } from './lib/config.mjs';
import { cleanupProbeAccounts } from './lib/tmp-account.mjs';
import { attach, cdpAlive } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';

/* ============================ 结果收集 ============================ */

const results = [];
let chromeChild = null;
let session = null;

function check(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} | ${desc} | ${detail}`);
}

function sectionSummary() {
  const groups = {};

  for (const r of results) {
    const g = r.id.charAt(0);
    if (!groups[g]) groups[g] = { pass: 0, fail: 0 };
    groups[g][r.pass ? 'pass' : 'fail'] += 1;
  }

  console.log('\n---- 分组小计 ----');
  for (const [g, s] of Object.entries(groups)) {
    console.log(`${g}组: PASS ${s.pass} / FAIL ${s.fail}`);
  }
}

/* ============================ 上传小工具（Node fetch + FormData） ============================ */

// 标准 1×1 透明 PNG（70 字节，合法 PNG：魔数 + IHDR + IDAT + IEND），
// 能过 fileFilter 的 mimetype 白名单，也能被浏览器当真图渲染（W3 粘贴用同一份）。
const PNG_FULL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function uploadImage({ token = null, field = 'image', file = null, filename = 't.png', type = 'image/png', extraFields = {} } = {}) {
  // 网络层重试（≤2 次，1.5s 退避）：node --watch 偶发自发重启会掐断在途请求（ECONNRESET /
  // fetch failed）。只重试网络层失败，业务 4xx（400/401/409）绝不重试 —— 与全探针同一纪律。
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500);

    try {
      // FormData 不能复用（body 已被消费），每次重试重建。
      return await doUpload({ token, field, file, filename, type, extraFields });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function doUpload({ token, field, file, filename, type, extraFields }) {
  const form = new FormData();

  for (const [k, v] of Object.entries(extraFields)) {
    form.append(k, v);
  }

  if (file) {
    form.append(field, new Blob([file], { type }), filename);
  }

  const res = await fetch(`${CONFIG.api}/articles/upload-image`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });

  const json = await res.json().catch(() => null);

  return { status: res.status, code: json && json.code, message: json && json.message, data: json && json.data };
}

/* ============================ Prisma（仅供账号 userId / 清理核对） ============================ */

let prismaClient = null;
async function getPrisma() {
  if (prismaClient) return prismaClient;

  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));

  prismaClient = new PrismaClient();

  return prismaClient;
}

/* ============================ 前置检查 ============================ */

async function preflight() {
  const res = await fetch(`${CONFIG.api}/health`);
  if (res.status !== 200) {
    console.error(`后端不可用（${CONFIG.api}/health → ${res.status}），先起后端再跑探针`);
    process.exit(2);
  }

  const front = await fetch(CONFIG.frontend)
    .then((r) => r.status)
    .catch(() => 0);
  if (front !== 200) {
    console.error(`前端不可用（${CONFIG.frontend} → ${front}），先起前端再跑探针（必须是 5173）`);
    process.exit(2);
  }
}

/* ============================ 主流程 ============================ */

const stamp = Date.now();
const A = { username: `pwprobe${stamp}a`, password: `probe${stamp}a`, token: null, userId: null };

// 本探针落盘的文件（绝对路径），finally 里逐个删 + 删目录。
const uploadedPaths = [];

async function registerAndLogin(acc) {
  const reg = await apiJson('POST', '/auth/register', {
    body: { username: acc.username, password: acc.password, nickname: acc.username },
  });

  if (reg.status !== 201 && reg.status !== 200) {
    throw new Error(`注册失败 ${acc.username}：${reg.status} ${reg.message}`);
  }

  const login = await apiJson('POST', '/auth/login', {
    body: { username: acc.username, password: acc.password },
  });

  if (!login.data || !login.data.token) {
    throw new Error(`登录失败 ${acc.username}：${login.status} ${login.message}`);
  }

  acc.token = login.data.token;
  acc.userId = login.data.user ? login.data.user.id : null;
}

async function apiJson(method, urlPath, { token = null, body = null } = {}) {
  const res = await fetch(`${CONFIG.api}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const json = await res.json().catch(() => null);

  return { status: res.status, code: json && json.code, message: json && json.message, data: json && json.data };
}

/* ============================ 页面小工具（W 组） ============================ */

async function waitFor(expression, timeout = 8000, interval = 200) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const raw = await session.evaluate(
      `(() => { try { return String(!!(${expression})); } catch (e) { return 'false'; } })()`
    );

    if (raw === 'true') return true;

    await sleep(interval);
  }

  return false;
}

async function gotoAs(token, urlPath) {
  await session.goto(`${CONFIG.frontend}${urlPath}`);

  if (token) {
    await session.evaluate(`localStorage.setItem('token', ${JSON.stringify(token)}); 'ok'`);
  } else {
    await session.evaluate(`localStorage.removeItem('token'); 'ok'`);
  }

  await session.goto(`${CONFIG.frontend}${urlPath}`);
}

/* ============================ 主流程 ============================ */

async function main() {
  await preflight();
  ensureDirs();

  console.log('\n[前置] 注册探针账号 A');
  await registerAndLogin(A);
  console.log(`A id=${A.userId}\n`);

  /* ================= U 组：API 语义 ================= */

  // U1：未登录 → 401 / 40100（auth 中间件在 multer 之前）。
  const u1 = await uploadImage({ file: PNG_FULL, token: null });
  check(
    'U1',
    '未登录上传 → 401 / 40100',
    u1.status === 401 && u1.code === 40100,
    `HTTP ${u1.status} code=${u1.code} msg="${u1.message}"`
  );

  // U2：成功上传 → 200，url 是站内相对路径且落在 /uploads/articles/{userId}/ 下、.png 扩展。
  const u2 = await uploadImage({ file: PNG_FULL, token: A.token });
  const u2url = u2.data && u2.data.url;
  const u2ok =
    u2.status === 200 &&
    u2.code === 0 &&
    typeof u2url === 'string' &&
    u2url.startsWith(`/uploads/articles/${A.userId}/`) &&
    u2url.endsWith('.png');
  check(
    'U2',
    '登录上传 PNG → 200，url=/uploads/articles/{userId}/*.png',
    u2ok,
    `HTTP ${u2.status} url=${u2url}`
  );

  // V1：落盘真实存在（文件名服务端生成：{ts}-{hex}.png，无用户可控成分）。
  const diskPath = path.join(BACKEND, 'uploads', 'articles', String(A.userId), path.basename(u2url || '_'));
  const diskOk = u2ok && fs.existsSync(diskPath) && fs.statSync(diskPath).size === PNG_FULL.length;
  if (u2ok) uploadedPaths.push(diskPath);
  check(
    'V1',
    '落盘文件真实存在且字节数与请求体一致',
    diskOk,
    `path=${diskPath} exists=${fs.existsSync(diskPath)}`
  );

  // U3：非图片 mimetype（text/plain 伪装 .png）→ 400 / 40000（fileFilter 白名单拦截）。
  const u3 = await uploadImage({ file: Buffer.from('hello, not an image'), filename: 't.png', type: 'text/plain', token: A.token });
  check(
    'U3',
    '非图片 mimetype → 400 / 40000（白名单拦截，不看扩展名）',
    u3.status === 400 && u3.code === 40000,
    `HTTP ${u3.status} code=${u3.code} msg="${u3.message}"`
  );

  // U4：超 2MB → 400 / 40000（LIMIT_FILE_SIZE 翻译）。
  const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x89);
  const u4 = await uploadImage({ file: big, token: A.token });
  check(
    'U4',
    '超过 2MB → 400 / 40000',
    u4.status === 400 && u4.code === 40000,
    `HTTP ${u4.status} code=${u4.code} msg="${u4.message}"`
  );

  // U5：multipart 但缺 image 字段（只带别的字段）→ 400 / 40000。
  const u5 = await uploadImage({ file: null, extraFields: { notImage: 'x' }, token: A.token });
  check(
    'U5',
    'multipart 缺 image 字段 → 400 / 40000',
    u5.status === 400 && u5.code === 40000,
    `HTTP ${u5.status} code=${u5.code} msg="${u5.message}"`
  );

  // U6：SVG mimetype → 400（白名单刻意不含 SVG，XSS 面）。
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const u6 = await uploadImage({ file: svg, filename: 'x.svg', type: 'image/svg+xml', token: A.token });
  check(
    'U6',
    'SVG mimetype → 400 / 40000（白名单刻意不含 SVG）',
    u6.status === 400 && u6.code === 40000,
    `HTTP ${u6.status} code=${u6.code} msg="${u6.message}"`
  );

  /* ================= W 组：UI 编辑器插入与粘贴拦截 ================= */

  if (!(await cdpAlive())) {
    chromeChild = (await launchChrome()).child;
    await sleep(1500);
  }

  session = await attach();
  await session.send('Network.enable');

  // W1：编辑器渲染插入图片按钮 + 隐藏 file input（accept 限图片类型）。
  // 路由是 /editor（新建；/editor/:id 是编辑），不能写 /editor/new（会被 :id 吃掉）。
  await gotoAs(A.token, '/editor');
  const w1Ready = await waitFor(
    `Array.from(document.querySelectorAll('.editor-toolbar button')).some((b) => b.textContent.includes('插入图片'))`,
    10000
  );
  const w1input = await session.evaluate(`(() => {
    const input = document.querySelector('.editor-toolbar input[type=file]');
    return input ? { accept: input.accept || '', present: true } : null;
  })()`);
  check(
    'W1',
    '编辑器：插入图片按钮 + file input（accept 限图片）渲染',
    w1Ready && w1input && (w1input.accept || '').includes('image/'),
    `btn=${w1Ready} input=${JSON.stringify(w1input)}`
  );

  // W2：粘贴**非图片**文件 → 被拦截：content 不出现 ![](，也不发上传请求。
  // 粘贴事件派发到 textarea（冒泡到 .editor-content-wrap 的 @paste 监听）。
  const w2 = await session.evaluate(`(async () => {
    const ta = document.querySelector('.editor-content-wrap textarea');
    if (!ta) return 'no-textarea';
    ta.focus();
    const dt = new DataTransfer();
    dt.items.add(new File(['fake word doc'], 'doc.txt', { type: 'text/plain' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 500));
    return ta.value.includes('![](') ? 'leaked' : 'blocked';
  })()`);
  check(
    'W2',
    '粘贴非图片文件被拦截：正文不出现 ![]( 也不发上传',
    w2 === 'blocked',
    `result=${w2}`
  );

  // W3：粘贴 PNG 文件 → 正文插入 ![](url)，url 落在 /uploads/articles/{userId}/。
  const w3 = await session.evaluate(`(async () => {
    const ta = document.querySelector('.editor-content-wrap textarea');
    if (!ta) return 'no-textarea';
    ta.focus();
    // 1×1 PNG 的完整字节（与探针 U2 同源），用 base64 在页面内还原 Blob。
    const b64 = '${PNG_FULL.toString('base64')}';
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    ta.dispatchEvent(ev);
    // 等上传 + 光标插入完成（轮询 5s）。
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (ta.value.includes('![](')) return ta.value;
    }
    return 'timeout';
  })()`);
  const w3ok = typeof w3 === 'string' && w3.includes('![](/uploads/articles/');
  check(
    'W3',
    '粘贴 PNG → 正文自动插入 ![](/uploads/articles/…)',
    w3ok,
    `content=${typeof w3 === 'string' ? w3.slice(0, 90) : w3}`
  );

  // V2：W3 产生的落盘文件也要清（从插入的 markdown 里抠出站内路径 → 磁盘路径）。
  if (w3ok) {
    const m = /!\[\]\((\/uploads\/articles\/[^)]+)\)/.exec(w3);
    if (m) uploadedPaths.push(path.join(BACKEND, m[1].replace(/^\//, '')));
  }
}

/* ============================ 收尾 ============================ */

function summarize() {
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;

  console.log(`\n合计 ${results.length} 条：PASS ${pass} / FAIL ${fail}`);

  if (fail > 0) {
    console.log('\n失败项：');
    results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.id} ${r.desc} → ${r.detail}`));
  }

  return fail === 0 ? 0 : 1;
}

let exitCode = 2;

try {
  await main();

  if (results.length === 0) {
    console.error('\n零断言：main 没跑到第一组就退出了');
    exitCode = 2;
  } else {
    exitCode = summarize();
  }
} catch (error) {
  console.error('\n探针异常终止：', error && error.message ? error.message : error);
  sectionSummary();
  exitCode = 1;
} finally {
  sectionSummary();

  if (session) {
    session.offEvent(() => {});
    session.close();
  }

  if (chromeChild) {
    await stopChrome(chromeChild);
  }

  // 清理 ①：删落盘文件 + 文章图目录（账号专属目录，删空后连目录一起删）。
  try {
    for (const p of uploadedPaths) {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    }
    const userDir = path.join(BACKEND, 'uploads', 'articles', String(A.userId));
    if (fs.existsSync(userDir)) {
      const rest = fs.readdirSync(userDir);
      if (rest.length === 0) fs.rmdirSync(userDir);
      else console.log(`⚠️ 上传目录还剩 ${rest.length} 个文件未清：${rest.join(', ')}`);
    }
    console.log(`\n清理：上传文件 ${uploadedPaths.length} 个已删`);
  } catch (error) {
    console.error('文件清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }

  // 清理 ②：账号（uploads 不进 git、账号表无文件引用，直接走 tmp-account）。
  try {
    const users = await cleanupProbeAccounts([A.username]);
    console.log(`清理：删除探针账号 ${users} 个`);
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
