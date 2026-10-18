// 第 9 批「阅读量」探针：V 组接口语义（+1 / 判重 / 404 三态 / sortBy）/ U 组详情页 UI
//
// 与其他探针同一套规矩：
//   - 一次性 pwprobe 账号 + 探针自造靶子文章，finally 走 tmp-account 统一清理；
//   - V6 的排序造数直连 Prisma 写 viewCount（探针造数，物理删收尾，不碰真实文章）；
//   - 自己起的 Chrome 自己关；
//   - 前置失败 exit 2、有 FAIL 或清理失败 exit 1、全绿 exit 0。
//
// ⚠️ 铁律（踩过两次）：
//   1) 验语法绝不能用 import() —— 会真的把探针跑一遍留下脏数据。语法交给 vite build。
//   2) 别用 `| head -N` / `| grep` 截断本脚本输出 —— 管道关闭会掐死 node，
//      finally 不跑，会留下 pwprobe 账号（已经发生过一次）。一律 `> 文件` 再 grep 那个文件。
//
// ⚠️ V2（判重）的已知环境依赖：判重窗口在后端**内存 Map**里，node --watch 若在
// V1 与 V2 之间重启进程，窗口清零 → V2 会 +1 而 FAIL。这是「尽力为之」的已知代价
// （docs/API.md 已写明重启不保证连续性），不是产品回归；真红了先查后端 uptime。
//
// 用法：node scripts/acceptance/probe-view.mjs
import path from 'node:path';
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

/* ============================ HTTP 小工具 ============================ */

async function api(method, urlPath, { token = null, body = null } = {}) {
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
}

const view = (id, token) => api('POST', `/articles/${id}/view`, { token });

/* ============================ Prisma（仅供 V6 排序造数） ============================ */

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
const A = { username: `pwprobe${stamp}`, password: `probe${stamp}`, token: null, userId: null };

const artV1 = { value: null }; // 主靶子：+1 / 判重 / 透出 / 详情页 UI
const artV2 = { value: null }; // 判重对照：同 IP 不同文章应正常 +1
const artDel = { value: null }; // 软删 404
const draftId = { value: null }; // 草稿 404

async function main() {
  await preflight();
  ensureDirs();

  /* ---------- 注册 + 造靶子 ---------- */

  const reg = await api('POST', '/auth/register', {
    body: { username: A.username, password: A.password, nickname: A.username },
  });
  if (reg.status !== 201 && reg.status !== 200) {
    console.error(`注册探针账号失败：${reg.status} ${reg.message}`);
    process.exit(2);
  }

  const login = await api('POST', '/auth/login', {
    body: { username: A.username, password: A.password },
  });
  A.token = login.data && login.data.token;
  A.userId = login.data && login.data.user && login.data.user.id;

  if (!A.token || !A.userId) {
    console.error('登录探针账号失败，拿不到 token / userId');
    process.exit(2);
  }

  const makeArticle = async (title) => {
    const created = await api('POST', '/articles', {
      token: A.token,
      body: {
        title,
        summary: '探针自造靶子文章，跑完即物理删除',
        content: '仅供 probe-view.mjs 使用。'.repeat(5),
        category: '未分类',
      },
    });

    if (!created.data || !created.data.id) {
      throw new Error(`造靶子文章失败：${created.status} ${created.message}`);
    }

    return created;
  };

  const v1 = await makeArticle(`view 主靶子 ${stamp}`);
  artV1.value = v1.data.id;

  const v2 = await makeArticle(`view 判重对照 ${stamp}`);
  artV2.value = v2.data.id;

  const vd = await makeArticle(`view 软删靶子 ${stamp}`);
  artDel.value = vd.data.id;

  // 草稿走 auto-save（第 6 批接口）：不发布，详情与阅读都应 404。
  const draft = await api('POST', '/articles/auto-save', {
    token: A.token,
    body: { title: `view 草稿靶子 ${stamp}`, content: '草稿正文，不发布。'.repeat(5) },
  });
  draftId.value = draft.data && draft.data.id ? draft.data.id : null;

  console.log(`靶子文章：artV1=${artV1.value} artV2=${artV2.value} artDel=${artDel.value} draft=${draftId.value}\n`);

  /* ================= V 组：接口语义 ================= */

  // V0：新建文章的响应就带 viewCount: 0（契约：列默认值显式返回）。
  check(
    'V0',
    'POST /api/articles 的 201 响应带 viewCount: 0',
    v1.data.viewCount === 0,
    `viewCount=${v1.data.viewCount}`
  );

  // V1：**免登录**（阅读是匿名行为，与点赞 / 收藏刻意不同）+1。
  const v1Res = await view(artV1.value, null);
  check(
    'V1',
    '未登录 POST /view → 200 且 viewCount=1（免登录，首次 +1）',
    v1Res.status === 200 && v1Res.data && v1Res.data.viewCount === 1,
    `HTTP ${v1Res.status} ${JSON.stringify(v1Res.data)}`
  );

  // V2：同 IP 同文章 5 分钟内重复 → 不 +1（仍 200，返回当前值）。
  const v2Res = await view(artV1.value, null);
  check(
    'V2',
    '同 IP 同文章立即重发 → 200 但 viewCount 不 +1（判重窗口生效）',
    v2Res.status === 200 && v2Res.data && v2Res.data.viewCount === 1,
    `HTTP ${v2Res.status} ${JSON.stringify(v2Res.data)}（若为 2，判重窗口丢了：查后端是否刚重启）`
  );

  // V3：换一篇文章（同 IP）应正常 +1 —— 证明 V2 是「按 key 判重」而不是接口坏了。
  // 没有这条，V2 的「不 +1」分不清是判重生效还是整个计数链路挂了。
  const v3Res = await view(artV2.value, null);
  check(
    'V3',
    '同 IP 换一篇文章 → 正常 +1（证明 V2 是判重而非计数链路坏）',
    v3Res.status === 200 && v3Res.data && v3Res.data.viewCount === 1,
    `HTTP ${v3Res.status} ${JSON.stringify(v3Res.data)}`
  );

  // V4：详情接口透出 viewCount，与 view 响应口径一致。
  const v4 = await api('GET', `/articles/${artV1.value}`);
  check(
    'V4',
    'GET /articles/:id 的 viewCount 与 view 响应一致（=1）',
    v4.status === 200 && v4.data && v4.data.viewCount === 1,
    `HTTP ${v4.status} viewCount=${v4.data && v4.data.viewCount}`
  );

  // V5：列表接口透出 viewCount（toArticleListItem 同形）。
  const v5 = await api('GET', '/articles?page=1&pageSize=100');
  const v5Row = (v5.data && v5.data.list ? v5.data.list : []).find((a) => a.id === artV1.value);
  check(
    'V5',
    '列表项透出 viewCount（=1）',
    Boolean(v5Row) && v5Row.viewCount === 1,
    v5Row ? `artV1 viewCount=${v5Row.viewCount}` : '列表里没找到 artV1'
  );

  /* ---------- V6：sortBy=viewCount（Prisma 造数后验排序） ---------- */

  // 造数：artV1=5、artV2=1。直连 Prisma 写真实列（探针造数，物理删收尾）——
  // 同 IP 同文章 5 分钟只计一次，靠重复打接口凑不出差值，只能造。
  const prisma = await getPrisma();
  await prisma.article.update({ where: { id: artV1.value }, data: { viewCount: 5 } });
  await prisma.article.update({ where: { id: artV2.value }, data: { viewCount: 1 } });

  const v6Desc = await api('GET', '/articles?page=1&pageSize=100&sortBy=viewCount&order=desc');
  const descIds = (v6Desc.data && v6Desc.data.list ? v6Desc.data.list : []).map((a) => a.id);
  const idxDesc1 = descIds.indexOf(artV1.value);
  const idxDesc2 = descIds.indexOf(artV2.value);

  // 负向断言必须带「两篇都在列表里」前置：缺一篇时 indexOf=-1，
  // 「-1 < -1 为假」会 FAIL，但「-1 < 5」可能假绿 —— 显式断言存在性。
  check(
    'V6a',
    'sortBy=viewCount&order=desc：artV1(5) 排在 artV2(1) 前',
    v6Desc.status === 200 && idxDesc1 >= 0 && idxDesc2 >= 0 && idxDesc1 < idxDesc2,
    `HTTP ${v6Desc.status} artV1 位次=${idxDesc1} artV2 位次=${idxDesc2}`
  );

  const v6Asc = await api('GET', '/articles?page=1&pageSize=100&sortBy=viewCount&order=asc');
  const ascIds = (v6Asc.data && v6Asc.data.list ? v6Asc.data.list : []).map((a) => a.id);
  const idxAsc1 = ascIds.indexOf(artV1.value);
  const idxAsc2 = ascIds.indexOf(artV2.value);
  check(
    'V6b',
    'sortBy=viewCount&order=asc：artV2(1) 排在 artV1(5) 前',
    v6Asc.status === 200 && idxAsc1 >= 0 && idxAsc2 >= 0 && idxAsc2 < idxAsc1,
    `HTTP ${v6Asc.status} artV1 位次=${idxAsc1} artV2 位次=${idxAsc2}`
  );

  // V6c：白名单大小写敏感（viewcount 不合法），越界 400/40000。
  const v6c = await api('GET', '/articles?sortBy=viewcount');
  check(
    'V6c',
    'sortBy=viewcount（小写，大小写敏感）→ 400 / 40000',
    v6c.status === 400 && v6c.code === 40000,
    `HTTP ${v6c.status} code=${v6c.code} msg="${v6c.message}"`
  );

  /* ---------- V7-V10：公开可读口径的 404 / 400 ---------- */

  // 软删 → 404（存在性判定与 GET /:id 一致：不存在 / 软删 / 草稿一律 404）。
  const delRes = await api('DELETE', `/articles/${artDel.value}`, { token: A.token });
  const v7 = await view(artDel.value, null);
  check(
    'V7',
    '软删文章 POST /view → 404 / 40400',
    delRes.status === 200 && v7.status === 404 && v7.code === 40400,
    `软删 HTTP ${delRes.status}；view HTTP ${v7.status} code=${v7.code} msg="${v7.message}"`
  );

  // 草稿 → 404（阅读量只统计公开可见文章）。
  const v8 = draftId.value ? await view(draftId.value, null) : { status: 0, code: null, message: '草稿没造出来' };
  check(
    'V8',
    '草稿 POST /view → 404 / 40400',
    Boolean(draftId.value) && v8.status === 404 && v8.code === 40400,
    `draftId=${draftId.value} HTTP ${v8.status} code=${v8.code} msg="${v8.message}"`
  );

  // 不存在的 id → 404。
  const v9 = await view(99999999, null);
  check(
    'V9',
    '不存在的文章 POST /view → 404 / 40400',
    v9.status === 404 && v9.code === 40400,
    `HTTP ${v9.status} code=${v9.code} msg="${v9.message}"`
  );

  // 非法 id（非正整数）→ 400（zod 参数校验）。
  const v10 = await view('abc', null);
  check(
    'V10',
    '文章 id 非法（abc）→ 400 / 40000',
    v10.status === 400 && v10.code === 40000,
    `HTTP ${v10.status} code=${v10.code} msg="${v10.message}"`
  );

  /* ================= U 组：详情页 UI ================= */

  if (!(await cdpAlive())) {
    chromeChild = (await launchChrome()).child;
    await sleep(1500);
  }

  session = await attach();
  await session.send('Network.enable');

  const requests = [];
  session.onEvent((msg) => {
    if (msg.method === 'Network.requestWillBeSent') {
      requests.push({ url: msg.params.request.url, method: msg.params.request.method });
    }
  });

  // U1：详情页 mounted 后**只发一次** POST /view，未登录也发（免登录计数）。
  requests.length = 0;
  await session.goto(`${CONFIG.frontend}/article/${artV1.value}`);
  const u1Chip = await waitFor(`document.querySelector('.article-detail-view')`, 10000);
  await sleep(1500);

  const viewReqs = requests.filter((r) => r.method === 'POST' && r.url.includes('/view'));
  check(
    'U1',
    '详情页加载：POST /api/articles/:id/view 恰好 1 次（未登录也计）',
    u1Chip && viewReqs.length === 1,
    `chip渲染=${u1Chip}，POST /view 次数=${viewReqs.length}${viewReqs[0] ? ` → ${viewReqs[0].url.replace(CONFIG.api, '')}` : ''}`
  );

  // U2：meta 行「阅读 N」与接口 viewCount 一致。
  // 轮询而不是睡死：POST /view 是 fire-and-forget，chip 初始值是 getArticle 的旧值，
  // 响应回来后才本地 +1 刷新，读太早会拿到旧值（假 FAIL）。
  let u2Pass = false;
  let u2Detail = 'chip 未渲染';

  for (let i = 0; i < 12 && !u2Pass; i += 1) {
    const chip = await session.evaluate(
      `(() => { const el = document.querySelector('.article-detail-view'); return el ? el.textContent.trim() : null; })()`
    );
    const apiNow = await api('GET', `/articles/${artV1.value}`);
    const chipN = chip ? Number(chip.replace(/[^\d]/g, '')) : NaN;

    if (Number.isFinite(chipN) && apiNow.data && chipN === apiNow.data.viewCount) {
      u2Pass = true;
      u2Detail = `chip="${chip}" API viewCount=${apiNow.data.viewCount}`;
      break;
    }

    u2Detail = `chip="${chip}"（解析 ${chipN}）vs API viewCount=${apiNow.data && apiNow.data.viewCount}，第 ${i + 1} 次轮询`;
    await sleep(400);
  }

  check(
    'U2',
    '详情页「阅读 N」chip 与接口 viewCount 一致',
    u2Pass,
    u2Detail
  );
}

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

let exitCode = 2; // 默认按「前置失败」处理，正常进到 main 末尾会被 summarize 覆盖

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

  // 清理：tmp-account 统一通道（notifications → bookmarks → likes → follows
  // → comments → articles → users），按 pwprobe 前缀精确删，不误伤真实用户。
  // V6 用 Prisma 改过的 viewCount 随靶子文章一起物理删除，不留痕。
  try {
    const users = await cleanupProbeAccounts([A.username]);
    console.log(`\n清理：删除探针账号 ${users} 个（含其自造文章，V6 造数随文章一并物理删除）`);
  } catch (error) {
    console.error('清理失败（需手动处理）：', error && error.message ? error.message : error);
    exitCode = 1;
  }
}

process.exit(exitCode);
