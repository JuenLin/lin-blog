// 读取关键元素的计算样式，确认第一批样式真的生效（而不是只看截图猜）。
//
// ⚠️ 2026-10-04 探针审计后的改造：这个文件原来**只 console.log 一段 JSON，
// 没有任何断言、也没有退出码** —— 属于「摆设」，样式坏了也不会 FAIL。
// 现在按用户拍板（方案 A）补最小断言集：浅色基线底 / 卡片圆角+阴影 / 品牌令牌自洽，
// 并给出三态退出码。**不追求覆盖全部令牌**，只挡住「整体塌掉」这类回归。
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep } from './lib/config.mjs';

const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

let chrome = null;
if (!(await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`).then((r) => r.ok).catch(() => false))) {
  chrome = await launchChrome();
  await sleep(1000);
}

const s = await attach();
await s.goto(CONFIG.frontend + '/');
await sleep(2500);

const probe = await s.evaluate(`(() => {
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const card = document.querySelector('.article-card');
  const title = document.querySelector('.home-title');
  const tab = document.querySelector('.el-tabs__item.is-active');
  const header = document.querySelector('.app-header');
  const cardStyle = cs(card);
  const tabStyle = cs(tab);
  return {
    bodyBg: getComputedStyle(document.body).backgroundColor,
    rootBg: getComputedStyle(document.documentElement).backgroundColor,
    card: cardStyle && {
      bg: cardStyle.backgroundColor,
      border: cardStyle.borderTopWidth + ' ' + cardStyle.borderTopColor,
      radius: cardStyle.borderTopLeftRadius,
      shadow: cardStyle.boxShadow.slice(0, 80),
      transition: cardStyle.transitionDuration,
    },
    titleColor: cs(title) && cs(title).color,
    activeTabColor: tabStyle && tabStyle.color,
    headerBorder: cs(header) && cs(header).borderBottomColor,
    // 头像圆底上的字：验证 --text-on-brand 这个令牌真的被组件吃到了
    avatarTextColor: cs(document.querySelector('.article-avatar')) && cs(document.querySelector('.article-avatar')).color,
    primaryVar: getComputedStyle(document.documentElement).getPropertyValue('--el-color-primary').trim(),
    brandVar: getComputedStyle(document.documentElement).getPropertyValue('--brand-start').trim(),
    brandRgbVar: getComputedStyle(document.documentElement).getPropertyValue('--brand-rgb').trim(),
    // 头像文字色用的令牌（S4 要拿它和实测 color 精确比对）
    textOnBrandVar: getComputedStyle(document.documentElement).getPropertyValue('--text-on-brand').trim(),
  };
})()`);
console.log(JSON.stringify(probe, null, 2));

/* ---------------- 最小断言集（方案 A） ---------------- */

// 浅色基线：body / html 都应该是浅色底（--bg-page = #f8fafc）。
// 原来这个文件只是「看一眼」，所以浅色底被改成深色也不会被发现。
log(
  'S1 浅色基线：body 与 html 底都是浅色 rgb(248, 250, 252)',
  probe.bodyBg === 'rgb(248, 250, 252)' && probe.rootBg === 'rgb(248, 250, 252)',
  `body=${probe.bodyBg} html=${probe.rootBg}`
);

// 卡片视觉三件套：白底 + 12px 圆角 + 有阴影。
// 断言里同时要求 card 存在（原来 card 取不到时只会打印 null）。
log(
  'S2 卡片：白底 + 12px 圆角 + 阴影非空',
  Boolean(probe.card) && probe.card.bg === 'rgb(255, 255, 255)' && probe.card.radius === '12px' && probe.card.shadow !== 'none',
  `bg=${probe.card && probe.card.bg} radius=${probe.card && probe.card.radius} shadow=${probe.card && probe.card.shadow ? '有' : '无'}`
);

// 品牌令牌必须存在且自洽：--el-color-primary 与 --brand-start 都要有值。
// 这两个是整套配色的入口，任一为空说明令牌体系整体没加载。
log(
  'S3 品牌令牌非空（--el-color-primary / --brand-start / --brand-rgb）',
  Boolean(probe.primaryVar) && Boolean(probe.brandVar) && Boolean(probe.brandRgbVar),
  `primary=${probe.primaryVar} brandStart=${probe.brandVar} brandRgb=${probe.brandRgbVar}`
);

// 头像圆底上的字必须来自 --text-on-brand。
// 原版注释声称「验证令牌真的被组件吃到」，但代码只读了 color、既没读令牌也没比对。
// 这里读令牌值（#ffffff）、转成 rgb、与实测 color **精确比对** ——
// 组件若把颜色硬编码成别的值（而不是走令牌），这条会 FAIL。
const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

log(
  'S4 头像文字色 == --text-on-brand（令牌真的被组件吃到）',
  Boolean(probe.avatarTextColor) && probe.avatarTextColor === hexToRgb(probe.textOnBrandVar),
  `avatarTextColor=${probe.avatarTextColor} --text-on-brand=${probe.textOnBrandVar} → ${hexToRgb(probe.textOnBrandVar)}`
);

s.close();
if (chrome) await stopChrome(chrome.child);

// 退出码：0 全绿 / 1 有断言失败 / 2 一条断言都没跑到（前置失败或中途中断）。
const passN = summary.filter((x) => x.ok).length;
console.log(`\n===== 第一批样式（计算样式最小断言）探针汇总 =====`);
console.log(`通过 ${passN}/${summary.length}`);
summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));

if (summary.length === 0) process.exit(2);
process.exit(passN === summary.length ? 0 : 1);
