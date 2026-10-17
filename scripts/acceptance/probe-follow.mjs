// 第四批「关注功能」独立探针：A 组纯 API（A1-A7）+ B 组 Chrome 交互（B1-B10）。
// 覆盖：自己/别人主页按钮三态与文案、关注后按钮切换与计数 ±1、取关无二次确认、
//       粉丝/关注列表页（标题昵称 / 40px 头像 / 无 bio / 点行进主页）、空态、
//       非法 type 被 beforeEnter 拦回主页、API 幂等语义（重复 POST 200 /  DELETE 未关注 200 /
//       POST 自己 400 / 关注不存在的人 404）、登出换账号 followingStore 不串号。
//
// ⚠️⚠️⚠️ 执行顺序（写死，改这文件前先读这段）
//    A1 → A2 → A3 → A4 → A5 → A6 → A7  →  [启动 Chrome]  →  B1 → … → B8  →  B9  →  B10
// 理由：
//    - A1-A6 是接口层断言，先在「A/B 之间无关系」的干净态上跑幂等语义；A7 用 Prisma 复核
//      A/B 间 follows 行数归零，给 B 组一个确定起点（B1 的「0 关注」才站得住）。
//    - B1-B8 在 A 登录态下完成「关注 → 计数+1 → 取关 → 计数-1」主链；
//    - B9（非法 type）与主链无依赖，插在 B8 后；
//    - B10 换账号测试**必须全程客户端路由**（点头像下拉、点头部「登录」、点「我的主页」、
//      点列表行），一次 goto 整页刷新都不能有 —— 刷新会重建 Pinia store，reset() 失不失效
//      都测不出来，靶子会假绿。这是本探针最核心的实现纪律。
//
// fixture：2 个临时账号 A / B（pwprobe-follow- 前缀，注册即登录，无文章无评论）。
// 清理顺序（外键 RESTRICT，反序会被 1452 拦）：先删 A/B 相关的 follows 行 → 再删两个 users
//   → 复核 follows 总数=0 且 users 总数=4（当前库基线）。删前先把行贴出来。
//
// 用法：node scripts/acceptance/probe-follow.mjs
import path from 'node:path';
import { CONFIG, ensureDirs, sleep, requireCjs, BACKEND, BACKEND_MODULES } from './lib/config.mjs';
import { cleanupProbeAccounts, PROBE_PREFIX } from './lib/tmp-account.mjs';
import { cdpAlive, attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';

/* ============================ 结果收集 ============================ */

const results = [];
let chromeChild = null;
let session = null;

function check(id, desc, pass, detail) {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${id} | ${desc} | ${detail}`);
}

/* ============================ HTTP 小工具 ============================ */

// 网络层重试（对齐 run.mjs 的既定纪律）：后端跑在 node --watch 下，实测 10-16
// 一个多小时内自发重启两次（21:26:49 / 21:39:03，父进程 11840 不变、子进程被换），
// 重启瞬间在途请求全部 fetch failed / ECONNRESET。只重试**请求根本没发出去**的
// 情况（fetch 抛错），拿到业务响应（含 4xx/409）绝不重试。写操作重复提交的后果
// 由接口幂等性兜底：follow/unfollow 天生幂等；register 重复由 makeAccount 的
// 409 分支接（用户名已存在 = 上次其实建成功了，直接放行走登录）。
async function api(method, urlPath, { token = null, body = null } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${CONFIG.api}${urlPath}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const json = await res.json().catch(() => null);

      return {
        status: res.status,
        code: json && json.code,
        message: json && json.message,
        data: json && json.data,
      };
    } catch (error) {
      lastError = error;
      console.log(`[RETRY] ${method} ${urlPath} 第 ${attempt} 次网络错误：${error && error.message}，1.5s 后重试`);
      await sleep(1500);
    }
  }

  throw lastError;
}

const register = (body) => api('POST', '/auth/register', { body });
const login = (body) => api('POST', '/auth/login', { body });
const follow = (id, token) => api('POST', `/users/${id}/follow`, { token });
const unfollow = (id, token) => api('DELETE', `/users/${id}/follow`, { token });

/* ============================ Prisma（仅供清理与复核） ============================ */

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
  const health = await api('GET', '/health');
  if (health.status !== 200) {
    console.error(`后端不可用（${CONFIG.api}/health → ${health.status}），先起后端再跑探针`);
    process.exit(2);
  }

  const front = await fetch(CONFIG.frontend).then((r) => r.status).catch(() => 0);
  if (front !== 200) {
    console.error(`前端不可用（${CONFIG.frontend} → ${front}），先起前端再跑探针（必须是 5173）`);
    process.exit(2);
  }
}

/* ============================ 小工具 ============================ */

// 把字符串变成 JS 字符串字面量，安全嵌进 evaluate 表达式。
const lit = (s) => JSON.stringify(s);

const PASSWORD = 'Cd3l!2026xK9';

// Network 事件收集器：followingStore 就绪的判据是
// 「GET /api/users/{我的id}/following 这条请求拿到了 200 响应」——
// AppHeader 的 ensureLoaded 完成后 store 才可能有值，早于它读按钮态会踩
// 「goto 完立刻读 DOM」的竞态（本探针的要求 1）。
const netEvents = [];

/* ============================ 主流程 ============================ */

const state = {
  A: { token: null, userId: null, username: null, nickname: null },
  B: { token: null, userId: null, username: null, nickname: null },
};

async function makeAccount(role) {
  const username = `${PROBE_PREFIX}-follow-${role}-${Date.now()}`;
  const nickname = `关注探针-${role}`;
  const r = await register({ username, password: PASSWORD, nickname });
  // 409 = 用户名已存在：只可能是「register 请求实际成功但响应被后端重启掐掉、
  // api() 重试后拿到业务响应」——账号已按我们的密码建好，放行走登录即可。
  if (r.status !== 201 && r.status !== 409) {
    throw new Error(`注册 ${role} 失败：HTTP ${r.status} ${r.message}`);
  }
  const l = await login({ username, password: PASSWORD });
  if (l.status !== 200 || !l.data || !l.data.token || !l.data.user) {
    throw new Error(`登录 ${role} 失败：HTTP ${l.status} ${l.message}`);
  }
  return { token: l.data.token, userId: l.data.user.id, username, nickname };
}

async function main() {
  ensureDirs();
  await preflight();

  /* ---------- 造 2 个账号 ---------- */

  state.A = await makeAccount('A');
  state.B = await makeAccount('B');
  console.log(`\n账号：A=${state.A.username}(id ${state.A.userId})  B=${state.B.username}(id ${state.B.userId})\n`);

  /* ============================================================
   * A 组（纯 API，A1-A7）。干净态起步：A/B 之间没有任何 follows 行。
   * ============================================================ */

  // A1：A 关注 B → 200。四数同源抽查：following=true、followerCount 属于 B（=1）、
  //     followingCount 属于 A 自己（=1）。**两个计数归属对象不同**，拿混就是假 FAIL
  //     （第 4 批负向验证踩过的坑：拿 A→C 返回的 followerCount 去比 B 的列表 total）。
  const a1 = await follow(state.B.userId, state.A.token);
  check(
    'A1',
    'API：A 关注 B → 200，following=true，followerCount(B)=1，followingCount(A)=1',
    a1.status === 200 &&
      a1.code === 0 &&
      a1.data &&
      a1.data.following === true &&
      a1.data.followerCount === 1 &&
      a1.data.followingCount === 1,
    `HTTP ${a1.status} code=${a1.code} data=${JSON.stringify(a1.data)}`
  );

  // A2：重复关注 → 200 幂等（**不是 409**，与 like 刻意相反）。
  const a2 = await follow(state.B.userId, state.A.token);
  check(
    'A2',
    'API：重复关注 → 200 幂等（非 409），following 仍为 true',
    a2.status === 200 && a2.code === 0 && a2.data && a2.data.following === true,
    `HTTP ${a2.status} code=${a2.code} msg="${a2.message}"`
  );

  // A3：关注自己 → 400。
  const a3 = await follow(state.A.userId, state.A.token);
  check('A3', 'API：关注自己 → 400', a3.status === 400, `HTTP ${a3.status} code=${a3.code} msg="${a3.message}"`);

  // A4：关注不存在的用户 → 404。
  const a4 = await follow(999999, state.A.token);
  check('A4', 'API：关注不存在的用户 → 404', a4.status === 404, `HTTP ${a4.status} code=${a4.code} msg="${a4.message}"`);

  // A5：取消关注 → 200 + following=false。
  const a5 = await unfollow(state.B.userId, state.A.token);
  check(
    'A5',
    'API：取消关注 → 200，following=false',
    a5.status === 200 && a5.code === 0 && a5.data && a5.data.following === false,
    `HTTP ${a5.status} code=${a5.code} data=${JSON.stringify(a5.data)}`
  );

  // A6：取消没关注过的 → 200 no-op（**不是 404**，与 unlike 刻意相反）。
  const a6 = await unfollow(state.B.userId, state.A.token);
  check('A6', 'API：取消未关注的 → 200 no-op（非 404）', a6.status === 200 && a6.code === 0, `HTTP ${a6.status} code=${a6.code} msg="${a6.message}"`);

  // A7：DB 复核 A/B 之间 follows 行数归零（B 组的确定起点）。
  const prisma0 = await getPrisma();
  let midRows = -1;
  try {
    midRows = await prisma0.follow.count({
      where: { OR: [{ followerId: { in: [state.A.userId, state.B.userId] } }, { followingId: { in: [state.A.userId, state.B.userId] } }] },
    });
  } finally {
    await prisma0.$disconnect();
    prismaClient = null;
  }
  check('A7', 'DB：A 组跑完后 A/B 之间 follows 行数 = 0（B 组干净起点）', midRows === 0, `count=${midRows}`);

  /* ============================================================
   * B 组（Chrome 交互，B1-B10）。登录态为 A（B10 才换账号）。
   * ============================================================ */

  if (!(await cdpAlive())) {
    chromeChild = (await launchChrome()).child;
    await sleep(1500);
  }
  session = await attach();
  await session.send('Network.enable');
  session.onEvent((msg) => {
    if (msg.method === 'Network.responseReceived' && msg.params && msg.params.response) {
      netEvents.push({ url: msg.params.response.url, status: msg.params.response.status });
    }
  });

  /* ---------- 页面等待小工具（本文件内闭包，依赖模块级 session） ---------- */

  const waitFor = async (expression, timeout = 10000, interval = 200) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let raw;
      try {
        raw = await session.evaluate(`(function(){try{return String(!!(${expression}));}catch(e){return 'false';}})()`);
      } catch {
        raw = 'false';
      }
      if (raw === 'true') return true;
      await sleep(interval);
    }
    return false;
  };

  // 等页面文档就绪（代替固定 sleep——导航后 evaluate 太早会撞上执行上下文销毁）。
  const waitForPageReady = async (timeout = 10000) =>
    waitFor(`document.readyState === 'complete'`, timeout);

  // 要求 1 的落地：轮询「GET /users/{meId}/following 已返回 200」，
  // 即 AppHeader 的 ensureLoaded 已完成、followingStore 就绪，之后才准读按钮态。
  // 每次开页先清空收集器，避免上一页的响应造成假就绪。
  const waitForStoreReady = async (meId, timeout = 15000) => {
    const needle = `/users/${meId}/following`;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = netEvents.find((e) => e.url.includes(needle) && e.status === 200);
      if (hit) return hit;
      await sleep(200);
    }
    return null;
  };

  // 开页：整页导航 + 文档就绪 + （可选）store 就绪。返回 store 是否就绪。
  //
  // ⚠️ storeReady=false 时**整体重来一轮**（最多一次）：实测 10-16 跑探针时后端进程
  // 在首屏加载的瞬间被换掉（21:26:49 起的新 PID），vite 代理池里的旧 socket 死亡，
  // 首屏全部 API 请求 ECONNRESET——getUser 网络错（页面显示「加载失败，请稍后重试」）、
  // /following 没回来（storeReady=false），第二页起代理恢复全好。应用行为正确
  // （错误态 + 保留登录态），是环境抖动不是产品 bug；探针不重试就会误报 FAIL。
  const openPage = async (url, meId) => {
    const attempt = async () => {
      netEvents.length = 0;
      await session.goto(url);
      await waitForPageReady();
      if (meId == null) return true;
      return !!(await waitForStoreReady(meId));
    };

    if (await attempt()) return true;

    return await attempt();
  };

  const waitForUrlPath = async (expected, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let p = '';
      try {
        p = await session.evaluate('location.pathname');
      } catch {
        p = '';
      }
      if (p === expected) return true;
      await sleep(200);
    }
    return false;
  };

  const btnText = () =>
    session.evaluate(`(function(){var b=document.querySelector('.profile-action');return b?b.textContent.trim():'';})()`);

  const statTexts = () =>
    session.evaluate(`(function(){return [].slice.call(document.querySelectorAll('.profile-stat')).map(function(l){return l.textContent.trim();});})()`);

  const clickActionButton = () =>
    session.evaluate(`(function(){var b=document.querySelector('.profile-action');if(b){b.click();return true;}return false;})()`);

  const shot = async (name) => session.screenshotFull(path.join(CONFIG.shots, name));

  // 应用内登出（纯前端：setToken('') → followingStore.reset()）。全程无整页刷新。
  const uiLogout = async () => {
    const opened = await session.evaluate(`(function(){var t=document.querySelector('.user-dropdown');if(t){t.click();return true;}return false;})()`);
    if (!opened) return false;
    if (!(await waitFor(`!!document.querySelector('.el-dropdown-menu__item')`, 5000))) return false;
    const clicked = await session.evaluate(`(function(){var its=[].slice.call(document.querySelectorAll('.el-dropdown-menu__item'));var it=its.find(function(x){return x.textContent.indexOf('退出登录')>=0;});if(it){it.click();return true;}return false;})()`);
    if (!clicked) return false;
    return waitFor(
      `!document.querySelector('.user-dropdown') && [].slice.call(document.querySelectorAll('.app-header .el-button')).some(function(b){return b.textContent.trim()==='登录';})`,
      8000
    );
  };

  // 应用内登录（点头部「登录」客户端路由到 /login → 填表 → 提交 → 等头部登录态）。
  //  deliberately 不用 goto：整页刷新会重建 store，B10 的串号靶子就假绿了。
  const uiLogin = async (account) => {
    const toLogin = await session.evaluate(`(function(){var bs=[].slice.call(document.querySelectorAll('.app-header .el-button'));var b=bs.find(function(x){return x.textContent.trim()==='登录';});if(b){b.click();return true;}return false;})()`);
    if (!toLogin) return false;
    // ⚠️ 不能只等 .el-input__inner：**头部搜索框在每个页面都有**，客户端路由还没渲染完
    // 条件就满足，随后填表会在旧 DOM 上只找到 1 个 input（ins.length<2）直接 bail——
    // B10-3 实测踩过（截图：登录页随后渲染出来了，但表单是空的）。必须连 pathname
    // 一起等，确认真的到了 /login 且两个 input 都渲染出来再填。
    if (!(await waitFor(`location.pathname === '/login' && document.querySelectorAll('.el-input__inner').length >= 2`, 8000))) return false;
    const filled = await session.evaluate(`(function(){var ins=document.querySelectorAll('.el-input__inner');if(ins.length<2)return false;var set=function(el,v){var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};set(ins[0],${lit(account.username)});set(ins[1],${lit(PASSWORD)});return true;})()`);
    if (!filled) return false;
    const submitted = await session.evaluate(`(function(){var bs=[].slice.call(document.querySelectorAll('.form-actions .el-button'));var b=bs.find(function(x){return x.textContent.trim()==='登录';});if(b){b.click();return true;}return false;})()`);
    if (!submitted) return false;
    return waitFor(`!!document.querySelector('.user-dropdown')`, 15000);
  };

  // 点开头像下拉并选某项（「我的主页」等）。客户端路由，无刷新。
  const clickDropdownItem = async (label) => {
    const opened = await session.evaluate(`(function(){var t=document.querySelector('.user-dropdown');if(t){t.click();return true;}return false;})()`);
    if (!opened) return false;
    if (!(await waitFor(`!!document.querySelector('.el-dropdown-menu__item')`, 5000))) return false;
    return session.evaluate(`(function(){var its=[].slice.call(document.querySelectorAll('.el-dropdown-menu__item'));var it=its.find(function(x){return x.textContent.indexOf(${lit(label)})>=0;});if(it){it.click();return true;}return false;})()`);
  };

  // 登录态注入（照抄 probe-comment-delete.mjs:286-290 的 proven 模式）：
  // 先 goto 真实 origin——about:blank 上读 localStorage 抛 SecurityError；
  // 写入 A 的 token 后，下面 openPage 的整页导航会带上它，
  // AppHeader onMounted 的 fetchMe → ensureLoaded 才会发出 /following 请求（storeReady 的判据）。
  await session.goto(`${CONFIG.frontend}/`);
  await waitForPageReady();
  await session.evaluate(`localStorage.setItem('token', ${lit(state.A.token)}); 'ok'`);

  /* ---------- B1：A 的自己主页 ---------- */

  const b1ready = await openPage(`${CONFIG.frontend}/user/${state.A.userId}`, state.A.userId);
  const b1btn = await btnText();
  const b1stats = await statTexts();
  await shot('follow-01-own-page.png');
  check(
    'B1',
    'UI：自己主页按钮是「编辑资料」（不是关注），文案「0 关注 + 我的粉丝」',
    b1ready && b1btn === '编辑资料' && b1stats[0] === '0 关注' && b1stats[1] === '我的粉丝',
    `storeReady=${b1ready} button="${b1btn}" stats=${JSON.stringify(b1stats)}`
  );

  /* ---------- B2：A 视角的 B 主页（关注前） ---------- */

  const b2ready = await openPage(`${CONFIG.frontend}/user/${state.B.userId}`, state.A.userId);
  const b2btn = await btnText();
  const b2stats = await statTexts();
  await shot('follow-02-other-before.png');
  check(
    'B2',
    'UI：别人主页按钮「关注」，文案「他关注 + 他的粉丝」',
    b2ready && b2btn === '关注' && b2stats[0] === '他关注' && b2stats[1] === '他的粉丝',
    `storeReady=${b2ready} button="${b2btn}" stats=${JSON.stringify(b2stats)}`
  );

  /* ---------- B3：点关注 → 按钮切「已关注」（轮询等文案，不固定 sleep），且无二次确认 ---------- */

  const b3clicked = await clickActionButton();
  const b3followed = await waitFor(
    `(function(){var b=document.querySelector('.profile-action');return !!b && b.textContent.trim()==='已关注';})()`,
    10000
  );
  const b3box = await session.evaluate(`!!document.querySelector('.el-message-box')`);
  await shot('follow-03-other-after-follow.png');
  check(
    'B3',
    'UI：点关注 → 按钮切「已关注」（轮询等待），且无二次确认框',
    b3clicked && b3followed && b3box === false,
    `clicked=${b3clicked} 已关注=${b3followed} 确认框=${b3box}`
  );

  /* ---------- B4：A 自己主页计数 +1 ---------- */

  const b4ready = await openPage(`${CONFIG.frontend}/user/${state.A.userId}`, state.A.userId);
  const b4stats = await statTexts();
  await shot('follow-04-own-count-1.png');
  check(
    'B4',
    'UI：关注后自己主页计数 +1 →「1 关注」',
    b4ready && b4stats[0] === '1 关注',
    `storeReady=${b4ready} stats=${JSON.stringify(b4stats)}`
  );

  /* ---------- B5：B 的粉丝列表页 ---------- */

  const b5ready = await openPage(`${CONFIG.frontend}/user/${state.B.userId}/follows/followers`, null);
  const b5info = await session.evaluate(`(function(){
    var title=(document.querySelector('.follows-title')||{}).textContent||'';
    var rows=[].slice.call(document.querySelectorAll('.follow-row')).map(function(r){
      var av=r.querySelector('.follow-avatar')||r.querySelector('.follow-avatar-img');
      return {
        name:(r.querySelector('.follow-name')||{}).textContent||'',
        username:(r.querySelector('.follow-username')||{}).textContent||'',
        avatarWidth: av ? getComputedStyle(av).width : '',
        childCount: r.children.length,
        hasBio: [].slice.call(r.querySelectorAll('[class]')).some(function(el){return (el.className||'').indexOf('bio')>=0;})
      };
    });
    return {title:title.trim(), rows:rows};
  })()`);
  await shot('follow-05-followers-list.png');
  const b5row = b5info && b5info.rows && b5info.rows[0];
  const b5struct =
    b5row &&
    b5row.avatarWidth === '40px' &&
    b5row.childCount === 3 &&
    b5row.hasBio === false &&
    b5row.name.indexOf(state.A.nickname) >= 0;
  check(
    'B5',
    'UI：B 的粉丝列表——标题带 B 昵称、1 行（A）、40px 头像、行内 3 个子元素且无 bio',
    b5ready && b5info.title.indexOf(state.B.nickname) >= 0 && b5info.rows.length === 1 && b5struct,
    `storeReady=${b5ready} title="${b5info.title}" rows=${JSON.stringify(b5info.rows)}`
  );

  // B5b：点行进该用户主页（整行 router-link）。
  const b5clicked = await session.evaluate(`(function(){var r=document.querySelector('.follow-row');if(r){r.click();return true;}return false;})()`);
  const b5nav = await waitForUrlPath(`/user/${state.A.userId}`);
  check('B5b', 'UI：点粉丝列表行 → 跳进该用户主页', b5clicked && b5nav, `clicked=${b5clicked} 到达=${b5nav}`);

  /* ---------- B6：A 的关注列表页 ---------- */

  const b6ready = await openPage(`${CONFIG.frontend}/user/${state.A.userId}/follows/following`, null);
  const b6info = await session.evaluate(`(function(){
    var title=(document.querySelector('.follows-title')||{}).textContent||'';
    var rows=[].slice.call(document.querySelectorAll('.follow-row')).map(function(r){
      return {name:(r.querySelector('.follow-name')||{}).textContent||''};
    });
    return {title:title.trim(), rows:rows};
  })()`);
  const b6clicked = await session.evaluate(`(function(){var r=document.querySelector('.follow-row');if(r){r.click();return true;}return false;})()`);
  const b6nav = await waitForUrlPath(`/user/${state.B.userId}`);
  await shot('follow-06-following-list.png');
  check(
    'B6',
    'UI：A 的关注列表——标题「…的关注」、1 行（B）、点行跳 B 主页',
    b6ready && b6info.title.indexOf(state.A.nickname) >= 0 && b6info.rows.length === 1 && b6clicked && b6nav,
    `title="${b6info.title}" rows=${JSON.stringify(b6info.rows)} 到达=${b6nav}`
  );

  /* ---------- B7：两个空态 ---------- */

  const b7aReady = await openPage(`${CONFIG.frontend}/user/${state.A.userId}/follows/followers`, null);
  const b7aEmpty = await session.evaluate(`(function(){var e=document.querySelector('.el-empty__description');return e?e.textContent.trim():'';})()`);
  const b7bReady = await openPage(`${CONFIG.frontend}/user/${state.B.userId}/follows/following`, null);
  const b7bEmpty = await session.evaluate(`(function(){var e=document.querySelector('.el-empty__description');return e?e.textContent.trim():'';})()`);
  await shot('follow-07-empty-state.png');
  check(
    'B7',
    'UI：空态——A 的粉丝「还没有粉丝」、B 的关注「还没有关注任何人」',
    b7aReady && b7aEmpty === '还没有粉丝' && b7bReady && b7bEmpty === '还没有关注任何人',
    `A粉丝="${b7aEmpty}" B关注="${b7bEmpty}"`
  );

  /* ---------- B8：取关 → 按钮回「关注」+ 无二次确认 + 计数 -1 ---------- */

  const b8ready = await openPage(`${CONFIG.frontend}/user/${state.B.userId}`, state.A.userId);
  const b8before = await btnText();
  const b8clicked = b8before === '已关注' ? await clickActionButton() : false;
  const b8unfollowed = await waitFor(
    `(function(){var b=document.querySelector('.profile-action');return !!b && b.textContent.trim()==='关注';})()`,
    10000
  );
  const b8box = await session.evaluate(`!!document.querySelector('.el-message-box')`);
  const b8ownReady = await openPage(`${CONFIG.frontend}/user/${state.A.userId}`, state.A.userId);
  const b8stats = await statTexts();
  check(
    'B8',
    'UI：取关 → 按钮回「关注」（轮询等待）+ 无二次确认 + 自己主页计数 -1 →「0 关注」',
    b8ready && b8before === '已关注' && b8clicked && b8unfollowed && b8box === false && b8ownReady && b8stats[0] === '0 关注',
    `before="${b8before}" 回关注=${b8unfollowed} 确认框=${b8box} stats=${JSON.stringify(b8stats)}`
  );

  /* ---------- B9：非法 type 被 beforeEnter 拦回主页 ---------- */

  await openPage(`${CONFIG.frontend}/user/${state.B.userId}/follows/xxx`, null);
  const b9nav = await waitForUrlPath(`/user/${state.B.userId}`);
  await shot('follow-08-illegal-type.png');
  check('B9', 'UI：非法 type（/follows/xxx）→ URL 重定向回 /user/{id}', b9nav, `到达 /user/${state.B.userId} = ${b9nav}`);

  /* ---------- B10：登出 → 换账号 → followingStore 不串号 ---------- */
  // 全程客户端路由（uiLogout / uiLogin / clickDropdownItem / 点列表行），
  // 一次整页刷新都不能有——刷新会重建 store，reset() 失不失效都测不出来。

  // B10-1：A 重新关注 B（B8 取关后的干净态 → 为换账号铺路）。
  const b101ready = await openPage(`${CONFIG.frontend}/user/${state.B.userId}`, state.A.userId);
  const b101before = await btnText();
  const b101clicked = b101before === '关注' ? await clickActionButton() : false;
  const b101ok = await waitFor(
    `(function(){var b=document.querySelector('.profile-action');return !!b && b.textContent.trim()==='已关注';})()`,
    10000
  );
  check(
    'B10-1',
    'UI：A 重新关注 B → 按钮切「已关注」',
    b101ready && b101before === '关注' && b101clicked && b101ok,
    `before="${b101before}" clicked=${b101clicked} 已关注=${b101ok}`
  );

  // B10-2：应用内登出（走 setToken('') → followingStore.reset()）。
  const b102 = await uiLogout();
  check('B10-2', 'UI：应用内登出成功（头部退回「登录」）', b102 === true, `logout=${b102}`);

  // B10-3：客户端登录 B → 下拉「我的主页」→ **串号靶子①**：
  //   B 自己主页应显示「0 关注」；若 reset 失效（残留 A 的集合 {B}），这里会显示「1 关注」。
  const b103login = await uiLogin(state.B);
  const b103nav = b103login ? await clickDropdownItem('我的主页') : false;
  const b103count = await waitFor(
    `(function(){var t=document.querySelector('.profile-stat');return !!t && t.textContent.trim()==='0 关注';})()`,
    10000
  );
  check(
    'B10-3',
    'UI：换账号后 B 自己主页「0 关注」——followingStore 已 reset（串号会显示 1）',
    b103login && b103nav && b103count,
    `login=${b103login} 我的主页=${b103nav} 0关注=${b103count}`
  );

  // B10-4：B 关注 A（关系落库；此步可用整页加载，不涉及 reset 验证）。
  const b104ready = await openPage(`${CONFIG.frontend}/user/${state.A.userId}`, state.B.userId);
  const b104before = await btnText();
  const b104clicked = b104before === '关注' ? await clickActionButton() : false;
  const b104ok = await waitFor(
    `(function(){var b=document.querySelector('.profile-action');return !!b && b.textContent.trim()==='已关注';})()`,
    10000
  );
  check(
    'B10-4',
    'UI：B 关注 A → 按钮切「已关注」',
    b104ready && b104before === '关注' && b104clicked && b104ok,
    `before="${b104before}" clicked=${b104clicked} 已关注=${b104ok}`
  );

  // B10-5：登出 → 客户端登录 A → 「我的主页」→ 点「1 关注」列表 → 点 B 行 → B 主页。
  //   **串号靶子②**：同一 SPA 实例里 A 看 B 应显示「已关注」；
  //   若 reset 失效（残留 B 的集合 {A}，has(B)=false），这里会显示「关注」。
  const b105logout = await uiLogout();
  const b105login = await uiLogin(state.A);
  const b105nav = b105login ? await clickDropdownItem('我的主页') : false;
  const b105count = await waitFor(
    `(function(){var t=document.querySelector('.profile-stat');return !!t && t.textContent.trim()==='1 关注';})()`,
    10000
  );
  const b105link = await session.evaluate(`(function(){var l=document.querySelector('.profile-stat');if(l){l.click();return true;}return false;})()`);
  const b105row = await waitFor(
    `(function(){var n=${lit(state.B.nickname)};return [].slice.call(document.querySelectorAll('.follow-name')).some(function(x){return x.textContent.indexOf(n)>=0;});})()`,
    10000
  );
  const b105rowClicked = b105row
    ? await session.evaluate(`(function(){var n=${lit(state.B.nickname)};var rows=[].slice.call(document.querySelectorAll('.follow-row'));var r=rows.find(function(x){var m=x.querySelector('.follow-name');return m&&m.textContent.indexOf(n)>=0;});if(r){r.click();return true;}return false;})()`)
    : false;
  const b105final = await waitFor(
    `(function(){var b=document.querySelector('.profile-action');return location.pathname==='/user/${state.B.userId}' && !!b && b.textContent.trim()==='已关注';})()`,
    10000
  );
  await shot('follow-09-switch-account.png');
  check(
    'B10-5',
    'UI：换回 A 后经客户端导航到 B 主页仍显示「已关注」（同实例 store 未串号）',
    b105logout && b105login && b105nav && b105count && b105link && b105row && b105rowClicked && b105final,
    `登出=${b105logout} 登录=${b105login} 1关注=${b105count} 列表有B行=${b105row} 点行=${b105rowClicked} 已关注=${b105final}`
  );
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

let exitCode = 1;

try {
  await main();
  exitCode = summarize();
} catch (error) {
  console.error('\n探针异常终止：', error && error.message ? error.message : error);
  exitCode = 1;
} finally {
  // 1. 先关浏览器（契约 §13-17：自己起的自己关）。
  if (session) {
    try {
      session.close();
    } catch {
      /* noop */
    }
  }
  if (chromeChild) {
    await stopChrome(chromeChild);
  }

  // 2. 清理：follows 行 → users（外键 RESTRICT，反序会被 1452 拦）。
  //    删前先把即将删除的行贴出来（「删什么先给我看」）；只删两个临时账号相关的行，
  //    不 TRUNCATE、不按「全表」删——表里将来可能有真实数据。
  try {
    const ids = [state.A.userId, state.B.userId].filter((v) => v != null);
    const scope =
      ids.length > 0
        ? { OR: [{ followerId: { in: ids } }, { followingId: { in: ids } }] }
        : null;

    let rows = [];
    let deletedFollows = 0;
    let followsLeft = -1;
    let usersLeft = -1;

    if (scope) {
      const prisma = await getPrisma();
      try {
        rows = await prisma.follow.findMany({ where: scope, orderBy: { id: 'asc' } });
        console.log('\n待删 follows 行（删什么先贴出来）：');
        if (rows.length === 0) {
          console.log('  （无——A/B 之间已无关注关系）');
        } else {
          rows.forEach((r) =>
            console.log(`  id=${r.id} follower_id=${r.followerId} following_id=${r.followingId} created_at=${r.createdAt.toISOString()}`)
          );
        }
        deletedFollows = (await prisma.follow.deleteMany({ where: scope })).count;
      } finally {
        await prisma.$disconnect();
        prismaClient = null;
      }
    }

    const usernames = [state.A.username, state.B.username].filter(Boolean);
    const deletedUsers = usernames.length ? await cleanupProbeAccounts(usernames) : 0;

    // 3. 复核回到基线：follows 总数 0、users 总数 4（当前库基线）。
    const prisma2 = await getPrisma();
    try {
      followsLeft = await prisma2.follow.count();
      usersLeft = await prisma2.user.count();
    } finally {
      await prisma2.$disconnect();
      prismaClient = null;
    }

    console.log(
      `\n清理：follows 行 ${deletedFollows} / 探针账号 ${deletedUsers}；复核 follows=${followsLeft}（应 0） users=${usersLeft}（应 4）`
    );
    if (followsLeft !== 0 || usersLeft !== 4) {
      console.error('⚠️ 复核未回到基线，需手动处理');
      exitCode = 1;
    }
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
