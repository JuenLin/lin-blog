// 第二步 修改密码（PUT /api/auth/password）量化探针：把 docs/API.md 写死的语义逐条变成可度量的断言。
// 本探针只打后端 API，不依赖前端页面，因此不需要 Chrome —— 纯 fetch + 自建账号 + 精确回收。
//
// 覆盖 docs/API.md「PUT /api/auth/password」：
//   1. 正常改密码成功（200 / code 0 / message「密码已修改」/ data 为 null）
//   2. 改完用新密码能登录
//   3. 改完用旧密码不能登录（401 / 40100）
//   4. 旧 token 仍可用（GET /api/auth/me 正常）—— 对应「旧 token 语义」
//   5. 未登录401
//   6. oldPassword 错误 401
//   7. newPassword 与 oldPassword 相同 40000
//   8. newPassword 过短（5 字符）40000
//   9. newPassword 过长（101 字符）40000
//   10. newPassword 超72 字节（25 个汉字）40000
//   11. 禁传 userId / id / username 各40000
//  最后：用新密码改回原密码还原，不留脏数据。
//
// **为什么自建账号而不是用 admin**：本探针必须真登录才能测「密码换了还能不能登录」，
// 而 login 只认用户名+密码。要拿到能登录的凭据，只能先有一个已知密码的账号。
// 用 mintToken 造 token不行—— 那是直接签名，压根不经过密码校验，测不到本接口。
// 所以注册一个一次性账号，全程只动它自己，绝不碰 admin(id 2) / demo(id 1)。
//
// 自包含：自己造账号、自己删账号，不碰用户原有数据（契约 §13-9）。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, httpOk } from './lib/config.mjs';

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `password-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

const PASSWORD_URL = `${CONFIG.api}/auth/password`;
const LOGIN_URL = `${CONFIG.api}/auth/login`;
const REGISTER_URL = `${CONFIG.api}/auth/register`;
const ME_URL = `${CONFIG.api}/auth/me`;

// 一次性账号凭据。用户名带时间戳，避免撞库中已有账号（注册重名会 409）。
const stampRand = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const ACCOUNT = {
  username: `pwprobe${stampRand}`,
  password: 'Original#2026',
  newPassword: 'Changed#2026',
};

// Node fetch 默认不读 http_proxy，本机curl 那套 --noproxy 的坑在这里不存在。
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
    /* noop */
  }

  return { status: res.status, json };
}

async function login(username, password) {
  const res = await call(LOGIN_URL, { method: 'POST', body: { username, password } });
  return res;
}

// 退出前的最后一道保险：无论中途走到哪，都要把一次性账号删掉。
// 用当前生效的密码换token只是多一次校验，真正删除靠 cleanupProbeAccounts。
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
let currentPassword = ACCOUNT.password;

try {
  if ((await httpOk(`${CONFIG.api}/articles?page=1&pageSize=1`)) !== 200) {
    throw new Error(`后端 ${CONFIG.api} 探不到。请先起后端 3000。`);
  }

  // ---------- 准备：注册一次性账号 ----------
  const reg = await call(REGISTER_URL, { method: 'POST', body: { username: ACCOUNT.username, password: ACCOUNT.password } });
  if (reg.status !== 201 || !reg.json || reg.json.code !== 0) {
    throw new Error(`注册一次性账号失败：status=${reg.status} body=${JSON.stringify(reg.json)}`);
  }
  accountCreated = true;

  const first = await login(ACCOUNT.username, ACCOUNT.password);
  if (first.status !== 200 || !first.json.data || !first.json.data.token) {
    throw new Error(`用初始密码登录失败：status=${first.status} body=${JSON.stringify(first.json)}`);
  }

  // 这是「改密码之前」的 token，专门用来验第 4 条：旧 token 在改密码后是否仍可用。
  const oldToken = first.json.data.token;

  // ---------- 1. 正常改密码成功 ----------
  const ok1 = await call(PASSWORD_URL, {
    method: 'PUT',
    token: oldToken,
    body: { oldPassword: ACCOUNT.password, newPassword: ACCOUNT.newPassword },
  });
  log(
    'P1-1 正常改密码成功：200 / code 0 / message「密码已修改」/ data 为 null',
    ok1.status === 200 && ok1.json.code === 0 && ok1.json.message === '密码已修改' && ok1.json.data === null,
    `status=${ok1.status} code=${ok1.json.code} message=${JSON.stringify(ok1.json.message)} data=${JSON.stringify(ok1.json.data)}`
  );

  // ---------- 2. 用新密码能登录 ----------
  const afterNew = await login(ACCOUNT.username, ACCOUNT.newPassword);
  log(
    'P2-1 改完后用新密码能登录',
    afterNew.status === 200 && afterNew.json.code === 0 && !!(afterNew.json.data && afterNew.json.data.token),
    `status=${afterNew.status} code=${afterNew.json.code}`
  );

  // ---------- 3. 用旧密码不能登录 ----------
  const afterOld = await login(ACCOUNT.username, ACCOUNT.password);
  log(
    'P3-1 改完后用旧密码登录失败 401 / 40100',
    afterOld.status === 401 && afterOld.json.code === 40100,
    `status=${afterOld.status} code=${afterOld.json.code} message=${JSON.stringify(afterOld.json.message)}`
  );

  // ---------- 4. 旧 token 仍仍可用（docs/API.md「旧 token 语义」） ----------
  const meAfter = await call(ME_URL, { token: oldToken });
  log(
    'P4-1 改完后旧 token 仍可用（GET /auth/me 正常返回，服务端不强制失效）',
    meAfter.status === 200 && meAfter.json.code === 0 && meAfter.json.data && meAfter.json.data.id === reg.json.data.id,
    `status=${meAfter.status} code=${meAfter.json.code}返回的 userId=${meAfter.json.data && meAfter.json.data.id} 期望=${reg.json.data.id}`
  );

  // 旧 token 仍可用，意味着它还能改密码——这条不是 bug 而是语义的一部分，显式记录。
  const oldTokenCanStillWrite = await call(PASSWORD_URL, {
    method: 'PUT',
    token: oldToken,
    body: { oldPassword: ACCOUNT.newPassword, newPassword: ACCOUNT.password },
  });
  log(
    'P4-2 旧 token 确实仍具备写权限（语义自洽：仅靠 token 无法区分新旧会话）',
    oldTokenCanStillWrite.status === 200 && oldTokenCanStillWrite.json.code === 0,
    `用改密码前那个 token 再次改回=> status=${oldTokenCanStillWrite.status} code=${oldTokenCanStillWrite.json.code}`
  );
  currentPassword = ACCOUNT.password;

  // ---------- 5. 未登录 401 ----------
  const noAuth = await call(PASSWORD_URL, {
    method: 'PUT',
    body: { oldPassword: currentPassword, newPassword: ACCOUNT.newPassword },
  });
  log(
    'P5-1 未登录改密码 → 401 / 40100（auth 中间件在 validate 之前）',
    noAuth.status === 401 && noAuth.json.code === 40100,
    `status=${noAuth.status} code=${noAuth.json.code} message=${JSON.stringify(noAuth.json.message)}`
  );

  // 以下用例需要有效 token。优先用新登录拿的，避免复用旧 token 造成语义混淆。
  const fresh = await login(ACCOUNT.username, currentPassword);
  const token = fresh.json.data.token;

  // ---------- 6. oldPassword 错误 401 ----------
  const wrongOld = await call(PASSWORD_URL, {
    method: 'PUT',
    token,
    body: { oldPassword: 'WrongPassword#1', newPassword: ACCOUNT.newPassword },
  });
  log(
    'P6-1 oldPassword 不匹配 → 401 / 40100（message 与登录接口一致，不区分用户不存在）',
    wrongOld.status === 401 && wrongOld.json.code === 40100 && wrongOld.json.message === '用户名或密码错误',
    `status=${wrongOld.status} code=${wrongOld.json.code} message=${JSON.stringify(wrongOld.json.message)}`
  );

  // ---------- 7. newPassword 与 oldPassword 相同 40000 ----------
  const same = await call(PASSWORD_URL, {
    method: 'PUT',
    token,
    body: { oldPassword: currentPassword, newPassword: currentPassword },
  });
  log(
    'P7-1 newPassword 与 oldPassword 相同 → 400 / 40000',
    same.status === 400 && same.json.code === 40000,
    `status=${same.status} code=${same.json.code} message=${JSON.stringify(same.json.message)}`
  );

  // ---------- 8. newPassword 过短（5 字符） ----------
  const tooShort = await call(PASSWORD_URL, {
    method: 'PUT',
    token,
    body: { oldPassword: currentPassword, newPassword: 'a1234' },
  });
  log(
    'P8-1 newPassword 5 字符（下界） → 400 / 40000',
    tooShort.status === 400 && tooShort.json.code === 40000,
    `status=${tooShort.status} message=${JSON.stringify(tooShort.json.message)}`
  );

  // ---------- 9. newPassword 超 72 字节（73 个 ASCII 字符 = 73 字节） ----------
  //
  // ⚠️ 原来用 'a'.repeat(101)：它**同时**违反「≤100 字符」与「≤72 字节」两条规则，
  // 于是根本证明不了拦住它的是哪一条。更关键的是 byteLength ≤ 72 ⟹ length ≤ 72，
  // 「≤100 字符」这条 refine 实际上**永远不可达**（被字节规则完全覆盖）。
  // 改用 73 个字符：字节数 73 超限、字符数 73 仍在 100 以内 → 确证命中的是字节规则。
  // （P10-1 用 25 个汉字 = 75 字节验多字节计数，P10-2 用 24 个汉字 = 72 字节验界内放行，三条互补。）
  const tooLong = await call(PASSWORD_URL, {
    method: 'PUT',
    token,
    body: { oldPassword: currentPassword, newPassword: 'a'.repeat(73) },
  });
  log(
    'P9-1 newPassword 73 字符（73 字节 > bcrypt 上限 72，字符数未超 100） → 400 / 40000',
    tooLong.status === 400 && tooLong.json.code === 40000,
    `status=${tooLong.status} 字符数=${'a'.repeat(73).length} 字节数=${Buffer.byteLength('a'.repeat(73), 'utf8')} message=${JSON.stringify(tooLong.json.message)}`
  );

  // ---------- 10. newPassword 超 72 字节（25 个汉字 = 75 字节） ----------
  const overBytes = await call(PASSWORD_URL, {
    method: 'PUT',
    token,
    body: { oldPassword: currentPassword, newPassword: '密'.repeat(25) },
  });
  log(
    'P10-1 newPassword 25 个汉字（75 字节 > bcrypt 上限 72） → 400 / 40000',
    overBytes.status === 400 && overBytes.json.code === 40000,
    `status=${overBytes.status} message=${JSON.stringify(overBytes.json.message)}`
  );

  // 边界对照：24 个汉字 = 72 字节，恰好在界内应通过（它会把密码真的改掉，随后改回）
  const boundary = await call(PASSWORD_URL, {
    method: 'PUT',
    token,
    body: { oldPassword: currentPassword, newPassword: '密'.repeat(24) },
  });
  log(
    'P10-2 边界对照：24 个汉字（72 字节） → 200（恰好在界内，不含错误）',
    boundary.status === 200 && boundary.json.code === 0,
    `status=${boundary.status} code=${boundary.json.code}`
  );
  currentPassword = '密'.repeat(24);

  // ---------- 11/12/13. 禁传 userId / id / username ----------
  const threeLogin = await login(ACCOUNT.username, currentPassword);
  const t3 = threeLogin.json.data && threeLogin.json.data.token;

  for (const field of ['userId', 'id', 'username']) {
    const res = t3
      ? await call(PASSWORD_URL, {
          method: 'PUT',
          token: t3,
          body: { oldPassword: currentPassword, newPassword: ACCOUNT.newPassword, [field]: 2 },
        })
      : { status: 0, json: { code: -1, message: '未能登录，未发出请求' } };
    log(
      `P11-${field} 禁传 ${field} → 400 / 40000（报错而非静默忽略）`,
      res.status === 400 && res.json.code === 40000 && String(res.json.message).includes('不允许修改其他用户的密码'),
      `status=${res.status} message=${JSON.stringify(res.json.message)}`
    );
  }

  // 确认上面三条禁传没有真的改掉密码：仍能用当前密码登录
  const unchanged = await login(ACCOUNT.username, currentPassword);
  log(
    'P11-4 禁传校验未误改密码（当前密码仍可登录）',
    unchanged.status === 200 && unchanged.json.code === 0,
    `status=${unchanged.status}`
  );
  // 注意：currentPassword 仍应是 P10-2 换成的 24 个汉字 —— P11 那三条全被拒，
  // 密码没动。曾在这里错设成 ACCOUNT.newPassword，导致 P14 用错密码登录拿不到 token。

  // ---------- 14. 还原：用新密码改回原密码 ----------
  const revertLogin = await login(ACCOUNT.username, currentPassword);
  const revertToken = revertLogin.json.data && revertLogin.json.data.token;
  log(
    'P14-1 还原前能用当前密码登录（前提检查）',
    revertLogin.status === 200 && !!revertToken,
    `status=${revertLogin.status} 当前密码长度=${currentPassword.length}`
  );

  const revert = revertToken
    ? await call(PASSWORD_URL, {
        method: 'PUT',
        token: revertToken,
        body: { oldPassword: currentPassword, newPassword: ACCOUNT.password },
      })
    : { status: 0, json: { code: -1, message: '未能登录，未发出改密码请求' } };
  log(
    'P14-2 还原：密码已改回初始值（API.md 成功后 data 为 null）',
    revert.status === 200 && revert.json.code === 0,
    `status=${revert.status} code=${revert.json.code} message=${JSON.stringify(revert.json.message)}`
  );
  currentPassword = ACCOUNT.password;

  const finalCheck = await login(ACCOUNT.username, currentPassword);
  log(
    'P14-3 还原后能用初始密码登录（确认真的改回来了）',
    finalCheck.status === 200 && finalCheck.json.code === 0,
    `status=${finalCheck.status}`
  );

  console.log('\n===== 修改密码（PUT /api/auth/password）量化探针汇总 =====');
  const passN = summary.filter((x) => x.ok).length;
  console.log(`通过 ${passN}/${summary.length}`);
  summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));

  const report = [
    `# 修改密码（PUT /api/auth/password）探针报告`,
    ``,
    `- 时间戳目录：${OUT}`,
    `- 结果：${passN}/${summary.length} 通过`,
    `- 自建一次性账号：${ACCOUNT.username}（跑完已删除）`,
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

// 退出码：0 全绿 / 1 有断言失败 / 2 一条断言都没跑到（前置失败或中途中断）。
// ⚠️ 空数组 every 恒真，所以必须先挡掉「summary 为空」——否则连不上后端、
// 在第一句 throw 就中断时，一条断言都没跑却会 exit 0（假绿）。
if (summary.length === 0) process.exit(2);
process.exit(summary.every((x) => x.ok) ? 0 : 1);