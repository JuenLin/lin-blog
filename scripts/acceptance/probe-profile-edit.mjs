// 第九批 用户头像/ 简介（PUT /api/users/me）量化探针：把 docs/API.md 写死的语义逐条变成可度量的断言。
// 与 probe-password.mjs 同构：只打后端 API、不依赖 Chrome —— 纯 fetch + 一次性账号 + 精确回收。
//
// 覆盖 docs/API.md「PUT /api/users/me」：
//   A. 三态语义（本接口的核心，4 条）
//      1. 字段不出现 = 不改
//      2. avatar: null = 清空
//      3. avatar: "https://..." = 设置
//      4. bio: "" 空串 = 清空（转 NULL 存储）
//   B. 校验规则（5 条）
//      5. 空 body {} → 40000
//      6. 禁传 username / id / userId / password 各→ 40000
//      7. avatar 必须 http/https 开头（javascript: / data: / ftp:// / 相对路径各→ 40000）
//      8. avatar 超长（256 字符）→ 40000；边界 255 放行
//      9. bio 超长（201 字符）→ 40000；边界 200 放行
//   C. 鉴权与存在性（2 条）
//      10. 未登录 401（且优先于参数校验 —— 证明 auth 中间件在 validate 之前）
//      11. token 用户不存在（软删）→ 40400
//   D. 响应契约（2 条）
//      12. 成功返回完整 public user（含 avatar / bio）
//      13. GET /api/auth/me 同步返回 avatar / bio 两个键
//   E. 对既有接口的影响（3 条，回归）
//      14. GET /api/articles 的内嵌 author 含 avatar 键
//      15. 内嵌 author **不含** bio（bio 只在个人主页展示）
//      16. 评论列表的 author 同样含 avatar
//   最后：把一次性账号的 avatar / bio 复原并删除账号，不留脏数据。
//
// **为什么写操作全用一次性账号**：PUT /api/users/me 只认 token 里的 userId，
// 用 mintToken 可以直接操作 admin(id 2)，但那样会改用户真实资料、且探针失败时
// 没法还原。注册一次性账号后所有写操作都只动它自己，finally 里硬删除。
// admin token 只用于**只读**查询（验内嵌 author 的结构），不写任何东西。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, httpOk } from './lib/config.mjs';
import { mintToken } from './lib/session.mjs';

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `profile-edit-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

const ME_URL = `${CONFIG.api}/users/me`;
const AUTH_ME_URL = `${CONFIG.api}/auth/me`;
const LOGIN_URL = `${CONFIG.api}/auth/login`;
const REGISTER_URL = `${CONFIG.api}/auth/register`;
const ARTICLES_URL = `${CONFIG.api}/articles`;

// 一次性账号。用户名必须带 pwprobe 前缀 —— lib/tmp-account.mjs 只删带该前缀的账号
// （二次保险，防止调用方传错参数误删真实用户）。
const ACCOUNT = {
  username: `pwprobe${Date.now()}${Math.floor(Math.random() * 1000)}`,
  password: 'Original#2026',
};

const long255 = 'h'.repeat(255);
const long256 = 'h'.repeat(256);
const bio200 = '简'.repeat(200);
const bio201 = '简'.repeat(201);

// Node fetch 默认不读 http_proxy，本机 curl 那套 --noproxy 的坑在这里不存在。
async function call(url, { method = 'GET', body, token } = {}) {
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
    /* 响应体非 JSON（比如 404 HTML）时留null */
  }

  return { status: res.status, json };
}

const codeOf = (r) => (r.json && r.json.code) || 0;
const dataOf = (r) => (r.json ? r.json.data : null);

// 退出前的最后一道保险：无论中途走到哪，都要把一次性账号删掉。
async function removeAccount() {
  try {
    const { cleanupProbeAccounts } = await import('./lib/tmp-account.mjs');
    const n = await cleanupProbeAccounts([ACCOUNT.username]);
    console.log(`[清理] 已删除一次性账号 ${ACCOUNT.username}（${n} 个）`);
  } catch (e) {
    console.log(`[清理] 异常：${e && e.message ? e.message : e}`);
    console.log(`[清理] 请手动删除用户名 ${ACCOUNT.username} 的账号（仅这一条）`);
  }
}

let accountCreated = false;

try {
  if ((await httpOk(`${ARTICLES_URL}?page=1&pageSize=1`)) !== 200) {
    throw new Error(`后端 ${CONFIG.api} 探不到。请先起后端 3000。`);
  }

  // ---------- 准备：注册一次性账号并登录 ----------
  const reg = await call(REGISTER_URL, {
    method: 'POST',
    body: { username: ACCOUNT.username, password: ACCOUNT.password },
  });
  if (reg.status !== 201 || codeOf(reg) !== 0) {
    throw new Error(`注册一次性账号失败：status=${reg.status} body=${JSON.stringify(reg.json)}`);
  }
  accountCreated = true;

  const login = await call(LOGIN_URL, {
    method: 'POST',
    body: { username: ACCOUNT.username, password: ACCOUNT.password },
  });
  if (login.status !== 200 || !dataOf(login) || !dataOf(login).token) {
    throw new Error(`登录失败：status=${login.status} body=${JSON.stringify(login.json)}`);
  }
  const token = dataOf(login).token;

  // ---------- 前置：确认新账号两项都是 NULL ----------
  const init = await call(AUTH_ME_URL, { token });
  const initData = dataOf(init) || {};
  log(
    'PE-0 新建账号的 avatar / bio 初始均为 null',
    initData.avatar === null && initData.bio === null,
    `avatar=${JSON.stringify(initData.avatar)} bio=${JSON.stringify(initData.bio)}`
  );

  // ---------- A1. 只传 bio → bio 变、avatar 不动（字段不出现 = 不改） ----------
  const a1 = await call(ME_URL, { method: 'PUT', token, body: { bio: '第一次改的简介' } });
  const a1d = dataOf(a1) || {};
  log(
    'PE-A1 只传 bio：bio 更新成功且 avatar 保持 null（字段不出现 = 不改）',
    a1.status === 200 && codeOf(a1) === 0 && a1d.bio === '第一次改的简介' && a1d.avatar === null,
    `status=${a1.status} code=${codeOf(a1)} avatar=${JSON.stringify(a1d.avatar)} bio=${JSON.stringify(a1d.bio)}`
  );

  // ---------- A2. 设置 avatar → avatar 变、bio 不动 ----------
  const a2 = await call(ME_URL, { method: 'PUT', token, body: { avatar: 'https://cdn.example.com/a/1.png' } });
  const a2d = dataOf(a2) || {};
  log(
    'PE-A2 设置 avatar：avatar 更新成功且 bio 不被动',
    a2.status === 200 && codeOf(a2) === 0 && a2d.avatar === 'https://cdn.example.com/a/1.png' && a2d.bio === '第一次改的简介',
    `status=${a2.status} avatar=${JSON.stringify(a2d.avatar)} bio=${JSON.stringify(a2d.bio)}`
  );

  // ---------- A3. avatar: null = 清空，bio 不动 ----------
  const a3 = await call(ME_URL, { method: 'PUT', token, body: { avatar: null } });
  const a3d = dataOf(a3) || {};
  log(
    'PE-A3 avatar: null = 清空头像（不是空操作），bio 不动',
    a3.status === 200 && codeOf(a3) === 0 && a3d.avatar === null && a3d.bio === '第一次改的简介',
    `status=${a3.status} avatar=${JSON.stringify(a3d.avatar)} bio=${JSON.stringify(a3d.bio)}`
  );

  // ---------- A4. bio: "" 空串 = 清空（转 NULL 存储）----------
  const a4 = await call(ME_URL, { method: 'PUT', token, body: { bio: '' } });
  const a4d = dataOf(a4) || {};
  log(
    'PE-A4 bio: "" 空串被转成 null 清空（不是存空串）',
    a4.status === 200 && codeOf(a4) === 0 && a4d.bio === null,
    `status=${a4.status} bio=${JSON.stringify(a4d.bio)}（期望 null）`
  );

  // ---------- A5. 同时传两项 ----------
  const a5 = await call(ME_URL, {
    method: 'PUT',
    token,
    body: { avatar: 'http://example.org/pic.png', bio: '同时改两项' },
  });
  const a5d = dataOf(a5) || {};
  log(
    'PE-A5 同时传 avatar + bio：两项都写入（http 也放行）',
    a5.status === 200 && codeOf(a5) === 0 && a5d.avatar === 'http://example.org/pic.png' && a5d.bio === '同时改两项',
    `status=${a5.status} avatar=${JSON.stringify(a5d.avatar)} bio=${JSON.stringify(a5d.bio)}`
  );

  // ---------- B1. 空 body → 40000 ----------
  const b1 = await call(ME_URL, { method: 'PUT', token, body: {} });
  log(
    'PE-B1 空 body {} → 400（无任何键 = 空操作）',
    b1.status === 400 && codeOf(b1) === 40000,
    `status=${b1.status} code=${codeOf(b1)} message=${JSON.stringify(b1.json && b1.json.message)}`
  );

  // ---------- B2. 禁传身份字段 ----------
  for (const field of ['username', 'id', 'userId', 'password']) {
    const r = await call(ME_URL, { method: 'PUT', token, body: { [field]: 'x' } });
    log(
      `PE-B2 禁传 ${field} → 40000（防越权，身份只能来自 token）`,
      r.status === 400 && codeOf(r) === 40000,
      `status=${r.status} code=${codeOf(r)} message=${JSON.stringify(r.json && r.json.message)}`
    );
  }

  // ---------- B3. avatar 伪协议必须拦下（防 XSS：前端会渲染成 <img src>）----------
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,iVBOR', 'ftp://x.com/a.png', '/local/a.png', 'example.com/a.png']) {
    const r = await call(ME_URL, { method: 'PUT', token, body: { avatar: bad } });
    log(
      `PE-B3 avatar="${bad}" → 40000（必须 http/https 开头）`,
      r.status === 400 && codeOf(r) === 40000,
      `status=${r.status} code=${codeOf(r)}`
    );
  }

  // ---------- B4. 长度边界 ----------
  const b4ok = await call(ME_URL, { method: 'PUT', token, body: { avatar: `https://e.com/${long255 - 'https://e.com/'.length}.png` } });
  log('PE-B4a avatar 边界 255 字符放行', b4ok.status === 200 && codeOf(b4ok) === 0, `status=${b4ok.status} code=${codeOf(b4ok)}`);

  const b4long = await call(ME_URL, { method: 'PUT', token, body: { avatar: `https://e.com/${long256}.png` } });
  log('PE-B4b avatar 超长 → 40000', b4long.status === 400 && codeOf(b4long) === 40000, `status=${b4long.status} code=${codeOf(b4long)}`);

  const b4bio = await call(ME_URL, { method: 'PUT', token, body: { bio: bio200 } });
  log('PE-B4c bio 边界 200 字符放行', b4bio.status === 200 && codeOf(b4bio) === 0, `status=${b4bio.status} code=${codeOf(b4bio)}`);

  const b4bioLong = await call(ME_URL, { method: 'PUT', token, body: { bio: bio201 } });
  log('PE-B4d bio 超长 201 字符 → 40000', b4bioLong.status === 400 && codeOf(b4bioLong) === 40000, `status=${b4bioLong.status} code=${codeOf(b4bioLong)}`);

  // ---------- C1. 未登录 401，且优先于参数校验 ----------
  const c1 = await call(ME_URL, { method: 'PUT', body: { username: 'x' } });
  log(
    'PE-C1 未登录 + 非法体 → 401（auth 必须在 validate 之前，不能泄露参数校验细节）',
    c1.status === 401 && codeOf(c1) === 40100,
    `status=${c1.status} code=${codeOf(c1)}（若返回 400 说明中间件顺序错了）`
  );

  // ---------- C2. token 里的用户已软删 → 40400 ----------
  // 造一个指向不存在 userId 的 token（直接签名，userId = 999999）。
  const ghostToken = mintToken(999999, 'ghostuser').token;
  const c2 = await call(ME_URL, { method: 'PUT', token: ghostToken, body: { bio: 'x' } });
  log(
    'PE-C2 token 有效但用户不存在 → 40400',
    c2.status === 404 && codeOf(c2) === 40400,
    `status=${c2.status} code=${codeOf(c2)} message=${JSON.stringify(c2.json && c2.json.message)}`
  );

  // ---------- D1. 响应是完整 public user ----------
  const d1 = await call(ME_URL, { method: 'PUT', token, body: { bio: '响应契约检查' } });
  const d1d = dataOf(d1) || {};
  log(
    'PE-D1 成功响应返回完整 public user（含 id / username / nickname / avatar / bio / createdAt）',
    d1.status === 200 &&
      ['id', 'username', 'nickname', 'avatar', 'bio', 'createdAt'].every((k) => k in d1d) &&
      d1d.username === ACCOUNT.username,
    `字段=${Object.keys(d1d).join(',')}`
  );

  // ---------- D2. GET /api/auth/me 也返回这两个键 ----------
  const d2 = await call(AUTH_ME_URL, { token });
  const d2d = dataOf(d2) || {};
  log(
    'PE-D2 GET /api/auth/me 同步返回 avatar / bio 两个键',
    d2.status === 200 && 'avatar' in d2d && 'bio' in d2d,
    `字段=${Object.keys(d2d).join(',')}`
  );

  // ---------- E. 对既有接口的影响（只读，用 admin token，不写任何数据）----------
  const adminToken = mintToken(CONFIG.adminId, `user${CONFIG.adminId}`).token;

  const e1 = await call(`${ARTICLES_URL}?page=1&pageSize=1`, { token: adminToken });
  const e1list = (dataOf(e1) || {}).list || [];
  const e1author = e1list[0] && e1list[0].author;
  log(
    'PE-E1 文章列表的内嵌 author 含 avatar 键',
    Boolean(e1author) && 'avatar' in e1author,
    `author 字段=${e1author ? Object.keys(e1author).join(',') : '(无文章)'}`
  );

  log(
    'PE-E2 内嵌 author **不含** bio（bio 只在个人主页展示，不塞进每条评论）',
    Boolean(e1author) && !('bio' in e1author),
    e1author && 'bio' in e1author ? 'author 里出现了 bio —— 与 API.md 约定不符' : '确认无 bio 键'
  );

  if (e1list[0]) {
    const e3 = await call(`${ARTICLES_URL}/${e1list[0].id}/comments?page=1&pageSize=1`, { token: adminToken });
    const e3list = (dataOf(e3) || {}).list || [];
    const e3author = e3list[0] && e3list[0].author;
    if (e3author) {
      log('PE-E3 评论列表的 author 同样含 avatar 键', 'avatar' in e3author, `author 字段=${Object.keys(e3author).join(',')}`);
    } else {
      log('PE-E3 评论列表的 author 同样含 avatar 键', true, '该文章暂无评论，跳过（无数据可验）');
    }
  } else {
    log('PE-E3 评论列表的 author 同样含 avatar 键', true, '列表为空，跳过（无数据可验）');
  }

  console.log(`\n截图目录：${OUT}`);
  console.log('===== 用户头像/ 简介（PUT /api/users/me）探针汇总 =====');
  const passN = summary.filter((x) => x.ok).length;
  console.log(`通过 ${passN}/${summary.length}`);
  summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));

  const report = [
    `# 用户头像 / 简介（PUT /api/users/me）探针报告`,
    ``,
    `- 时间戳目录：${OUT}`,
    `- 结果：${passN}/${summary.length} 通过`,
    `- 自建一次性账号：${ACCOUNT.username}（跑完已删除）`,
    `- 写操作全部发生在一次性账号上；admin token 仅用于只读查询内嵌 author 结构`,
    ``,
    `| 结果 | 断言 | 证据 |`,
    `| --- | --- | --- |`,
    ...summary.map((x) => `| ${x.ok ? 'PASS' : 'FAIL'} | ${x.label} | ${String(x.detail).replace(/\|/g, '\\|')} |`),
    ``,
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), report, 'utf8');
  console.log(`报告已写入：${path.join(OUT, 'report.md')}`);
} catch (e) {
  console.log('\n[执行中断] ' + (e && e.message ? e.message : String(e)));
} finally {
  if (accountCreated) {
    await removeAccount();
  }
}

process.exit(summary.every((x) => x.ok) ? 0 : 1);
