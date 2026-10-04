// 分类功能 量化探针：把 docs/API.md「category 语义」逐条变成可度量的断言。
// 前半段纯后端 API（不启 Chrome）；后半段启 Chrome 验「卡片渲染分类 chip 且复用 .article-chip 基类」。
// 自包含：自己造靶子文章、自己清理，不碰用户原有数据（契约 §13-9）。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, PREFIX, sleep, httpOk } from './lib/config.mjs';
import { mintToken, whoami } from './lib/session.mjs';
import { cleanupFixtures, MARKERS } from './lib/fixtures.mjs';
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';

// 报告目录：带时间戳子目录（防 D:/tools/acceptance-shots 整目录被外部清掉）。
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `category-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

const ARTICLES = `${CONFIG.api}/articles`;
const CATEGORIES = ['技术', '生活', '随笔', '未分类'];

const selfMade = []; // 本脚本自造的靶子文章 id（必须单独回收）
const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

// ---- 受限 HTTP 助手（绕过本机代理；本机 node fetch 默认不读 http_proxy，这里只是统一封装）----
async function call(method, qs, token, body) {
  const res = await fetch(ARTICLES + qs, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* noop */
  }
  return { status: res.status, json };
}
const get = (qs) => call('GET', qs);

async function createArticle(token, title, content, category) {
  const body = { title, content };
  if (category !== undefined) body.category = category;
  const r = await call('POST', '', token, body);
  return r.json && r.json.data ? r.json.data : null;
}

// ---- Chrome 助手 ----
let chrome = null;
let s = null;
async function cdpAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}
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

try {
  if ((await httpOk(`${CONFIG.api}/articles?page=1&pageSize=1`)) !== 200) {
    throw new Error(`后端 ${CONFIG.api} 探不到。请先起后端 3000。`);
  }

  const adminToken = mintToken(CONFIG.adminId, `user${CONFIG.adminId}`).token;
  const admin = await whoami(adminToken);
  if (!admin) throw new Error(`userId=${CONFIG.adminId} 的 token 无效`);

  // 自愈清理：清掉上一次中断残留，避免靶子 id 冲突。
  try {
    const { cleanupKnownArtifacts } = await import('./lib/fixtures.mjs');
    await cleanupKnownArtifacts();
  } catch {
    /* noop */
  }

  // ========== 前半段：纯 API 语义 ==========
  // 靶子：一篇技术文章（标题带 KW）、一篇未分类文章（标题也带同 KW，用来证明 category 与 keyword 是 AND）。
  const KW = 'zz分类探针zz';
  const techTitle = `技术专题${KW}`;
  const plainTitle = `普通文章${KW}`;
  const tech = await createArticle(adminToken, techTitle, '这篇分类为技术，标题含探针关键词。', '技术');
  const plain = await createArticle(adminToken, plainTitle, '这篇未分类，标题同样含探针关键词。');
  if (!tech || !plain) throw new Error('造靶子文章失败（技术 / 未分类）');
  selfMade.push(tech.id, plain.id);

  // ---------- CAT-1：POST 不带 category → 默认 未分类 ----------
  const def = await createArticle(adminToken, `默认分类${KW}`, '不带 category 字段的文章。');
  if (!def) throw new Error('造默认分类靶子失败');
  selfMade.push(def.id);
  log(
    'CAT-1 POST 不带 category → 默认 未分类',
    def.category === '未分类',
    `status=200 返回 category="${def.category}" 期望="未分类"`
  );

  // ---------- CAT-2：POST 带 category=技术 → 存为 技术 ----------
  log(
    'CAT-2 POST 带 category=技术 → 写入成功',
    tech.category === '技术',
    `status=200 返回 category="${tech.category}" 期望="技术"`
  );

  // ---------- CAT-3：GET ?category=技术 只返回技术子集 ----------
  const full = await get('?page=1&pageSize=100');
  const allList = full.json.data.list;
  const techCount = allList.filter((a) => a.category === '技术').length;
  const cat = await get(`?page=1&pageSize=100&category=${encodeURIComponent('技术')}`);
  const catList = cat.json.data.list;
  const allTech = catList.length > 0 && catList.every((a) => a.category === '技术');
  // 负向前置：techCount 必须 > 0（我们刚造了一篇），否则「返回 0 篇」也会让 every 恒真。
  log(
    'CAT-3 GET ?category=技术 只返回技术子集',
    cat.status === 200 && techCount > 0 && cat.json.data.total === techCount && allTech,
    `技术总数=${techCount} 过滤total=${cat.json.data.total} 命中=${catList.length} 全部为技术=${allTech}`
  );

  // 列表项必须带 category 字段（字符串）
  const listHasField = catList.length > 0 && catList.every((a) => typeof a.category === 'string');
  log(
    'CAT-8a 列表项响应含 category 字段',
    listHasField,
    `首项category=${catList[0] ? JSON.stringify(catList[0].category) : '(无)'}`
  );

  // ---------- CAT-4：GET ?category=xx（非法）→ 400 / 40000 ----------
  const bad = await get(`?page=1&pageSize=10&category=${encodeURIComponent('xx')}`);
  log(
    'CAT-4 GET ?category=非法值 → 400 / 40000',
    bad.status === 400 && bad.json.code === 40000,
    `status=${bad.status} code=${bad.json.code} msg=${JSON.stringify(bad.json.message)}`
  );

  // ---------- CAT-5：GET ?category=技术&keyword=KW 两条件 AND ----------
  // 前提：keyword=KW 应能同时命中 tech（技术）与 plain（未分类）两篇。
  const kwOnly = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(KW)}`);
  const kwIds = kwOnly.json.data.list.map((a) => a.id);
  const kwHasBoth = kwIds.includes(tech.id) && kwIds.includes(plain.id) && kwOnly.json.data.total >= 2;
  // 叠加 category=技术：只应剩 tech 一篇（plain 被 category 过滤掉）。
  const and = await get(`?page=1&pageSize=100&category=${encodeURIComponent('技术')}&keyword=${encodeURIComponent(KW)}`);
  const andIds = and.json.data.list.map((a) => a.id);
  log(
    'CAT-5a keyword 单独能命中两篇（含未分类）',
    kwHasBoth,
    `keyword="${KW}" total=${kwOnly.json.data.total} 命中技术=${kwIds.includes(tech.id)} 命中未分类=${kwIds.includes(plain.id)}`
  );
  log(
    'CAT-5b category+keyword 是 AND（未分类那篇被过滤掉）',
    and.status === 200 && and.json.data.total === 1 && andIds.length === 1 && andIds[0] === tech.id,
    `叠加后 total=${and.json.data.total} 命中id=${andIds[0]} 期望=${tech.id}`
  );

  // ---------- CAT-6：PUT 不传 category → 保留原值 ----------
  const putNoCat = await call('PUT', `/${tech.id}`, adminToken, {
    title: tech.title,
    content: '正文改动后分类应保持不变。',
  });
  log(
    'CAT-6 PUT 不传 category → 保留原值',
    putNoCat.status === 200 && putNoCat.json.data.category === '技术',
    `status=${putNoCat.status} 返回 category="${putNoCat.json.data.category}" 期望="技术"`
  );

  // ---------- CAT-7：PUT 非法 category → 400 ----------
  const putBad = await call('PUT', `/${tech.id}`, adminToken, {
    title: tech.title,
    content: '正文。',
    category: 'xx',
  });
  log(
    'CAT-7 PUT 非法 category → 400 / 40000',
    putBad.status === 400 && putBad.json.code === 40000,
    `status=${putBad.status} code=${putBad.json.code} msg=${JSON.stringify(putBad.json.message)}`
  );

  // ---------- CAT-8b：详情响应含 category ----------
  const detail = await get(`/${tech.id}`);
  log(
    'CAT-8b GET /:id 详情响应含 category',
    detail.status === 200 && detail.json.data.category === '技术',
    `status=${detail.status} category="${detail.json.data.category}" 期望="技术"`
  );

  // ========== 后半段：Chrome 验卡片分类 chip ==========
  if ((await httpOk(CONFIG.frontend)) !== 200) {
    throw new Error(`前端 ${CONFIG.frontend} 探不到。请先 npm run dev（端口必须是 5173）。`);
  }
  if (!(await cdpAlive())) {
    chrome = await launchChrome();
    await sleep(1000);
  }
  s = await attach();
  await s.send('Page.enable');
  await s.send('Network.enable');

  // 过滤到只剩技术文章（tech），让卡片定位确定。
  const filterUrl = `${CONFIG.frontend}/?category=${encodeURIComponent('技术')}`;
  await s.goto(filterUrl);
  const okCards = await waitFor(
    `(() => { const cards=[...document.querySelectorAll('.article-card')]; return cards.some(c=>{const t=c.querySelector('.article-title');return t&&(t.innerText||'').trim()===${JSON.stringify(techTitle)});}); })()`,
    10000
  );
  const readChip = (light) => s.evaluate(`(() => {
    const want = ${JSON.stringify(techTitle)};
    const cards = Array.from(document.querySelectorAll('.article-card'));
    const card = cards.find(c => { const t=c.querySelector('.article-title'); return t && (t.innerText||'').trim()===want; });
    if (!card) return { found:false, cards: cards.length };
    const chip = card.querySelector('.article-chip-category');
    if (!chip) return { found:true, chipPresent:false };
    const cs = getComputedStyle(chip);
    return { found:true, chipPresent:true, text:(chip.innerText||'').trim(), hasBaseClass: chip.classList.contains('article-chip'), bg: cs.backgroundColor, color: cs.color };
  })()`);

  const light = await readChip(true);
  log(
    'CAT-D1 卡片渲染分类 chip 且复用 .article-chip 基类',
    light.found && light.chipPresent && light.text === '技术' && light.hasBaseClass,
    `定位卡片=${light.found} chip存在=${light.chipPresent} 文本="${light.text}" 含基类=${light.hasBaseClass}`
  );
  log(
    'CAT-D1b 分类 chip 底色非透明（令牌生效）',
    light.chipPresent && light.bg && light.bg !== 'rgba(0, 0, 0, 0)' && light.bg !== 'transparent',
    `bg=${light.bg} color=${light.color}`
  );

  // 暗色下 chip 令牌成对翻转（底色与浅色不同，且仍非透明）。
  await s.evaluate(`(() => { try{localStorage.setItem('theme','dark');}catch(e){} document.documentElement.classList.add('dark'); return true; })()`);
  await s.goto(`${CONFIG.frontend}/?category=${encodeURIComponent('技术')}&p=dark`);
  await waitFor(
    `(() => { const cards=[...document.querySelectorAll('.article-card')]; return cards.some(c=>{const t=c.querySelector('.article-title');return t&&(t.innerText||'').trim()===${JSON.stringify(techTitle)});}); })()`,
    10000
  );
  const dark = await readChip(false);
  log(
    'CAT-D2 暗色下分类 chip 令牌成对翻转（底色变、仍非透明）',
    dark.chipPresent && dark.bg && dark.bg !== 'rgba(0, 0, 0, 0)' && dark.bg !== light.bg,
    `浅底=${light.bg} 深底=${dark.bg} 含基类=${dark.hasBaseClass}`
  );

  console.log(`\n截图目录：${OUT}`);
  console.log('===== 分类功能 量化探针汇总 =====');
  const passN = summary.filter((x) => x.ok).length;
  console.log(`通过 ${passN}/${summary.length}`);
  summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));

  const report = [
    `# 分类功能 探针报告`,
    ``,
    `- 时间戳目录：${OUT}`,
    `- 结果：${passN}/${summary.length} 通过`,
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
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
  try {
    const r = await cleanupFixtures(selfMade, [MARKERS.comment]);
    if (r.ok) console.log(`已清理靶子文章：${r.articles} 篇`);
  } catch {
    /* noop */
  }
}

// 退出码：0 全绿 / 1 有断言失败 / 2 一条断言都没跑到（前置失败或中途中断）。
if (summary.length === 0) process.exit(2);
process.exit(summary.every((x) => x.ok) ? 0 : 1);
