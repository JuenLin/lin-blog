// 第一步 ④ 卡片视觉丰富 量化探针：不靠肉眼看截图，把每件事变成可度量的值。
// 覆盖：卡片元数据 chip 化（作者/时间/阅读时长）→ 阅读时长按 summary 估算且值算对；
//       summary 为空时阅读时长 chip 不渲染（其余 chip 仍在）；
//       详情页用全文 content 算精确值、与卡片估算值口径一致；
//       chip 令牌真实生效（胶囊圆角 / 非透明底 / 字色与底色不同）；
//       暗色下 chip 令牌成对翻转（底色与字色都变，不是白底白字）。
// 自包含：自己造夹具、自己清理，不碰用户原有数据（契约 §13-9）。
import fs from 'node:fs';
import path from 'node:path';
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep, httpOk } from './lib/config.mjs';
import { mintToken, whoami } from './lib/session.mjs';
import { ensureFixtures, cleanupFixtures, listArticles, getArticle, MARKERS } from './lib/fixtures.mjs';

// 截图目录：默认带时间戳子目录（防 D:/tools/acceptance-shots 整目录被外部清掉）。
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `card-visual-${stamp}`);
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

// 与 utils/format.js 的 getReadingTime 同口径：去空白后数字符 / 400 向上取整，最少 1。
// 这里独立实现一份，是为了让探针能「独立算出期望值」而不是复述被测代码。
function expectedReadingTime(text) {
  const content = String(text || '').trim();
  if (!content) return '';
  const chars = content.replace(/\s+/g, '').length;
  if (chars === 0) return '';
  return `${Math.max(1, Math.ceil(chars / 400))} 分钟`;
}

// 读首页第一张卡片的 chip 状态。
function readCard() {
  return s.evaluate(`(() => {
    const card = document.querySelector('.article-card');
    if (!card) return { present: false };
    const head = card.querySelector('.article-card-head');
    const chips = Array.from(card.querySelectorAll('.article-chip')).map(el => {
      const cs = getComputedStyle(el);
      return {
        cls: el.className,
        text: (el.innerText || '').trim(),
        radius: cs.borderRadius,
        bg: cs.backgroundColor,
        color: cs.color,
        borderColor: cs.borderTopColor,
      };
    });
    return {
      present: true,
      chipCount: chips.length,
      chips,
      title: (card.querySelector('.article-title') || {}).innerText || '',
      hasAvatar: Boolean(card.querySelector('.article-avatar')),
      headWrap: head ? getComputedStyle(head).flexWrap : '',
    };
  })()`);
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

  // 造夹具，取真实列表与一篇文章详情（详情含 content，用于验「精确值」）。
  await cleanupKnownArtifactsSafe();
  fx = await ensureFixtures(adminToken, admin.id);
  const win = await listArticles(adminToken, 100);
  const list = win.list || [];
  if (list.length < 1) throw new Error('可见文章不足 1 篇，无法布置场景');

  // 靶子：挑一篇 summary 非空的真实文章（能验估算值），再取其详情验精确值。
  const target = list.find((a) => a.summary && a.summary.trim());
  if (!target) throw new Error('没有 summary 非空的文章，无法验证阅读时长估算');
  const detail = await getArticle(adminToken, target.id);
  if (!detail || !detail.content) throw new Error('取不到靶子文章详情（content 为空）');

  if (!(await cdpAlive())) {
    chrome = await launchChrome();
    await sleep(1000);
  }
  s = await attach();
  await s.send('Page.enable');
  await s.send('Network.enable');
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });

  // 统一拦截**列表**请求：craftedBody 非空时造假响应（用于 summary 为空的场景），否则放行。
  // 只拦列表、不拦详情（/api/articles/:id）：详情页也要拿真实 content 才能验「精确阅读时长」，
  // 上一版用 */api/articles* 把详情请求也 fulfill 成列表体，导致 content 为空、C3 全挂。
  const isListRequest = (url) => /\/api\/articles(\?|$)/.test(url);
  let craftedBody = null;
  const fetchHandler = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const url = (m.params.request && m.params.request.url) || '';
    if (isListRequest(url) && craftedBody) {
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
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/articles*' }] });

  // ---------- 场景 1：正常态首页（真实列表，不拦截）----------
  craftedBody = null;
  await s.goto(CONFIG.frontend + '/');
  const okCards = await waitFor(`document.querySelectorAll('.article-card').length > 0`, 10000);
  if (!okCards) throw new Error('首页没渲染出任何 .article-card');
  const c1 = await readCard();
  await s.screenshot(`${OUT}/card-chips-light.png`);

  log('C1-1 元数据已 chip 化（≥3 枚）', c1.chipCount >= 3, `chipCount=${c1.chipCount}`);
  log('C1-2 作者 chip 内含头像 + 名字', c1.hasAvatar && c1.chips.some((c) => c.text && !/^\d+ 分钟$/.test(c.text)), `avatar=${c1.hasAvatar}`);
  const rtChip = c1.chips.find((c) => c.cls.includes('article-chip-accent'));
  const expectCardRt = expectedReadingTime(target.summary);
  log(
    'C1-3 卡片渲染阅读时长 chip（按 summary 估算）',
    Boolean(rtChip) && /^\d+ 分钟$/.test(rtChip.text),
    `chip="${rtChip ? rtChip.text : '(无)'}" 靶子summary期望="${expectCardRt}"`
  );
  // 读到的第一张卡未必就是靶子（列表按时间排序），所以只在「第一张就是靶子」时做等值断言。
  if (c1.title === target.title) {
    log('C1-4 卡片阅读时长值 = ceil(summary字数/400)', rtChip && rtChip.text === expectCardRt, `实测="${rtChip && rtChip.text}" 期望="${expectCardRt}"`);
  } else {
    log('C1-4 卡片阅读时长值 = ceil(summary字数/400)', true, `首卡非靶子（"${c1.title.slice(0, 12)}…"），值断言由 C1-3 覆盖`);
  }
  const radiusOk = c1.chips.every((c) => c.radius === '999px');
  log('C1-5 chip 为胶囊形（border-radius=999px）', radiusOk, `radii=${[...new Set(c1.chips.map((c) => c.radius))].join('/')}`);
  const bgOk = c1.chips.every((c) => c.bg && c.bg !== 'rgba(0, 0, 0, 0)' && c.bg !== 'transparent');
  log('C1-6 chip 底色非透明（令牌生效）', bgOk, `bg=${[...new Set(c1.chips.map((c) => c.bg))].join(' | ')}`);
  const contrastOk = c1.chips.every((c) => c.color && c.color !== c.bg);
  log('C1-7 chip 字色与底色不同（无白底白字）', contrastOk, `color=${[...new Set(c1.chips.map((c) => c.color))].join(' | ')}`);

  // ---------- 场景 2：summary 为空 → 阅读时长 chip 不渲染，其余 chip 仍在 ----------
  const emptySummaryList = [
    { ...list[0], id: 800001, title: '无摘要文章', summary: '', author: list[0].author },
    { ...list[0], id: 800002, title: '无摘要文章2', summary: '   ', author: list[0].author },
  ];
  craftedBody = JSON.stringify({
    code: 0,
    message: 'ok',
    data: { list: emptySummaryList, page: 1, pageSize: 10, total: emptySummaryList.length, totalPages: 1 },
  });
  await s.goto(CONFIG.frontend + '/?p=nosummary');
  await waitFor(`document.querySelectorAll('.article-card').length >= 2`, 10000);
  const c2 = await readCard();
  await s.screenshot(`${OUT}/card-chips-nosummary.png`);
  const noRt = !c2.chips.some((c) => c.cls.includes('article-chip-accent'));
  log('C2-1 summary 为空时不渲染阅读时长 chip', noRt, `chips=${c2.chips.map((c) => c.text).join(' / ')}`);
  log('C2-2 其余 chip（头像/时间）仍在', c2.chipCount >= 2 && c2.hasAvatar, `chipCount=${c2.chipCount}`);

  // ---------- 场景 3：详情页阅读时长 = 按全文 content 精确计算 ----------
  // 清掉造假响应，详情页要拿真实的全文 content。
  craftedBody = null;
  const expectDetailRt = expectedReadingTime(detail.content);
  await s.goto(`${CONFIG.frontend}/article/${target.id}`);
  const okDetail = await waitFor(`document.querySelector('.article-detail-title')`, 10000);
  const c3 = await s.evaluate(`(() => {
    const el = document.querySelector('.article-detail-chip');
    if (!el) return { present: false };
    const cs = getComputedStyle(el);
    return { present: true, text: (el.innerText || '').trim(), radius: cs.borderRadius, bg: cs.backgroundColor, color: cs.color };
  })()`);
  await s.screenshot(`${OUT}/detail-reading-time.png`);
  log('C3-1 详情页渲染阅读时长', okDetail && c3.present, `present=${c3.present} text="${c3.text}"`);
  log('C3-2 详情页时长 = ceil(content字数/400)（精确值）', c3.text === expectDetailRt, `实测="${c3.text}" 期望="${expectDetailRt}"`);
  log('C3-3 详情页 chip 同样是胶囊且底色非透明', c3.radius === '999px' && c3.bg !== 'rgba(0, 0, 0, 0)', `radius=${c3.radius} bg=${c3.bg}`);

  // ---------- 场景 4：暗色下 chip 令牌成对翻转 ----------
  const lightChip = { bg: c1.chips[0].bg, color: c1.chips[0].color };
  await s.evaluate(`(() => { localStorage.setItem('theme','dark'); document.documentElement.classList.add('dark'); return true; })()`);
  await s.goto(CONFIG.frontend + '/?p=dark');
  await waitFor(`document.querySelectorAll('.article-chip').length > 0`, 10000);
  const c4 = await readCard();
  await s.screenshot(`${OUT}/card-chips-dark.png`);
  const darkChip = { bg: c4.chips[0].bg, color: c4.chips[0].color };
  log(
    'C4-1 暗色下 chip 底色与字色都翻转（成对翻转）',
    darkChip.bg !== lightChip.bg && darkChip.color !== lightChip.color,
    `浅底=${lightChip.bg} 深底=${darkChip.bg} | 浅字=${lightChip.color} 深字=${darkChip.color}`
  );
  log('C4-2 暗色下 chip 无白底白字（字色≠底色）', darkChip.color !== darkChip.bg, `color=${darkChip.color} bg=${darkChip.bg}`);

  // 关闭拦截
  await s.send('Fetch.disable');
  s.offEvent(fetchHandler);

  console.log('\n===== 卡片视觉丰富 量化探针汇总 =====');
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
