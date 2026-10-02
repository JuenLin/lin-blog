// 第三批（F1 返回顶部 / F2 卡片键盘可达 / F7 标题随文章变 / D1 空态加按钮 / B2 刷新进度条）量化探针。
// 不靠肉眼看截图：把每件改动变成可度量的值。除 D1 / B2 进度条需要 Fetch 拦截造假响应外，
// 其余都走真实接口，不动数据库。
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep } from './lib/config.mjs';
import { mintToken } from './lib/session.mjs';

// 可选参数：截图输出目录（默认 D:/tools/acceptance-shots）
const OUT = process.argv[2] || 'D:/tools/acceptance-shots';

let chrome = null;
let s = null;
const paused = [];
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

const headers = (extra = []) => [
  { name: 'Content-Type', value: 'application/json; charset=utf-8' },
  { name: 'Access-Control-Allow-Origin', value: CONFIG.frontend },
  ...extra,
];

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

  const { token } = mintToken(CONFIG.adminId, 'admin');

  // ============================================================
  // F1：返回顶部按钮（真实接口即可，不需要拦截）
  // ============================================================
  await safe('F1', async () => {
    await s.goto(CONFIG.frontend + '/');
    await sleep(1500);
    await s.evaluate(`localStorage.setItem('token', ${JSON.stringify(token)})`);
    await s.goto(CONFIG.frontend + '/');
    await sleep(2500);

    const before = await s.evaluate(`(() => {
      const b = document.querySelector('.back-to-top');
      if (!b) return { exists: false };
      const cs = getComputedStyle(b);
      return { exists: true, tag: b.tagName, aria: b.getAttribute('aria-label'), vis: cs.visibility, op: cs.opacity };
    })()`);
    log('F1-1 按钮存在且是带 aria-label 的 BUTTON', before.exists && before.tag === 'BUTTON' && before.aria === '返回顶部', JSON.stringify(before));
    log('F1-2 顶部时隐藏(visibility=hidden,opacity=0)', before.exists && before.vis === 'hidden' && before.op === '0', JSON.stringify(before));

    // 库里往往只有 1 篇，页面不够高滚不动；强制撑高再测，不影响按钮本身逻辑。
    await s.evaluate(`document.body.style.minHeight = '3000px'`);
    await s.evaluate(`window.scrollTo(0, 900)`);
    await sleep(700);
    const shown = await s.evaluate(`(() => { const cs = getComputedStyle(document.querySelector('.back-to-top')); return { vis: cs.visibility, op: cs.opacity }; })()`);
    log('F1-3 滚动后出现(visibility=visible,opacity=1)', shown.vis === 'visible' && shown.op === '1', JSON.stringify(shown));

    await s.evaluate(`document.querySelector('.back-to-top').click()`);
    await sleep(1500);
    const top = await s.evaluate(`(() => ({ y: Math.round(window.scrollY), vis: getComputedStyle(document.querySelector('.back-to-top')).visibility }))()`);
    log('F1-4 点击后回到顶部(y≈0)且再次隐藏', top.y < 50 && top.vis === 'hidden', JSON.stringify(top));

    await s.evaluate(`document.body.style.minHeight = ''`);
  });

  // ============================================================
  // F2：卡片键盘可达（改成 router-link → 真 <a>）
  // ============================================================
  await safe('F2', async () => {
    await s.goto(CONFIG.frontend + '/');
    await sleep(3000);

    const r = await s.evaluate(`(() => {
      const a = document.querySelector('.article-card');
      if (!a) return { exists: false };
      const href = a.getAttribute('href') || '';
      a.focus();
      const focused = document.activeElement === a;
      const cs = getComputedStyle(a);
      return { exists: true, tag: a.tagName, href, focused, tab: a.tabIndex, hasOutline: cs.outlineWidth !== '0px' };
    })()`);
    log('F2-1 卡片是 <a> 且 href 指向 /article/:id', r.exists && r.tag === 'A' && /\/article\/\d+/.test(r.href), JSON.stringify(r));
    log('F2-2 卡片可键盘聚焦(document.activeElement 命中)', r.focused === true, JSON.stringify(r));
  });

  // ============================================================
  // F7：页面标题随文章变
  // ============================================================
  await safe('F7', async () => {
    const listJson = await (await fetch(`${CONFIG.api}/articles?page=1&pageSize=1`)).json();
    const art = listJson?.data?.list?.[0];
    if (!art) {
      log('F7 取不到可见文章，跳过', false, 'articles list empty');
      return;
    }
    await s.goto(`${CONFIG.frontend}/article/${art.id}`);
    await sleep(2800);
    const title = await s.evaluate(`document.title`);
    log('F7-1 详情页标题=文章名+站点名', title.includes(art.title) && title.includes('博客广场'), `"${title}"`);

    await s.goto(CONFIG.frontend + '/');
    await sleep(2200);
    const restored = await s.evaluate(`document.title`);
    log('F7-2 离开详情页标题复原为基准值(workbuddy)', restored === 'workbuddy', `"${restored}"`);
  });

  // ============================================================
  // D1 + B2 进度条：需要 Fetch 拦截造假响应
  // ============================================================
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*articles*' }] });
  const onPaused = (m) => {
    if (m.method !== 'Fetch.requestPaused') return;
    const p = m.params;
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

  const fulfill = (requestId, body) =>
    s.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: headers(),
      body: Buffer.from(body, 'utf8').toString('base64'),
    }).catch(() => {});

  const waitPaused = async () => {
    for (let i = 0; i < 50 && !paused[0]; i += 1) await sleep(100);
    return paused[0];
  };

  const EMPTY = JSON.stringify({ code: 0, message: 'ok', data: { list: [], page: 1, pageSize: 10, total: 0, totalPages: 0 } });
  const FAKE5 = JSON.stringify({
    code: 0,
    message: 'ok',
    data: {
      list: Array.from({ length: 5 }, (_, i) => ({
        id: 900 + i,
        title: `占位文章 ${i + 1}`,
        summary: '用来撑高卡片高度的占位摘要。',
        createdAt: new Date().toISOString(),
        author: { id: 2, username: 'admin', nickname: 'admin' },
      })),
      page: 1,
      pageSize: 10,
      total: 5,
      totalPages: 1,
    },
  });

  // ---------- D1：已登录空态 ----------
  await safe('D1-login', async () => {
    paused.length = 0;
    await s.goto(CONFIG.frontend + '/');
    const req = await waitPaused();
    if (req) await fulfill(req.requestId, EMPTY);
    await sleep(1500);
    const r = await s.evaluate(`(() => {
      const empty = !!document.querySelector('.el-empty');
      const btn = Array.from(document.querySelectorAll('.el-empty button')).find((b) => (b.innerText || '').includes('写第一篇'));
      return { empty, text: btn ? btn.innerText.trim() : null, tag: btn ? btn.tagName : null };
    })()`);
    log('D1-1 已登录空态出现「写第一篇」按钮', r.empty && r.text === '写第一篇', JSON.stringify(r));
    await s.screenshot(`${OUT}/93-empty-with-create.png`);
  });

  // ---------- D1：未登录空态（按钮应隐藏） ----------
  await safe('D1-anon', async () => {
    await s.evaluate(`localStorage.removeItem('token')`);
    paused.length = 0;
    await s.goto(CONFIG.frontend + '/');
    const req = await waitPaused();
    if (req) await fulfill(req.requestId, EMPTY);
    await sleep(1500);
    const r = await s.evaluate(`(() => {
      const empty = !!document.querySelector('.el-empty');
      const btn = Array.from(document.querySelectorAll('.el-empty button')).find((b) => (b.innerText || '').includes('写第一篇'));
      return { empty, hasBtn: !!btn };
    })()`);
    log('D1-2 未登录时「写第一篇」按钮隐藏', r.empty && !r.hasBtn, JSON.stringify(r));
    await s.evaluate(`localStorage.setItem('token', ${JSON.stringify(token)})`);
  });

  // ---------- B2 进度条：刷新中激活，列表变淡，进度条保持亮 ----------
  await safe('B2-bar', async () => {
    paused.length = 0;
    await s.goto(CONFIG.frontend + '/');
    const req = await waitPaused();
    if (req) await fulfill(req.requestId, FAKE5);
    await sleep(1500);

    paused.length = 0;
    await s.evaluate(`(() => { const t = Array.from(document.querySelectorAll('.el-tabs__item')).find((t) => t.innerText.includes('最近更新')); if (t) t.click(); return true; })()`);
    const req2 = await waitPaused();
    // 等 200ms 过渡动画落定再采样，否则会抓到 opacity 中间态（实测 0.775 / 0.612）。
    await sleep(450);
    const r = await s.evaluate(`(() => {
      const bar = document.querySelector('.home-refresh-bar');
      const list = document.querySelector('.home-list');
      if (!bar || !list) return { exists: false };
      return {
        exists: true,
        active: bar.classList.contains('is-active'),
        barOpacity: getComputedStyle(bar).opacity,
        barHeight: getComputedStyle(bar).height,
        listOpacity: getComputedStyle(list).opacity,
        listRefreshing: list.classList.contains('is-refreshing'),
      };
    })()`);
    log('B2-1 进度条存在、刷新中激活(opacity=1)、高 2px', r.exists && r.active && r.barOpacity === '1' && r.barHeight === '2px', JSON.stringify(r));
    log('B2-2 列表变淡(0.5)而进度条保持亮(1)', r.listOpacity === '0.5' && r.barOpacity === '1', JSON.stringify(r));
    await s.screenshot(`${OUT}/94-refreshing-bar.png`);

    if (req2) await fulfill(req2.requestId, FAKE5);
    await sleep(1200);
    const after = await s.evaluate(`(() => { const b = document.querySelector('.home-refresh-bar'); return { active: b.classList.contains('is-active'), op: getComputedStyle(b).opacity }; })()`);
    log('B2-3 刷新完成后进度条隐藏', !after.active && after.op === '0', JSON.stringify(after));
  });

  await s.send('Fetch.disable');
  s.offEvent(onPaused);

  console.log('\n===== 第三批量化探针汇总 =====');
  const passN = summary.filter((x) => x.ok).length;
  console.log(`通过 ${passN}/${summary.length}`);
  summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));
} finally {
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
}
