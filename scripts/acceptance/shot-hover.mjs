// 拍一张「卡片 hover 中」的截图：把鼠标真实移到第一张卡片上再截图。
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep } from './lib/config.mjs';

let chrome = null;
if (!(await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`).then((r) => r.ok).catch(() => false))) {
  chrome = await launchChrome();
  await sleep(1000);
}

const s = await attach();
await s.goto(CONFIG.frontend + '/');
await sleep(2500);

const rect = await s.evaluate(`(() => {
  const r = document.querySelector('.article-card').getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);

await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
await sleep(600);

const style = await s.evaluate(`(() => {
  const cs = getComputedStyle(document.querySelector('.article-card'));
  return { transform: cs.transform, shadow: cs.boxShadow.slice(0, 60) };
})()`);
console.log('hover 时卡片样式: ' + JSON.stringify(style));

await s.screenshot('D:/tools/acceptance-shots/batch1-after/20-home-card-hover.png');
console.log('已保存 hover 截图');
s.close();
if (chrome) await stopChrome(chrome.child);
