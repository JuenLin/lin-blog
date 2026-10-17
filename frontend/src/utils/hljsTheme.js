// highlight.js 主题按暗色模式切换（第 5 批）。
//
// 两个主题都是包内自带 CSS：github.css（白底）与 github-dark.css（深底）。
// 项目暗色模式是 <html>.dark 类（style.css + AppHeader 的 toggle），
// 白底主题在暗色下会变成一块刺眼的亮斑，所以不能只 import 一个。
//
// 做法：import 两个 URL（?url 让 Vite 返回打包后的文件地址，而不是把样式
// 注入页面），用一个单例 <link data-hljs-theme> 挂到 head，切换时只换 href。
//
// 为什么不直接 import 两个 css：两个主题选择器相同（.hljs / .hljs-*），
// 都注入会互相覆盖，永远只有一个生效——而且后注入的赢，行为不可控。
import lightUrl from 'highlight.js/styles/github.css?url';
import darkUrl from 'highlight.js/styles/github-dark.css?url';

let linkEl = null;

/**
 * 按暗色标志应用主题。幂等：重复调用只换 href。
 * @param {boolean} dark 是否暗色模式
 */
export function applyHljsTheme(dark) {
  if (typeof document === 'undefined') {
    return;
  }

  if (!linkEl) {
    linkEl = document.createElement('link');
    linkEl.rel = 'stylesheet';
    linkEl.setAttribute('data-hljs-theme', '');
    document.head.appendChild(linkEl);
  }

  linkEl.href = dark ? darkUrl : lightUrl;
}

/**
 * 按 <html> 当前有无 .dark 类应用主题。
 * AppHeader 的 applyTheme 与文章详情页挂载时都会调，两边都调无害（幂等）。
 */
export function initHljsTheme() {
  applyHljsTheme(document.documentElement.classList.contains('dark'));
}
