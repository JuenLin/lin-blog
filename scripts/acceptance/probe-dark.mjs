// 第五步 ⑤ 暗色模式量化探针：不靠肉眼看截图，把每件事变成可度量的值。
// 覆盖：切换按钮可用、变量成对翻转、EP 组件（输入框 / 主按钮）暗色下无白底白字、刷新保持。
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep } from './lib/config.mjs';

const OUT = process.argv[2] || 'D:/tools/acceptance-shots';

let chrome = null;
let s = null;
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

// 读一组 CSS 变量（documentElement 上），返回 {name: value}。
// 自定义属性浏览器常以作者书写格式（十六进制）返回，这里统一归一化成 rgb(...) 好做断言。
const readVars = async (names) => {
  const raw = await s.evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const o = {};
    ${names.map((n) => `o[${JSON.stringify(n)}] = cs.getPropertyValue(${JSON.stringify(n)}).trim();`).join('\n')}
    return o;
  })()`);
  const norm = (v) => {
    v = (v || '').trim();
    if (v.startsWith('#')) {
      let h = v.slice(1);
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      const n = parseInt(h, 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    }
    return v;
  };
  Object.keys(raw).forEach((k) => (raw[k] = norm(raw[k])));
  return raw;
};

const isDarkClass = () => s.evaluate(`document.documentElement.classList.contains('dark')`);
const lsTheme = () => s.evaluate(`(() => { try { return localStorage.getItem('theme'); } catch(e){ return null; } })()`);

try {
  if (
    !(await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    chrome = await launchChrome();
    await sleep(1000);
  }
  s = await attach();
  await s.send('Page.enable');
  await s.send('Network.enable');

  // 先保证一个干净的浅色基线（清掉可能残留的 theme，重载让 index.html 内联脚本重新判定）
  await s.goto(CONFIG.frontend + '/');
  await sleep(1500);
  await s.evaluate(`try { localStorage.removeItem('theme'); } catch(e){}`);
  await s.goto(CONFIG.frontend + '/');
  await sleep(1800);

  const VARNAMES = [
    '--bg-page', '--bg-card', '--text-strong', '--text-regular',
    '--el-fill-color-blank', '--el-text-color-primary', '--el-color-primary',
    '--el-bg-color-overlay', '--el-skeleton-color',
  ];

  // ---------- 浅色基线 ----------
  const light = await readVars(VARNAMES);
  const lightBody = await s.evaluate(`getComputedStyle(document.body).backgroundColor`);
  log('D0-1 浅色基线：html 无 .dark 类', (await isDarkClass()) === false, 'class=' + (await isDarkClass()));
  log('D0-2 浅色基线：--bg-page = rgb(248, 250, 252)', light['--bg-page'] === 'rgb(248, 250, 252)', light['--bg-page']);
  log('D0-3 浅色基线：body 背景非深色', lightBody !== 'rgb(11, 17, 32)', lightBody);

  // ---------- 点切换按钮 → 暗色 ----------
  const hasBtn = await s.evaluate(`(() => { const b = document.querySelector('.theme-toggle'); if (!b) return { exists:false }; return { exists:true, aria: b.getAttribute('aria-label'), tag: b.tagName }; })()`);
  log('D1-1 切换按钮存在（<button> 且带 aria-label）', hasBtn.exists && hasBtn.tag === 'BUTTON' && !!hasBtn.aria, JSON.stringify(hasBtn));

  await s.evaluate(`document.querySelector('.theme-toggle').click()`);
  await sleep(500); // 等 200ms 过渡落定

  const dark = await readVars(VARNAMES);
  const darkBody = await s.evaluate(`getComputedStyle(document.body).backgroundColor`);
  log('D1-2 切换后 html 带 .dark 类', (await isDarkClass()) === true, 'class=' + (await isDarkClass()));
  log('D1-3 切换后 localStorage.theme = "dark"', (await lsTheme()) === 'dark', 'theme=' + (await lsTheme()));
  log('D2-1 --bg-page 翻成深空蓝 rgb(11, 17, 32)', dark['--bg-page'] === 'rgb(11, 17, 32)', dark['--bg-page']);
  log('D2-2 --bg-card 翻成 rgb(30, 41, 59)', dark['--bg-card'] === 'rgb(30, 41, 59)', dark['--bg-card']);
  log('D2-3 --text-strong 翻成 rgb(226, 232, 240)', dark['--text-strong'] === 'rgb(226, 232, 240)', dark['--text-strong']);
  log('D2-4 --text-regular 翻成 rgb(203, 213, 225)', dark['--text-regular'] === 'rgb(203, 213, 225)', dark['--text-regular']);
  log('D2-5 EP --el-fill-color-blank 翻成 rgb(30, 41, 59)', dark['--el-fill-color-blank'] === 'rgb(30, 41, 59)', dark['--el-fill-color-blank']);
  log('D2-6 EP --el-text-color-primary 翻成 rgb(226, 232, 240)', dark['--el-text-color-primary'] === 'rgb(226, 232, 240)', dark['--el-text-color-primary']);
  log('D2-7 EP --el-bg-color-overlay（下拉/弹框浮层）翻成 rgb(30, 41, 59)', dark['--el-bg-color-overlay'] === 'rgb(30, 41, 59)', dark['--el-bg-color-overlay']);
  log('D2-8 骨架屏 --el-skeleton-color 翻成 rgb(30, 41, 59)', dark['--el-skeleton-color'] === 'rgb(30, 41, 59)', dark['--el-skeleton-color']);
  log('D2-9 body 背景跟随翻成 rgb(11, 17, 32)', darkBody === 'rgb(11, 17, 32)', darkBody);
  log('D2-10 --el-color-primary 保持靛蓝 rgb(79, 70, 229)（品牌渐变不变）', dark['--el-color-primary'] === 'rgb(79, 70, 229)', dark['--el-color-primary']);

  await s.screenshot(`${OUT}/dark-home.png`);

  // ---------- 关键不变量：EP 组件暗色下无白底白字 ----------
  await s.goto(CONFIG.frontend + '/login');
  await sleep(2000);
  const ep = await s.evaluate(`(() => {
    const wrap = document.querySelector('.el-input__wrapper');
    const inner = document.querySelector('.el-input__inner');
    const primary = document.querySelector('.el-button--primary');
    const cs = (el) => el ? getComputedStyle(el) : null;
    return {
      wrapBg: wrap ? cs(wrap).backgroundColor : null,
      innerColor: inner ? cs(inner).color : null,
      innerBg: inner ? cs(inner).backgroundColor : null,
      primaryBg: primary ? cs(primary).backgroundColor : null,
      primaryColor: primary ? cs(primary).color : null,
    };
  })()`);
  log('D3-1 输入框底非白(rgb(30,41,59))', ep.wrapBg === 'rgb(30, 41, 59)', ep.wrapBg);
  log('D3-2 输入框文字非白(rgb(203,213,225))', ep.innerColor === 'rgb(203, 213, 225)', ep.innerColor);
  log('D3-3 输入框内无独立白底（与 wrapper 一致）', ep.innerBg === 'rgba(0, 0, 0, 0)' || ep.innerBg === ep.wrapBg, ep.innerBg);
  log('D3-4 主按钮背景为靛蓝(rgb(79,70,229))、文字为白(rgb(255,255,255))，对比充足', ep.primaryBg === 'rgb(79, 70, 229)' && ep.primaryColor === 'rgb(255, 255, 255)', JSON.stringify(ep));
  await s.screenshot(`${OUT}/dark-login.png`);

  // ---------- 再点一次回到浅色，验证可来回 ----------
  await s.goto(CONFIG.frontend + '/');
  await sleep(1500);
  await s.evaluate(`document.querySelector('.theme-toggle').click()`);
  await sleep(500);
  const back = await readVars(['--bg-page']);
  log('D4-1 再次点击回到浅色（--bg-page 复原 rgb(248,250,252)）', back['--bg-page'] === 'rgb(248, 250, 252)', back['--bg-page']);
  log('D4-2 回到浅色后 localStorage.theme = "light"', (await lsTheme()) === 'light', 'theme=' + (await lsTheme()));

  console.log('\n===== 暗色模式量化探针汇总 =====');
  const passN = summary.filter((x) => x.ok).length;
  console.log(`通过 ${passN}/${summary.length}`);
  summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));
} finally {
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
}

// 退出码：0 全绿 / 1 有断言失败 / 2 一条断言都没跑到（前置失败或中途中断）。
// 这个文件原来**完全没有退出码** —— 有 FAIL 也返回 0，自动化拿它当门禁会漏判。
if (summary.length === 0) process.exit(2);
process.exit(summary.every((x) => x.ok) ? 0 : 1);
