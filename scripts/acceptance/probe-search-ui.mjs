// 第七批 前端搜索框 量化探针：把「搜索框能用」变成可度量的值。
// 覆盖：① AppHeader 全站渲染（登录 / 未登录都在）；② 回车触发 → URL 带 keyword 且已 encode；
//       ③ 真实请求带 keyword（抓 Network，不是看代码）；④ 结果集合与后端返回的 id 集合逐一相等；
//       ⑤ 刷新页面搜索态保留；⑥ 有词 0 结果的独立文案 + 清空搜索按钮；⑦ 无词空态文案不误出现；
//       ⑧ 搜索后 page 重置为 1（在第 2 页状态下搜）；⑨ 切 Tab 仍保留 keyword；
//       ⑩ 点「清空搜索」后列表恢复；⑪ 详情页 / 个人主页搜索框可见、回车跳回首页带 keyword；
//       ⑫ 两处阅读时长 chip 的 el-tooltip 悬停出「预计阅读时长」。
// 自包含：自己造夹具、自己清理，不碰用户原有数据（契约 §13-9）。
import fs from 'node:fs';
import path from 'node:path';
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, PREFIX, sleep, httpOk } from './lib/config.mjs';
import { mintToken, whoami } from './lib/session.mjs';
import { ensureFixtures, cleanupFixtures, listArticles, getArticle, MARKERS } from './lib/fixtures.mjs';

// 截图目录：带时间戳子目录（防 D:/tools/acceptance-shots 整目录被外部清掉）。
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `search-ui-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

// 造一个绝对搜不到的关键词：PREFIX 是「验收占位」，夹具标题都带它，所以用另一串。
const MISS = 'zzz绝对搜不到的关键词zzz';

let chrome = null;
let s = null;
let fx = null;
const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

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

const curUrl = () => s.evaluate('location.href');
const curPath = () => s.evaluate('location.pathname');

// 抓真实网络请求（不是看源码猜的）。
let net = [];
const listReqs = () => net.filter((n) => n.url.includes('/api/articles?') || n.url.endsWith('/api/articles'));

// 往搜索框里填值并回车。
// 用 DOM 事件而不是 CDP 键盘：el-input 把 $attrs（含 @keyup）绑在内部 <input> 上，
// 冒泡到内部 input 的 keyup 就能触发 submit，和真实敲键盘走同一条路径。
async function typeAndEnter(text) {
  return s.evaluate(`(() => {
    const el = document.querySelector('.search-bar input');
    if (!el) return false;
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  })()`);
}

// 悬停到某个元素上，验证 el-tooltip 的弹出内容。
// ---------- SU-12 tooltip ----------
// 方案 D 起，卡片时间 chip 悬停出的是**绝对时间**（如 2026/10/3 01:49:50），
// 不再是「预计阅读时长」（那个 tooltip 随卡片阅读时长 chip 一起移除了）。
// 详情页阅读时长 chip 保留，tooltip 仍是「预计阅读时长」。
async function hoverTooltipText(sel, matcher) {
  // matcher 要被拼进 s.evaluate 的页面上下文中执行，必须序列化成**源码字符串**。
  // 直接插值正则对象会变成 /re/ 字面量文本——含 \d 的正则插进页面就是语法错误。
  const reSrc = matcher instanceof RegExp ? matcher.source : String(matcher);
  const box = await s.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) return { hovered: false, tip: '' };
  // 先把鼠标挪开再挪回来，确保一定产生一次 enter（el-tooltip 默认 trigger=hover）。
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  await sleep(120);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  const shown = await waitFor(
    `Array.from(document.querySelectorAll('.el-popper')).some(p => new RegExp(${JSON.stringify(reSrc)}).test((p.innerText||'')))`,
    5000
  );
  const tip = await s.evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(reSrc)});
    const hit = Array.from(document.querySelectorAll('.el-popper')).find(p => re.test((p.innerText||'')));
    return hit ? (hit.innerText || '').trim() : '';
  })()`);
  return { hovered: true, shown, tip };
}

const hoverTooltip = (sel) => hoverTooltipText(sel, /预计阅读时长/);

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

  await cleanupKnownArtifactsSafe();
  fx = await ensureFixtures(adminToken, admin.id);
  const win = await listArticles(adminToken, 100);
  const list = win.list || [];
  if (!list.length) throw new Error('可见文章不足 1 篇，无法布置场景');
  const target = list[0];
  const targetDetail = await getArticle(adminToken, target.id);

  if (!(await cdpAlive())) {
    chrome = await launchChrome();
    await sleep(1000);
  }
  s = await attach();
  await s.send('Page.enable');
  await s.send('Network.enable');
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  s.onEvent((m) => {
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (u.includes('/api/articles')) {
        net.push({ method: m.params.request.method, url: decodeURIComponent(u), raw: u, id: m.params.requestId });
      }
    }
    if (m.method === 'Network.responseReceived') {
      const hit = net.find((x) => x.id === m.params.requestId);
      if (hit) hit.status = m.params.response.status;
    }
  });

  // ---------- SU-1 未登录时搜索框也在（AppHeader 是全站布局） ----------
  await s.goto(CONFIG.frontend + '/');
  await s.evaluate(`localStorage.removeItem('token'); 1`);
  await s.goto(CONFIG.frontend + '/');
  const okBar = await waitFor(`!!document.querySelector('.search-bar input')`, 10000);
  const barInfo = await s.evaluate(`(() => {
    const el = document.querySelector('.search-bar input');
    if (!el) return { present: false };
    return {
      present: true,
      inHeader: Boolean(el.closest('.app-header')),
      placeholder: el.placeholder || '',
      clearable: Boolean(el.closest('.el-input') && el.closest('.el-input').querySelector('.el-input__clear, .el-input__icon')),
      width: Math.round(el.getBoundingClientRect().width),
    };
  })()`);
  log('SU-1 未登录时搜索框渲染在 AppHeader 内', okBar && barInfo.inHeader, `在 header=${barInfo.inHeader} placeholder="${barInfo.placeholder}" 宽 ${barInfo.width}px`);
  await s.screenshot(`${OUT}/su1-header-bar.png`);

  // 造登录态，后续要验「第 2 页状态下搜索」和「清空后恢复」
  await s.evaluate(`localStorage.setItem('token', ${JSON.stringify(adminToken)}); 1`);

  // ---------- SU-2 回车触发 → URL 带 keyword（且已 encode） ----------
  await s.goto(CONFIG.frontend + '/');
  await waitFor(`document.querySelectorAll('.article-card').length > 0`, 10000);
  const baseTotal = await s.evaluate(`document.querySelectorAll('.article-card').length`);
  net = [];
  const typed = await typeAndEnter(PREFIX);
  const okUrl = await waitFor(`new URLSearchParams(location.search).get('keyword') === ${JSON.stringify(PREFIX)}`, 8000);
  const u1 = await curUrl();
  log('SU-2 回车触发搜索，URL 带 keyword', okUrl && typed, `path=${await curPath()} url=${u1} 搜索前卡片 ${baseTotal} 张`);

  // ---------- SU-3 真实请求带 keyword（抓 Network） ----------
  const okReq = await waitFor(`true`, 100);
  await sleep(600);
  const reqs = listReqs();
  const kwReq = reqs.find((r) => r.url.includes('keyword='));
  log('SU-3 请求确实带上 keyword 参数', Boolean(kwReq), kwReq ? kwReq.url : `实际请求=${JSON.stringify(reqs.map((r) => r.url))}`);
  log('SU-3b 该请求 200', Boolean(kwReq && kwReq.status === 200), `status=${kwReq && kwReq.status}`);

  // ---------- SU-4 结果集合与后端返回逐一对齐 ----------
  await waitFor(`!document.querySelector('.home-list.is-refreshing')`, 8000);
  const domIds = await s.evaluate(`Array.from(document.querySelectorAll('.article-card')).map(c => Number((c.getAttribute('href')||'').split('/').pop()))`);
  const apiRes = await fetchJson(`${CONFIG.api}/articles?page=1&pageSize=10&sortBy=createdAt&order=desc&keyword=${encodeURIComponent(PREFIX)}`);
  const apiIds = (apiRes.data ? apiRes.data.list : []).map((a) => a.id);
  const sameSet = domIds.length === apiIds.length && domIds.every((id) => apiIds.includes(id));
  log('SU-4 页面结果与后端命中集合一致', sameSet, `DOM=[${domIds.join(',')}] API=[${apiIds.join(',')}]`);
  const tipInfo = await s.evaluate(`(() => { const el = document.querySelector('.home-search-tip'); return el ? (el.innerText||'').replace(/\\s+/g,' ').trim() : ''; })()`);
  log('SU-4b 顶部有搜索状态提示条', tipInfo.includes('正在搜索') && tipInfo.includes(PREFIX), `text="${tipInfo}"`);
  await s.screenshot(`${OUT}/su4-results.png`);

  // ---------- SU-5 刷新页面搜索态保留 ----------
  await s.goto(CONFIG.frontend + `/?keyword=${encodeURIComponent(PREFIX)}`);
  await waitFor(`document.querySelectorAll('.article-card').length > 0`, 10000);
  const afterReload = await s.evaluate(`(() => {
    const el = document.querySelector('.search-bar input');
    return { value: el ? el.value : '', cards: document.querySelectorAll('.article-card').length };
  })()`);
  log('SU-5 刷新后搜索词与结果都保留', afterReload.value === PREFIX && afterReload.cards > 0, `输入框="${afterReload.value}" 卡片 ${afterReload.cards} 张`);

  // ---------- SU-9 切 Tab 仍保留 keyword ----------
  net = [];
  await s.evaluate(`(() => {
    const t = Array.from(document.querySelectorAll('.el-tabs__item')).find(e => (e.innerText||'').trim() === '最近更新');
    if (t) t.click(); return true;
  })()`);
  await waitFor(`true`, 100);
  await sleep(700);
  const tabReq = listReqs().find((r) => r.url.includes('sortBy=updatedAt'));
  log('SU-9 切 Tab 仍带 keyword（排序与搜索正交）', Boolean(tabReq && tabReq.url.includes('keyword=')), `请求=${tabReq ? tabReq.url : '未捕获'}`);

  // ---------- SU-8 在第 2 页状态下搜索 → page 重置为 1 ----------
  await s.goto(CONFIG.frontend + '/');
  await waitFor(`document.querySelectorAll('.article-card').length > 0`, 10000);
  const hasPager = await s.evaluate(`Boolean(document.querySelector('.el-pagination'))`);
  net = [];
  if (hasPager) {
    // 分页数字是 .el-pager 下的 <li>，不是 <button>（主验收 A3-1 用的是同一个选择器）。
    await s.evaluate(`(() => {
      const li = Array.from(document.querySelectorAll('.el-pager li')).find(x => (x.innerText||'').trim() === '2');
      if (li) li.click(); return true;
    })()`);
    await waitFor(`!document.querySelector('.home-list.is-refreshing')`, 8000);
    await sleep(300);
  }
  const page2Req = listReqs().find((r) => r.url.includes('page=2'));
  net = [];
  await typeAndEnter(PREFIX);
  await waitFor(`!document.querySelector('.home-list.is-refreshing')`, 8000);
  await sleep(400);
  const afterSearch = listReqs().filter((r) => r.url.includes('keyword='));
  const pageReset = afterSearch.length > 0 && afterSearch.every((r) => r.url.includes('page=1'));
  log(
    'SU-8 搜索后 page 重置为 1',
    hasPager && Boolean(page2Req) && pageReset,
    `分页器存在=${hasPager} 翻到第2页请求=${Boolean(page2Req)} 搜索后请求=${JSON.stringify(afterSearch.map((r) => r.url))}`
  );

  // ---------- SU-6 有词 0 结果 → 独立文案 + 清空搜索按钮 ----------
  await typeAndEnter(MISS);
  const okEmpty = await waitFor(
    `(() => { const e = document.querySelector('.el-empty'); return e ? (e.innerText||'').includes('没有找到与') : false; })()`,
    8000
  );
  const emptyInfo = await s.evaluate(`(() => {
    const e = document.querySelector('.el-empty');
    const txt = e ? (e.innerText||'').replace(/\\s+/g,' ').trim() : '';
    const btns = e ? Array.from(e.querySelectorAll('button')).map(b => (b.innerText||'').trim()) : [];
    return { txt, btns, cards: document.querySelectorAll('.article-card').length };
  })()`);
  await s.screenshot(`${OUT}/su6-no-result.png`);
  log(
    'SU-6 搜不到时是独立文案且无卡片',
    okEmpty && emptyInfo.cards === 0 && emptyInfo.txt.includes(MISS),
    `text="${emptyInfo.txt}" 卡片 ${emptyInfo.cards} 张`
  );
  log('SU-6b 搜不到时给「清空搜索」按钮', emptyInfo.btns.some((b) => b.includes('清空搜索')), `按钮=${JSON.stringify(emptyInfo.btns)}`);
  log('SU-6c 搜不到时不误显示「还没有文章」', !emptyInfo.txt.includes('还没有文章'), `命中=${emptyInfo.txt.includes('还没有文章')}`);

  // ---------- SU-10 点「清空搜索」后列表恢复 ----------
  net = [];
  await s.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('.el-empty button')).find(x => (x.innerText||'').includes('清空搜索'));
    if (b) b.click(); return true;
  })()`);
  const okClear = await waitFor(`document.querySelectorAll('.article-card').length > 0`, 8000);
  const afterClear = await s.evaluate(`(() => ({
    kw: new URLSearchParams(location.search).get('keyword'),
    value: (document.querySelector('.search-bar input')||{}).value || '',
    tip: Boolean(document.querySelector('.home-search-tip')),
  }))()`);
  await sleep(300);
  const clearReq = listReqs().find((r) => !r.url.includes('keyword='));
  log('SU-10 点「清空搜索」恢复全量列表', okClear && afterClear.kw === null && afterClear.value === '' && !afterClear.tip, `keyword=${afterClear.kw} 输入框="${afterClear.value}" 提示条=${afterClear.tip} 恢复请求=${Boolean(clearReq)}`);
  await s.screenshot(`${OUT}/su10-cleared.png`);

  // ---------- SU-7 无词空态文案未被污染（回归） ----------
  const noKwEmptyCopy = await s.evaluate(`(() => {
    const e = document.querySelector('.el-empty');
    return e ? (e.innerText||'') : '';
  })()`);
  log('SU-7 未搜索时不出现搜索相关文案', !noKwEmptyCopy.includes('没有找到与'), `空态文案="${noKwEmptyCopy.replace(/\\s+/g,' ').trim()}"`);

  // ---------- SU-11 详情页 / 个人主页：搜索框可见 + 回车跳回首页 ----------
  await s.goto(`${CONFIG.frontend}/article/${target.id}`);
  await waitFor(`document.querySelector('.search-bar input')`, 10000);
  const detailBar = await s.evaluate(`(() => {
    const el = document.querySelector('.search-bar input');
    return { present: Boolean(el), onDetail: location.pathname.startsWith('/article/') };
  })()`);
  log('SU-11a 详情页搜索框可见', detailBar.present && detailBar.onDetail, `path=${detailBar.onDetail}`);
  await s.screenshot(`${OUT}/su11a-detail-bar.png`);

  await typeAndEnter(PREFIX);
  const okJump = await waitFor(`location.pathname === '/' && new URLSearchParams(location.search).get('keyword') === ${JSON.stringify(PREFIX)}`, 8000);
  log('SU-11b 详情页回车 → 跳回首页并带 keyword', okJump, `url=${await curUrl()}`);

  if (targetDetail && targetDetail.author && targetDetail.author.id) {
    await s.goto(`${CONFIG.frontend}/user/${targetDetail.author.id}`);
    const okProfBar = await waitFor(`!!document.querySelector('.search-bar input')`, 10000);
    await typeAndEnter(PREFIX);
    const okProfJump = await waitFor(`location.pathname === '/' && new URLSearchParams(location.search).get('keyword') === ${JSON.stringify(PREFIX)}`, 8000);
    log('SU-11c 个人主页搜索框可见且回车跳首页', okProfBar && okProfJump, `搜索框=${okProfBar} 跳转=${okProfJump} url=${await curUrl()}`);
    await s.screenshot(`${OUT}/su11c-profile-bar.png`);
  }

  // ---------- SU-12 tooltip：卡片时间 chip → 绝对时间；详情页阅读时长 chip → 说明 ----------
  await s.goto(CONFIG.frontend + '/');
  await waitFor(`document.querySelector('.article-chip-time')`, 10000);
  // 绝对时间格式：Y/M/D 时:分:秒（年/date 部分不补零，时分秒补零）。
  // 正则放在Node 侧构造后序列化进去，避免模板字符串里出现反斜杠转义问题。
  const ABSOLUTE_RE = /\d{4}\/\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2}/;
  const cardChip = await hoverTooltipText('.article-chip-time', ABSOLUTE_RE);
  log('SU-12a 卡片时间 chip 悬停出绝对时间', cardChip.shown, `hover=${cardChip.hovered} tip="${cardChip.tip}"`);
  await s.screenshot(`${OUT}/su12a-card-tooltip.png`);

  // 卡片正文显示的应是相对时间（不是绝对时间），两者不能混。
  const cardChipText = await s.evaluate(`(() => {
    const el = document.querySelector('.article-chip-time');
    return el ? (el.innerText || '').trim() : '';
  })()`);
  const isRelative = /^(刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前|\d{4}\/\d{1,2}\/\d{1,2})$/.test(cardChipText);
  log('SU-12a2 卡片 chip 本身显示相对时间（与 tooltip 的绝对时间互补）', isRelative && cardChipText !== cardChip.tip.trim(), `chip="${cardChipText}"`);

  await s.goto(`${CONFIG.frontend}/article/${target.id}`);
  await waitFor(`document.querySelector('.article-detail-chip')`, 10000);
  const detailChip = await hoverTooltip('.article-detail-chip');
  log('SU-12b 详情页阅读时长 chip 悬停出「预计阅读时长」', detailChip.shown, `hover=${detailChip.hovered} tip="${detailChip.tip}"`);
  await s.screenshot(`${OUT}/su12b-detail-tooltip.png`);

  // 暗色模式下 tooltip 也要能看清（配色已在第五批定稿，这里只做存在性回归）
  await s.evaluate(`document.documentElement.classList.add('dark'); 1`);
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
  const darkChip = await hoverTooltip('.article-detail-chip');
  log('SU-12c 暗色模式下 tooltip 同样可弹出', darkChip.shown, `tip="${darkChip.tip}"`);
  await s.screenshot(`${OUT}/su12c-dark-tooltip.png`);

  console.log(`\n截图目录：${OUT}`);
  console.log('===== 前端搜索框 量化探针汇总 =====');
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

async function fetchJson(url) {
  const res = await fetch(url);
  try {
    return await res.json();
  } catch {
    return null;
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
