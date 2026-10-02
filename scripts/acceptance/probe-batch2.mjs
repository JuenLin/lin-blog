// 第二批（B1 骨架屏贴形 / B2 保留旧列表 / H1 路由懒加载）的量化探针。
// 思路：不靠肉眼看截图，而是把三件事都变成可度量的值。
//   B1 —— 用 Fetch 把列表请求「按住」，在骨架屏还挂着的时候量它的盒模型，
//         再放开请求，量真实卡片的盒模型，两者逐项比对。
//   B2 —— 翻页时同样按住请求，量「旧列表是否还在 / 是否变淡 / 是否不可点」。
//   H1 —— 监听网络，看进入登录页 / 编辑器时是否真的按需拉了独立 chunk。
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep } from './lib/config.mjs';
import { mintToken } from './lib/session.mjs';

// 可选参数：截图输出目录（默认 D:/tools/acceptance-shots）
const OUT = process.argv[2] || 'D:/tools/acceptance-shots';

const box = `(() => {
  const pick = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      padding: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft,
      radius: cs.borderTopLeftRadius,
      border: cs.borderTopWidth + ' ' + cs.borderTopColor,
      shadow: cs.boxShadow.slice(0, 56),
      bg: cs.backgroundColor,
      height: Math.round(r.height),
    };
  };
  const skItem = document.querySelector('.sk-card .el-skeleton__item');
  return {
    skeletonCard: pick(document.querySelector('.sk-card')),
    skeletonCount: document.querySelectorAll('.sk-card').length,
    skeletonItemBg: skItem ? getComputedStyle(skItem).backgroundColor : null,
    skeletonItemAnim: skItem ? getComputedStyle(skItem).animationName : null,
    realCard: pick(document.querySelector('.article-card')),
  };
})()`;

const refreshState = `(() => {
  const wrap = document.querySelector('.home-list');
  if (!wrap) return { hasWrapper: false };
  const cs = getComputedStyle(wrap);
  return {
    hasWrapper: true,
    refreshing: wrap.classList.contains('is-refreshing'),
    cards: document.querySelectorAll('.article-card').length,
    opacity: cs.opacity,
    pointerEvents: cs.pointerEvents,
    transition: cs.transitionDuration,
  };
})()`;

let chrome = null;
let s = null;
const paused = [];
const chunks = [];

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

  // ---------- B1 + B2：按住列表请求，好在骨架 / 刷新态停留时量样式 ----------
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*articles*' }] });
  const onPaused = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const p = m.params;
    // 跨域预检要单独回 204 + CORS 头，否则真实请求会被浏览器挡掉（docs/ACCEPTANCE.md 记过这个坑）。
    if (p.request.method === 'OPTIONS') {
      s.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 204,
        responseHeaders: [
          { name: 'Access-Control-Allow-Origin', value: CONFIG.frontend },
          { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
          { name: 'Access-Control-Allow-Headers', value: 'Content-Type,Authorization' },
        ],
      }).catch(() => {});
      return;
    }
    paused.push(p);
  };
  s.onEvent(onPaused);

  await s.goto(CONFIG.frontend + '/');
  await sleep(2500);

  // 首次加载：请求已被按住，此时页面上应该是骨架屏
  const sk = await s.evaluate(box);
  console.log('【B1】骨架屏（首屏，请求被按住时）: ' + JSON.stringify(sk, null, 2));
  await s.screenshot(`${OUT}/90-home-skeleton.png`);
  console.log('【B1】骨架屏截图已存 90-home-skeleton.png');

  // 放开第一个请求，让真实数据进来
  if (paused[0]) await s.send('Fetch.continueRequest', { requestId: paused[0].requestId });
  await sleep(2500);
  const real = await s.evaluate(box);
  console.log('【B1】真实卡片: ' + JSON.stringify(real.realCard, null, 2));

  const cmp = (k) => `${sk.skeletonCard?.[k]}  vs  ${real.realCard?.[k]}`;
  console.log('【B1】逐项比对（骨架 vs 真实卡片）:');
  for (const k of ['padding', 'radius', 'border', 'shadow', 'bg', 'height']) {
    const same = sk.skeletonCard?.[k] === real.realCard?.[k];
    console.log(`  ${same ? '一致' : '不同'} | ${k.padEnd(7)} | ${cmp(k)}`);
  }

  // ---------- B2：用伪造响应造出「10 条 → 3 条」的切换 ----------
  // 直接用真实数据验不动：库里此刻往往只有 1 篇，刷新中「还剩 1 条」说明不了问题。
  // 所以用 Fetch.fulfillRequest 造假响应（不动真实数据，见 docs/ACCEPTANCE.md 的做法），
  // 看切 Tab 的那一刻旧列表是不是还在原地。
  const fakeList = (n) =>
    JSON.stringify({
      code: 0,
      message: 'ok',
      data: {
        list: Array.from({ length: n }, (_, i) => ({
          id: 900 + i,
          title: `占位文章 ${i + 1}`,
          summary: `这是第 ${i + 1} 条占位摘要，用来撑开卡片高度。`,
          createdAt: new Date().toISOString(),
          author: { id: 2, username: 'admin', nickname: 'admin' },
        })),
        page: 1,
        pageSize: 10,
        total: n,
        totalPages: 1,
      },
    });

  const fulfill = (requestId, body) =>
    s.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json; charset=utf-8' },
        { name: 'Access-Control-Allow-Origin', value: CONFIG.frontend },
      ],
      body: Buffer.from(body, 'utf8').toString('base64'),
    }).catch(() => {});

  // 先造一个「10 条」的初始状态（同样走伪造响应，不动真实数据）
  paused.length = 0;
  await s.goto(CONFIG.frontend + '/');
  for (let i = 0; i < 40 && !paused[0]; i += 1) await sleep(100);
  if (paused[0]) await fulfill(paused[0].requestId, fakeList(10));
  await sleep(1500);
  const before = await s.evaluate(refreshState);
  console.log('【B2】切换前（伪造 10 条）: ' + JSON.stringify(before));

  paused.length = 0;
  await s.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((t) => t.innerText.includes('最近更新'));
    if (tab) tab.click();
    return true;
  })()`);

  // 等切 Tab 触发的那个请求被按住
  for (let i = 0; i < 40 && !paused[0]; i += 1) await sleep(100);
  const during = await s.evaluate(refreshState);
  console.log('【B2】刷新中（新请求被按住，旧列表应仍在）: ' + JSON.stringify(during));
  await s.screenshot(`${OUT}/91-home-refreshing.png`);
  console.log('【B2】刷新中截图已存 91-home-refreshing.png（旧列表仍在，只是变淡）');

  if (paused[0]) await fulfill(paused[0].requestId, fakeList(3));
  await sleep(1500);
  const after = await s.evaluate(refreshState);
  console.log('【B2】刷新完成（换成 3 条）: ' + JSON.stringify(after));
  console.log(
    `【B2】结论：刷新期间旧列表${during.cards > 0 ? '保留' : '被清空'}（${during.cards} 条 → ${after.cards} 条），` +
      `刷新中 opacity=${during.opacity} / pointer-events=${during.pointerEvents}`
  );

  await s.send('Fetch.disable');
  s.offEvent(onPaused);

  // ---------- H1：进入各路由时是否按需拉 chunk ----------
  const onResp = (m) => {
    if (m.method === 'Network.responseReceived') chunks.push(m.params.response.url);
  };
  s.onEvent(onResp);

  // 注意口径：验收跑的是 dev server（Vite 不打包），动态 import 拉到的是 /src/views/Xxx.vue 源码模块；
  // 生产构建下才会是 dist/assets/Xxx-<hash>.js 这种 chunk。两种形态都要认。
  const PAGE_RE = /(Login|ArticleDetail|ArticleEditor|Home)[^/]*\.(vue|js|mjs)(\?|$)/;

  for (const p of ['/login', '/article/7', '/editor']) {
    chunks.length = 0;
    await s.goto(CONFIG.frontend + p);
    await sleep(2500);
    const hit = chunks.filter((u) => PAGE_RE.test(u));
    const names = [...new Set(hit.map((u) => u.split('/').pop().split('?')[0]))];
    console.log(`【H1】进入 ${p} → 按路由按需加载: ${names.length ? names.join(', ') : '（无）'}`);
    console.log(`       同时还有首屏就有的 Home: ${chunks.some((u) => /Home/.test(u)) ? '是' : '否'}`);
  }

  // /editor 需要登录，上面那一轮其实被守卫 redirect 到 /login 了（懒加载下守卫照常生效）。
  // 这里补一个带登录态的机位，确认编辑器自己的 chunk 也是按需加载的。
  const { token } = mintToken(2, 'admin');
  await s.goto(CONFIG.frontend + '/');
  await sleep(1500);
  await s.evaluate(`localStorage.setItem('token', ${JSON.stringify(token)})`);
  chunks.length = 0;
  await s.goto(CONFIG.frontend + '/editor');
  await sleep(2500);
  const editorHit = [...new Set(chunks.filter((u) => PAGE_RE.test(u)).map((u) => u.split('/').pop().split('?')[0]))];
  console.log(`【H1】已登录进入 /editor → 按需加载: ${editorHit.length ? editorHit.join(', ') : '（无）'}`);
  s.offEvent(onResp);
} finally {
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
}
