// 第二批（B1 骨架屏贴形 / B2 保留旧列表 / H1 路由懒加载）的量化探针。
// 思路：不靠肉眼看截图，而是把三件事都变成可度量的值。
//   B1 —— 用 Fetch 把列表请求「按住」，在骨架屏还挂着的时候量它的盒模型，
//         再放开请求，量真实卡片的盒模型，两者逐项比对。
//   B2 —— 翻页时同样按住请求，量「旧列表是否还在 / 是否变淡 / 是否不可点」。
//   H1 —— 监听网络，看进入登录页 / 编辑器时是否真的按需拉了独立 chunk。
//
// ⚠️ 2026-10-04 探针审计后的改造（原版是个「摆设」）：
//   1. 原来**只有 console.log，没有任何判定** —— 跑完永远 exit 0，坏掉也不 FAIL。
//      现在接入与其它探针同构的 summary / log()，末尾给三态退出码。
//   2. 原来 B1 逐项比对写的是 `sk?.[k] === real?.[k]`：两边**同时缺失**时
//      `undefined === undefined` 为真，6 个属性全打印「一致」—— 坏掉反而更好看。
//      现在先判「两边都取到值」再比相等。
//   3. 原来 B2 的结论（「旧列表仍在，只是变淡」）是**写死进日志的字符串**，
//      伪造响应注入失败时也照样这么印。现在结论由实测值算出来，并作为断言。
//   4. 原来 H1 只证明「该路由出现过某个 chunk」—— eager import 同样会命中，
//      证明不了「按需」。现在改成**基线对照**：先记首页已加载的集合，
//      再断言目标 chunk 不在基线里。
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep } from './lib/config.mjs';
import { mintToken } from './lib/session.mjs';

// 可选参数：截图输出目录（默认 D:/tools/acceptance-shots）
const OUT = process.argv[2] || 'D:/tools/acceptance-shots';

// 与其它探针同构的结果收集器
const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

const box = `(() => {
  const pick = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      padding: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft,
      radius: cs.borderTopLeftRadius,
      border: cs.borderTopWidth + ' ' + cs.borderTopColor,
      // 比**完整** boxShadow：截断后再比相等，会在「差异只出现在截断点之后」时误判一致。
      // 影响展示的话在打印处单独截断，不要让它参与判定。
      shadow: cs.boxShadow,
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

  const show = (v) => (typeof v === 'string' && v.length > 56 ? v.slice(0, 56) + '…' : v);

  // 前置：两边都真的取到值。这一条是后面 6 条的必要条件 ——
  // 没有它，两边同时缺失时 `undefined === undefined` 会让 6 条全部「一致」。
  const bothPicked = Boolean(sk.skeletonCard) && Boolean(real.realCard);
  log(
    'B1-0 骨架卡片与真实卡片都已渲染（前置）',
    bothPicked && sk.skeletonCount > 0,
    `骨架卡=${Boolean(sk.skeletonCard)} 骨架数量=${sk.skeletonCount} 真实卡=${Boolean(real.realCard)}`
  );

  console.log('【B1】逐项比对（骨架 vs 真实卡片）:');
  // 只比**盒模型** 5 项，**刻意不含 height**（用户 2026-10-04 拍板，方案 A）：
  // 真实卡片比骨架卡多一行 .article-card-foot（作者 chip + 点赞按钮），
  // 结构上必然更高（实测 190 vs 152），要求等高不成立，还会随 summary 行数抖动。
  // 「骨架贴形」的设计意图就是**盒模型一致**，高度由内容决定。
  for (const k of ['padding', 'radius', 'border', 'shadow', 'bg']) {
    const a = sk.skeletonCard ? sk.skeletonCard[k] : null;
    const b = real.realCard ? real.realCard[k] : null;
    // 必须 a/b 都非 null 才算「一致」——这是本次修掉的核心假通过
    const same = a != null && b != null && a === b;
    log(`B1 ${k} 骨架与真实卡片一致`, same, `骨架=${show(a)} 真实=${show(b)}`);
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
  // 注入失败（请求没被按住）时 injected10 为字面量 false —— 后面的断言会点出来，
  // 而不是像原版那样印一句「伪造 10 条」就当注入成功了。
  const injected10 = paused[0] ? await fulfill(paused[0].requestId, fakeList(10)) : false;
  await sleep(1500);
  const before = await s.evaluate(refreshState);
  console.log('【B2】切换前: ' + JSON.stringify(before));
  log(
    'B2-1 伪造 10 条已生效（前置：注入成功且渲染 10 张卡）',
    before.hasWrapper && before.cards === 10,
    `注入=${injected10 === false ? '否（请求未被按住）' : '是'} 卡片=${before.cards} 期望=10`
  );

  paused.length = 0;
  await s.evaluate(`(() => {
    const tab = Array.from(document.querySelectorAll('.el-tabs__item')).find((t) => t.innerText.includes('热门'));
    if (tab) tab.click();
    return true;
  })()`);

  // 等切 Tab 触发的那个请求被按住
  for (let i = 0; i < 40 && !paused[0]; i += 1) await sleep(100);
  // 轮询 opacity 到稳定态（CSS 过渡 1→0.5 跑完），避免采到中间态（历史 0.61/0.68）。
  // pointer-events 是瞬变属性，仍即时判（不轮询）。连续两次 ≤0.52 视为已落稳。
  let during = await s.evaluate(refreshState);
  {
    let stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      during = await s.evaluate(refreshState);
      if (Number(during.opacity) <= 0.52) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      await sleep(80);
    }
  }
  console.log('【B2】刷新中（新请求被按住，opacity 已落稳）: ' + JSON.stringify(during));
  await s.screenshot(`${OUT}/91-home-refreshing.png`);

  // 结论必须由实测值算出来，不能写死进日志（原版就是在括号里硬写了「旧列表仍在，只是变淡」）
  const keptOld = during.hasWrapper && during.cards > 0;
  const dimmed = Number(during.opacity) < 1;
  const notClickable = during.pointerEvents === 'none';

  log('B2-2 刷新中旧列表保留（不是被清空）', keptOld, `刷新中卡片=${during.cards}（>0 为保留）`);
  log(
    'B2-3 刷新中旧列表变淡且不可点',
    dimmed && notClickable,
    `opacity=${during.opacity} pointer-events=${during.pointerEvents}`
  );
  console.log(
    `【B2】刷新中截图已存 91-home-refreshing.png（实测：旧列表${keptOld ? '保留' : '被清空'}、` +
      `${dimmed ? '已变淡' : '未变淡'}、${notClickable ? '不可点' : '仍可点'}）`
  );

  const injected3 = paused[0] ? await fulfill(paused[0].requestId, fakeList(3)) : false;
  await sleep(1500);
  const after = await s.evaluate(refreshState);
  console.log('【B2】刷新完成: ' + JSON.stringify(after));
  log(
    'B2-4 伪造 3 条已生效（刷新后渲染 3 张卡）',
    after.hasWrapper && after.cards === 3,
    `注入=${injected3 === false ? '否（请求未被按住）' : '是'} 卡片=${after.cards} 期望=3`
  );
  console.log(
    `【B2】结论：刷新期间旧列表${keptOld ? '保留' : '被清空'}（${during.cards} 条 → ${after.cards} 条），` +
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
  //
  // ⚠️ 正则加锚定并**去掉 Home 分支**：原来的 /Home/ 会误配 HomeList、HomePage 之类；
  // 而「首页自己的模块」本来就在首屏加载，拿它证明不了按需。
  const PAGE_RE = /(?:^|\/)(Login|ArticleDetail|ArticleEditor)[^/]*\.(vue|js|mjs)(\?|$)/;
  const chunkNames = (urls) => [...new Set(urls.filter((u) => PAGE_RE.test(u)).map((u) => u.split('/').pop().split('?')[0]))];

  // 基线：先加载首页，记下**首屏本来就加载了哪些模块**。
  // 只有「目标模块不在基线里、却在进入目标路由时出现」才算按需加载；
  // 原版只检查「进入该路由时出现过该模块」——eager import 同样满足，等于没验。
  //
  // ⚠️ 采集基线前先清掉可能残留的登录态：本段有两条断言依赖「未登录初态」
  // （/login 会加载 Login.vue、/editor 会被守卫 redirect 到 /login）。Chrome profile
  // 现在每次启动都是全新的（见 lib/chrome.mjs），但**本探针自己**在最后一条用例里
  // 写了 admin token —— 不清的话，同一 profile 下的任何重跑都会开局即登录态、这两条必挂。
  chunks.length = 0;
  await s.goto(CONFIG.frontend + '/');
  // removeItem 必须先有 origin 才能调，所以先 goto 一次拿到 origin，清完再重载让页面按未登录态重算。
  await s.evaluate(`try { localStorage.removeItem('token'); } catch (e) {}`);
  await s.goto(CONFIG.frontend + '/');
  await sleep(2500);
  const baselineChunks = new Set(chunkNames(chunks));
  log('H1-0 首页基线已采集（记录首屏已加载的页面模块）', true, `首屏页面模块=${[...baselineChunks].join(', ') || '（无）'}`);

  // 前两条：普通路由「只拉自己的模块、且不在首屏基线里」。
  //
  // 第三条 `/editor` 要**特殊处理**：未登录时路由守卫会 redirect 到 /login
  // —— router/index.js 的 beforeEach 对 `meta.requiresAuth && !isLogin` 直接
  // `return { name: 'login' }`，所以只会加载 `Login.vue`，**根本不会加载 `ArticleEditor.vue`**。
  // 因此这里期望的是「**只拉 Login、不拉 ArticleEditor**」：
  // 一条同时证明「守卫生效」+「编辑器 chunk 没在登录前被提前拉取」。
  // （已登录进入 /editor 才拉 ArticleEditor 的情形，由下面最后一条覆盖。）
  const routeCases = [
    { route: '/login', expect: 'Login' },
    { route: '/article/7', expect: 'ArticleDetail' },
  ];

  for (const c of routeCases) {
    chunks.length = 0;
    await s.goto(CONFIG.frontend + c.route);
    await sleep(2500);
    const hit = chunkNames(chunks);
    const inBaseline = [...baselineChunks].some((n) => n.startsWith(c.expect));
    const loadedNow = hit.some((n) => n.startsWith(c.expect));
    log(
      `H1 进入 ${c.route} 才拉 ${c.expect}（基线里没有）`,
      loadedNow && !inBaseline,
      `本次加载=${hit.join(', ') || '（无）'} 期望含=${c.expect} 基线里已有=${inBaseline}`
    );
  }

  chunks.length = 0;
  await s.goto(CONFIG.frontend + '/editor');
  await sleep(2500);
  const guardHit = chunkNames(chunks);
  const gotLogin = guardHit.some((n) => n.startsWith('Login'));
  const gotEditor = guardHit.some((n) => n.startsWith('ArticleEditor'));
  log(
    'H1 未登录进入 /editor 被守卫拦到 /login（只拉 Login，不拉 ArticleEditor）',
    gotLogin && !gotEditor,
    `本次加载=${guardHit.join(', ') || '（无）'} 含Login=${gotLogin} 含ArticleEditor=${gotEditor}`
  );

  // /editor 需要登录，上面那一轮其实被守卫 redirect 到 /login 了（懒加载下守卫照常生效）。
  // 这里补一个带登录态的机位，确认编辑器自己的 chunk 也是按需加载的。
  const { token } = mintToken(2, 'admin');
  await s.goto(CONFIG.frontend + '/');
  await sleep(1500);
  await s.evaluate(`localStorage.setItem('token', ${JSON.stringify(token)})`);
  chunks.length = 0;
  await s.goto(CONFIG.frontend + '/editor');
  await sleep(2500);
  const editorHit = chunkNames(chunks);
  log(
    'H1 已登录进入 /editor 才拉 ArticleEditor（基线里没有）',
    editorHit.some((n) => n.startsWith('ArticleEditor')) &&
      ![...baselineChunks].some((n) => n.startsWith('ArticleEditor')),
    `本次加载=${editorHit.join(', ') || '（无）'} 基线里已有=${[...baselineChunks].some((n) => n.startsWith('ArticleEditor'))}`
  );
  s.offEvent(onResp);
} finally {
  // 用完把 token 擦掉：不给下一次运行留状态（同一条理由 —— 探针之间必须互相独立）。
  // 页面可能已经不可用，所以整个操作用 try 兜住，失败不影响收尾。
  if (s) {
    try {
      await s.evaluate(`try { localStorage.removeItem('token'); } catch (e) {}`);
    } catch {
      /* noop */
    }
  }
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
}

// 退出码：0 全绿 / 1 有断言失败 / 2 一条断言都没跑到（前置失败或中途中断）。
// 这个文件原来**完全没有判定与退出码**（只有 console.log），跑完永远 exit 0；
// 本次改造后它和别的探针一样可以被自动化当门禁用。
const passN = summary.filter((x) => x.ok).length;
console.log(`\n===== 第二批（骨架屏 / 刷新态 / 按需加载）探针汇总 =====`);
console.log(`通过 ${passN}/${summary.length}`);
summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));

if (summary.length === 0) process.exit(2);
process.exit(passN === summary.length ? 0 : 1);
