// 读取关键元素的计算样式，确认第一批样式真的生效（而不是只看截图猜）。
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
  };
})()`);
console.log(JSON.stringify(probe, null, 2));
s.close();
if (chrome) await stopChrome(chrome.child);
