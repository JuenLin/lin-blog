// 第一步 ① 个人主页量化探针：不靠肉眼看截图，把每件事变成可度量的值。
// 覆盖：作者名渲染、按 author.id 前端过滤、分页 total 取过滤后真实条数、空态复用 EmptyState。
// 自包含：自己造夹具、自己清理，不碰用户原有数据（契约 §13-9）。
import fs from 'node:fs';
import path from 'node:path';
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep, httpOk } from './lib/config.mjs';
import { mintToken, whoami } from './lib/session.mjs';
import { ensureFixtures, cleanupFixtures, listArticles, MARKERS } from './lib/fixtures.mjs';

// 截图目录：默认带时间戳子目录（防 D:/tools/acceptance-shots 整目录被外部清掉）。
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `profile1-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

let chrome = null;
let s = null;
let fx = null; // 夹具清单，结尾按 fx.all 精确回收
const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};
const safe = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    log(label, false, '异常: ' + (e && e.message ? e.message : String(e)));
  }
};

// CDP 会话只暴露 send/evaluate/goto/screenshot/close，没有 waitFor —— 自己轮询 evaluate（与 run.mjs 一致）。
async function waitFor(expr, t = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    try {
      if (await s.evaluate(expr)) return true;
    } catch {
      /* 页面还没就绪，继续等 */
    }
    await sleep(200);
  }
  return false;
}

try {
  // 前置：前后端必须起好
  if ((await httpOk(CONFIG.frontend)) !== 200) {
    throw new Error(`前端 ${CONFIG.frontend} 探不到。请先 npm run dev（端口必须是 5173）。`);
  }
  if ((await httpOk(`${CONFIG.api}/articles?page=1&pageSize=1`)) !== 200) {
    throw new Error(`后端 ${CONFIG.api} 探不到。请先起后端 3000。`);
  }

  // 构造登录态（借用 JWT_SECRET，不碰密码），拿到 admin 的昵称 / 用户名作为断言基准
  const adminToken = mintToken(CONFIG.adminId, `user${CONFIG.adminId}`).token;
  const admin = await whoami(adminToken);
  if (!admin) throw new Error(`userId=${CONFIG.adminId} 的 token 无效`);
  const expectedName = admin.nickname || admin.username;

  // 造夹具（admin 名下多篇文章），并直接从接口算出「该作者在 100 窗内的真实条数」
  await cleanupKnownArtifactsSafe();
  fx = await ensureFixtures(adminToken, admin.id);
  const win = await listArticles(adminToken, 100);
  const expectedCount = (win.list || []).filter(
    (a) => a.author && Number(a.author.id) === admin.id
  ).length;

  // 起浏览器
  if (!(await cdpAlive())) {
    chrome = await launchChrome();
    await sleep(1000);
  }
  s = await attach();
  await s.send('Page.enable');
  await s.send('Network.enable');

  const targetUrl = CONFIG.frontend + '/user/' + admin.id;

  // ---------- 正常态：个人主页渲染 ----------
  await s.goto(targetUrl);
  const okCards = await waitFor(`document.querySelectorAll('.article-card').length > 0`, 10000);
  const dom = await s.evaluate(`(() => {
    const nameEl = document.querySelector('.profile-name');
    const cards = document.querySelectorAll('.article-card').length;
    const totalText = (document.querySelector('.pagination') || {}).innerText || '';
    const backBtn = Boolean([...document.querySelectorAll('button')].find(b => (b.innerText||'').includes('返回广场')));
    return { name: nameEl ? nameEl.innerText.trim() : '', cards, totalText, backBtn };
  })()`);
  await s.screenshot(`${OUT}/profile.png`);

  log('P1-1 个人主页头部渲染作者名', dom.name && dom.name.includes(expectedName), `页面="${dom.name}" 期望含"${expectedName}"`);
  log('P1-2 卡片渲染（默认每页 10，min(10, 作者总数)）', okCards && dom.cards === Math.min(10, expectedCount) && expectedCount > 0, `卡片=${dom.cards} 期望=${Math.min(10, expectedCount)} 作者总数=${expectedCount}`);
  log('P1-3 分页 total 取过滤后真实条数（「共 N 条」）', dom.totalText.includes(`共 ${expectedCount} 条`), `分页文本="${dom.totalText.replace(/\n/g, ' ').trim()}"`);
  log('P1-4 提供「返回广场」入口', dom.backBtn, `backBtn=${dom.backBtn}`);

  // ---------- 空态：Fetch 拦截造假响应，让该作者命中 0 篇 ----------
  const emptyBody = JSON.stringify({
    code: 0,
    message: 'ok',
    data: {
      list: [
        {
          id: 999999,
          title: '其他作者的文章',
          summary: '不属于目标作者，应当被前端过滤掉',
          author: { id: 888888, username: 'other', nickname: '其他作者' },
          createdAt: '2026-09-29T14:00:00.000Z',
          updatedAt: '2026-09-29T14:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 100,
      total: 1,
      totalPages: 1,
    },
  });

  const fetchHandler = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    // 跨域预检要单独回 204 + CORS 头，否则真实请求会被浏览器挡掉（docs/ACCEPTANCE.md 记过这个坑）。
    if (m.params.request.method === 'OPTIONS') {
      s.send('Fetch.fulfillRequest', {
        requestId: m.params.requestId,
        responseCode: 204,
        responseHeaders: [
          { name: 'Access-Control-Allow-Origin', value: CONFIG.frontend },
          { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
          { name: 'Access-Control-Allow-Headers', value: 'Content-Type,Authorization' },
        ],
      }).catch(() => {});
      return;
    }
    const url = m.params.request.url || '';
    if (url.includes('pageSize=100')) {
      s.send('Fetch.fulfillRequest', {
        requestId: m.params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Access-Control-Allow-Origin', value: CONFIG.frontend },
        ],
        body: Buffer.from(emptyBody, 'utf8').toString('base64'),
      }).catch(() => {});
    } else {
      s.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    }
  };
  s.onEvent(fetchHandler);
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*pageSize=100*' }] });
  await s.goto(targetUrl);
  const okEmpty = await waitFor(`Boolean(document.querySelector('.el-empty'))`, 8000);
  const noCard = await s.evaluate(`document.querySelectorAll('.article-card').length === 0`);
  await s.screenshot(`${OUT}/profile-empty.png`);
  await s.send('Fetch.disable');
  s.offEvent(fetchHandler);

  log('P2-1 该作者 0 篇时复用 EmptyState', okEmpty, okEmpty ? '页面出现 .el-empty' : '未出现 .el-empty');
  log('P2-2 空态下不残留卡片', noCard, noCard ? '卡片数=0' : '仍有卡片');

  console.log('\n===== 个人主页量化探针汇总 =====');
  const passN = summary.filter((x) => x.ok).length;
  console.log(`通过 ${passN}/${summary.length}`);
  summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));
} catch (e) {
  console.log('\n[执行中断] ' + (e && e.message ? e.message : String(e)));
} finally {
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
  // 清理自己造的数据，还原验收前库内容（不动用户原有文章）
  try {
    const r = await cleanupFixtures(fx ? fx.all : [], [MARKERS.comment]);
    if (r.ok) console.log(`已清理夹具数据：文章 ${r.articles} 篇 / 评论 ${r.comments + r.marked} 条`);
  } catch {
    /* noop */
  }
}

async function cdpAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

// 开跑前自愈：回收上一次遗留的临时文章（若 fixtures.json 还在）
async function cleanupKnownArtifactsSafe() {
  try {
    const { cleanupKnownArtifacts } = await import('./lib/fixtures.mjs');
    await cleanupKnownArtifacts();
  } catch {
    /* noop */
  }
}

process.exit(summary.every((x) => x.ok) ? 0 : 1);
