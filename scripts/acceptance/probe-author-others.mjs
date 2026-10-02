// 第一步 ② 作者其他文章 量化探针：不靠肉眼看截图，把每件事变成可度量的值。
// 覆盖：复用 ③ 已拉的 100 篇窗口 → 过滤同作者(排除当前篇)取前 5 → 复用 ArticleCard；
//       窗口内该作者仅当前篇 / 无其他篇时整块不渲染。
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
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `author-others-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

let chrome = null;
let s = null;
let fx = null; // 夹具清单，结尾按 fx.all 精确回收
const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

// CDP 会话只暴露 send/evaluate/goto/screenshot/close，没有 waitFor —— 自己轮询 evaluate（与 run.mjs 一致）。
async function waitFor(expr, t = 10000) {
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

// 读「作者其他文章」区块状态：是否存在、标题、卡片列表（class/href/title）。
function readOthers() {
  return s.evaluate(`(() => {
    const sec = document.querySelector('.author-others');
    if (!sec) return { present: false, title: '', count: 0, cards: [] };
    const title = (sec.querySelector('.author-others-title') || {}).innerText || '';
    const cards = Array.from(sec.querySelectorAll('.article-card')).map(el => ({
      cls: el.className,
      href: el.getAttribute('href') || '',
      title: (el.querySelector('.article-title') || {}).innerText || '',
    }));
    return { present: true, title, count: cards.length, cards };
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

  // 造夹具，并取真实有序窗口（createdAt desc），按 author.id 分组，找窗口内拥有 >=2 篇的作者做靶子。
  await cleanupKnownArtifactsSafe();
  fx = await ensureFixtures(adminToken, admin.id);
  const win = await listArticles(adminToken, 100);
  const list = win.list || [];
  if (list.length < 3) throw new Error(`可见文章不足 3 篇，无法布置场景（当前 ${list.length} 篇）`);

  const byAuthor = {};
  for (const a of list) {
    const k = a.author && a.author.id;
    if (k == null) continue;
    (byAuthor[k] = byAuthor[k] || []).push(a);
  }
  let authorKey = null;
  let group = null;
  for (const k of Object.keys(byAuthor)) {
    if (byAuthor[k].length >= 2) {
      authorKey = k;
      group = byAuthor[k];
      break;
    }
  }
  if (!authorKey) throw new Error('窗口内没有任一作者拥有 >=2 篇文章，无法验证「作者其他文章」正常态');

  const target = group[1]; // 同作者还有 >=1 篇（group[0] 等），确保非零结果
  const expectCount = Math.min(5, group.length - 1);

  if (!(await cdpAlive())) {
    chrome = await launchChrome();
    await sleep(1000);
  }
  s = await attach();
  await s.send('Page.enable');
  await s.send('Network.enable');
  // 禁用缓存，避免 pageSize=100 列表请求被浏览器缓存后绕过 Fetch 拦截，导致场景 2 造假响应不生效。
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });

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

  // ---------- 场景 1：正常态（真实窗口，不拦截）----------
  craftedBody = null;
  await s.goto(targetUrl);
  await waitFor(`document.querySelector('.author-others') || document.querySelector('.article-detail-title')`, 10000);
  const o1 = await readOthers();
  await s.screenshotFull(`${OUT}/author-others-normal.png`);
  log('O1-1 作者其他文章区块渲染', o1.present, `present=${o1.present}`);
  log('O1-2 区块标题为「作者其他文章」', o1.present && o1.title.includes('作者其他文章'), `title="${o1.title}"`);
  log('O1-3 卡片数 = min(5, 同作者窗口内篇数-1)', o1.count === expectCount, `实测=${o1.count} 期望=${expectCount}`);
  const allCardsValid =
    o1.cards.length > 0 &&
    o1.cards.every(
      (c) =>
        c.cls.includes('article-card') &&
        c.href.includes('/article/') &&
        !c.href.endsWith('/' + target.id)
    );
  log('O1-4 每张卡片均为 ArticleCard 且指向非当前篇', allCardsValid, `cards=${o1.cards.length}`);

  // ---------- 场景 2：空态 —— 拦截窗口，使 target 作者仅出现 1 次（即只有当前篇）----------
  // 不依赖库里是否存在其他作者：用合成填充文章（author.id 取一个绝不会与 authorKey 撞的值）构造窗口，
  // 这样窗口里 target 的作者只出现一次，otherArticles 必为空，区块不应渲染。
  const fillerCount = 3;
  const fillers = Array.from({ length: fillerCount }, (_, i) => ({
    id: 900000 + i,
    title: `占位文章 ${i}`,
    summary: '占位正文',
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
    author: { id: 999999, username: 'other_author', nickname: '他人' },
  }));
  const craftedList = [target, ...fillers].map((a) => ({ ...a }));
  craftedBody = craftBody(craftedList);
  // 用唯一 URL 强制整页重载（避免与场景 1 同 URL 被浏览器优化为不重载 / 命中缓存）。
  await s.goto(targetUrl + '?p=2');
  await waitFor(`document.querySelector('.article-detail-title')`, 10000);
  const o2 = await readOthers();
  await s.screenshotFull(`${OUT}/author-others-empty.png`);
  log('O2-1 窗口内该作者仅当前篇时整块不渲染', o2.present === false, `present=${o2.present} count=${o2.count}`);

  // 关闭拦截
  await s.send('Fetch.disable');
  s.offEvent(fetchHandler);

  console.log('\n===== 作者其他文章 量化探针汇总 =====');
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
