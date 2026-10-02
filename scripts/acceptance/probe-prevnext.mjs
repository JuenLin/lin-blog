// 第一步 ③ 上一篇/下一篇 量化探针：不靠肉眼看截图，把每件事变成可度量的值。
// 覆盖：拉 100 篇有序窗口定位当前篇、上=更旧(下一条)/下=更新(上一条)、边界禁用、超出窗口两条都禁用。
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
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `prevnext-${stamp}`);
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

// 读导航区状态：两个 router-link 的 disabled 标志、标题、href。
function readNav() {
  return s.evaluate(`(() => {
    const links = Array.from(document.querySelectorAll('.article-nav-link'));
    const prev = links.find(l => l.classList.contains('article-nav-prev'));
    const next = links.find(l => l.classList.contains('article-nav-next'));
    const txt = (el) => el ? (el.querySelector('.article-nav-title') || {}).innerText || '' : null;
    const href = (el) => el ? (el.getAttribute('href') || '') : null;
    return {
      count: links.length,
      prevDisabled: prev ? prev.classList.contains('is-disabled') : null,
      nextDisabled: next ? next.classList.contains('is-disabled') : null,
      prevTitle: txt(prev),
      nextTitle: txt(next),
      prevHref: href(prev),
      nextHref: href(next),
    };
  })()`);
}

// 造假窗口的响应体（data.list 形状与 API.md 一致）。entries 是真实列表项副本。
function craftBody(entries) {
  return JSON.stringify({
    code: 0,
    message: 'ok',
    data: { list: entries, page: 1, pageSize: 100, total: entries.length, totalPages: 1 },
  });
}

try {
  if ((await httpOk(CONFIG.frontend)) !== 200) {
    throw new Error(`前端 ${CONFIG.frontend} 探不到。请先 npm run dev（端口必须是 5173）。`);
  }
  if ((await httpOk(`${CONFIG.api}/articles?page=1&pageSize=1`)) !== 200) {
    throw new Error(`后端 ${CONFIG.api} 探不到。请先起后端 3000。`);
  }

  const adminToken = mintToken(CONFIG.adminId, `user${CONFIG.adminId}`).token;
  const admin = await whoami(adminToken);
  if (!admin) throw new Error(`userId=${CONFIG.adminId} 的 token 无效`);

  // 造夹具，并取真实有序窗口（createdAt desc），挑一个一定在窗口内且两侧都有邻居的靶子。
  await cleanupKnownArtifactsSafe();
  fx = await ensureFixtures(adminToken, admin.id);
  const win = await listArticles(adminToken, 100);
  if ((win.list || []).length < 4) {
    throw new Error(`可见文章不足 4 篇，无法布置 4 个场景（当前 ${(win.list || []).length} 篇）`);
  }
  const win0 = win.list[0];
  const target = win.list[1]; // 靶子：真实存在、在窗口内，且上下都有邻居
  const win2 = win.list[2];
  const win3 = win.list[3];

  if (!(await cdpAlive())) {
    chrome = await launchChrome();
    await sleep(1000);
  }
  s = await attach();
  await s.send('Page.enable');
  await s.send('Network.enable');

  // 统一拦截 pageSize=100 列表请求：craftedBody 非空时造假响应，否则放行真实请求。
  let craftedBody = null;
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
    const url = (m.params.request && m.params.request.url) || '';
    if (url.includes('pageSize=100') && craftedBody) {
      s.send('Fetch.fulfillRequest', {
        requestId: m.params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Access-Control-Allow-Origin', value: CONFIG.frontend },
        ],
        body: Buffer.from(craftedBody, 'utf8').toString('base64'),
      }).catch(() => {});
    } else {
      s.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    }
  };
  s.onEvent(fetchHandler);
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*pageSize=100*' }] });

  const targetUrl = CONFIG.frontend + '/article/' + target.id;

  // ---------- 场景 1：正常态（真实列表，不拦截）----------
  craftedBody = null;
  await s.goto(targetUrl);
  const okNav1 = await waitFor(`document.querySelectorAll('.article-nav-link').length === 2`, 10000);
  const nav1 = await readNav();
  // 真实窗口里：下一篇(更新)=win0，上一篇(更旧)=win2
  const expectNext1 = win0.title;
  const expectPrev1 = win2.title;
  await s.screenshotFull(`${OUT}/prevnext-normal.png`);
  log('N1-1 导航区渲染两个链接', nav1.count === 2, `count=${nav1.count}`);
  log('N1-2 下一篇=更新(win[0]) 标题正确', !nav1.nextDisabled && nav1.nextTitle === expectNext1, `实测="${nav1.nextTitle}" 期望="${expectNext1}"`);
  log('N1-3 上一篇=更旧(win[2]) 标题正确', !nav1.prevDisabled && nav1.prevTitle === expectPrev1, `实测="${nav1.prevTitle}" 期望="${expectPrev1}"`);
  log('N1-4 两链接均非禁用', nav1.prevDisabled === false && nav1.nextDisabled === false, `prevDisabled=${nav1.prevDisabled} nextDisabled=${nav1.nextDisabled}`);

  // ---------- 场景 2：当前为最新（index 0）→ 下一篇(更新)禁用，上一篇(更旧)可用 ----------
  craftedBody = craftBody([{ ...target }, { ...win3 }]); // [当前, 更旧]
  await s.goto(targetUrl);
  await waitFor(`document.querySelectorAll('.article-nav-link').length === 2`, 10000);
  const nav2 = await readNav();
  await s.screenshotFull(`${OUT}/prevnext-newest.png`);
  log('N2-1 当前为最新：下一篇禁用', nav2.nextDisabled === true, `nextDisabled=${nav2.nextDisabled}`);
  log('N2-2 当前为最新：上一篇可用且指向更旧(win[3])', !nav2.prevDisabled && nav2.prevTitle === win3.title, `实测="${nav2.prevTitle}" 期望="${win3.title}"`);
  log('N2-3 上一篇链接 href 含真实 id', nav2.prevHref && nav2.prevHref.includes('/article/' + win3.id), `href="${nav2.prevHref}"`);

  // ---------- 场景 3：当前为最旧（窗口末位）→ 上一篇(更旧)禁用，下一篇(更新)可用 ----------
  craftedBody = craftBody([{ ...win0 }, { ...target }]); // [更新, 当前]
  await s.goto(targetUrl);
  await waitFor(`document.querySelectorAll('.article-nav-link').length === 2`, 10000);
  const nav3 = await readNav();
  await s.screenshotFull(`${OUT}/prevnext-oldest.png`);
  log('N3-1 当前为最旧：上一篇禁用', nav3.prevDisabled === true, `prevDisabled=${nav3.prevDisabled}`);
  log('N3-2 当前为最旧：下一篇可用且指向更新(win[0])', !nav3.nextDisabled && nav3.nextTitle === win0.title, `实测="${nav3.nextTitle}" 期望="${win0.title}"`);
  log('N3-3 下一篇链接 href 含真实 id', nav3.nextHref && nav3.nextHref.includes('/article/' + win0.id), `href="${nav3.nextHref}"`);

  // ---------- 场景 4：当前超出 100 篇窗口 → 两条都禁用 ----------
  craftedBody = craftBody([{ ...win0 }, { ...win2 }]); // 不含 target
  await s.goto(targetUrl);
  await waitFor(`document.querySelectorAll('.article-nav-link').length === 2`, 10000);
  const nav4 = await readNav();
  await s.screenshotFull(`${OUT}/prevnext-outofwindow.png`);
  log('N4-1 超出窗口：上一篇禁用', nav4.prevDisabled === true, `prevDisabled=${nav4.prevDisabled}`);
  log('N4-2 超出窗口：下一篇禁用', nav4.nextDisabled === true, `nextDisabled=${nav4.nextDisabled}`);
  log('N4-3 超出窗口：两条均显示「不可用」占位', /不可用/.test(nav4.prevTitle) && /不可用/.test(nav4.nextTitle), `prev="${nav4.prevTitle}" next="${nav4.nextTitle}"`);

  // 关闭拦截
  await s.send('Fetch.disable');
  s.offEvent(fetchHandler);

  console.log('\n===== 上一篇/下一篇 量化探针汇总 =====');
  const passN = summary.filter((x) => x.ok).length;
  console.log(`通过 ${passN}/${summary.length}`);
  summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));
} catch (e) {
  console.log('\n[执行中断] ' + (e && e.message ? e.message : String(e)));
} finally {
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
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

async function cleanupKnownArtifactsSafe() {
  try {
    const { cleanupKnownArtifacts } = await import('./lib/fixtures.mjs');
    await cleanupKnownArtifacts();
  } catch {
    /* noop */
  }
}

process.exit(summary.every((x) => x.ok) ? 0 : 1);
