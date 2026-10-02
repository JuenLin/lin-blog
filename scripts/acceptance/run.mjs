/**
 * 博客 MVP 前端验收主脚本：4 个页面 × 5 个区，一次性跑完并出结果表。
 *
 * 用法：
 *   node scripts/acceptance/run.mjs
 *   node scripts/acceptance/run.mjs --no-cleanup        # 保留临时数据方便排查
 *   node scripts/acceptance/run.mjs --report <path.md>  # 同时把结果表写成 markdown
 *   node scripts/acceptance/run.mjs --shots <dir>       # 指定截图目录
 *
 * 前置：后端 3000、前端 5173 **由你自己起**（脚本不碰它们）。
 * 生命周期：脚本自己拉起 headless Chrome，跑完自己关掉（契约 §13-17）。
 * 数据：会临时造占位文章，跑完自动清理还原；只删自己造的，不碰用户文章。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, ensureDirs, sleep, httpOk, PREFIX, TMP } from './lib/config.mjs';
import { attach, cdpAlive } from './lib/cdp.mjs';
import { launchChrome, stopChrome, findChrome } from './lib/chrome.mjs';
import { mintToken, whoami } from './lib/session.mjs';
import { ensureFixtures, cleanupFixtures, cleanupKnownArtifacts, recordUiCreated, listArticles, MARKERS } from './lib/fixtures.mjs';

const args = process.argv.slice(2);
const OPT = {
  cleanup: !args.includes('--no-cleanup'),
  noSeed: args.includes('--no-seed'),
  openChrome: !args.includes('--no-chrome'),
  report: (() => {
    const i = args.indexOf('--report');
    return i >= 0 ? args[i + 1] : null;
  })(),
  shots: (() => {
    const i = args.indexOf('--shots');
    return i >= 0 ? args[i + 1] : CONFIG.shots;
  })(),
};
CONFIG.shots = OPT.shots;
ensureDirs();

const results = [];
function check(id, name, status, evidence) {
  results.push({ id, name, status, evidence });
  console.log(`${status} | ${id} | ${name} | ${evidence}`);
}
const pass = (id, n, e) => check(id, n, 'PASS', e);
const fail = (id, n, e) => check(id, n, 'FAIL', e);
const skip = (id, n, e) => check(id, n, 'SKIP', e);

function die(msg, code = 2) {
  console.log('\n[前置检查未通过] ' + msg);
  process.exit(code);
}

// ---------------- 0. 前置检查 ----------------
if (typeof WebSocket === 'undefined') {
  die('本机 Node 版本过低（需要 ≥ 22 才内置全局 WebSocket）。请改用 node 22+：\n  "C:/Users/<你>/.workbuddy/binaries/node/versions/22.22.2-5/node.exe" scripts/acceptance/run.mjs');
}

const feStatus = await httpOk(CONFIG.frontend);
if (feStatus !== 200) {
  die(`前端 ${CONFIG.frontend} 探不到（HTTP ${feStatus}）。请确认：\n  1) 你已 npm run dev 且**端口必须是 5173**（backend/.env 的 CORS_ORIGIN 只配了这个源）\n  2) dev server 只监听 IPv6 [::1]，探测要用 localhost 而不是 127.0.0.1\n  3) 若用 curl 手工探测，本机默认走代理，必须加 --noproxy '*'`);
}

const apiStatus = await httpOk(`${CONFIG.api}/articles?page=1&pageSize=1&sortBy=createdAt&order=desc`);
if (apiStatus !== 200) {
  die(`后端 ${CONFIG.api} 探不到（HTTP ${apiStatus}）。请先起后端 3000。`);
}
console.log(`前置 OK：前端 ${CONFIG.frontend} = ${feStatus}，后端 ${CONFIG.api} = ${apiStatus}`);

// ---------------- 1. 登录态 ----------------
const adminToken = mintToken(CONFIG.adminId, `user${CONFIG.adminId}`).token;
const admin = await whoami(adminToken);
if (!admin) die(`userId=${CONFIG.adminId} 的 token 无效，可用 ACCEPTANCE_ADMIN_ID 环境变量换一个`);
console.log(`已构造登录态：admin(id=${admin.id}, username=${admin.username})  ← 借用 JWT_SECRET 签发，未使用密码`);

let demoToken = null;
let demo = null;
try {
  if (CONFIG.demoId !== CONFIG.adminId) {
    demoToken = mintToken(CONFIG.demoId, `user${CONFIG.demoId}`).token;
    demo = await whoami(demoToken);
  }
} catch {
  demo = null;
}
console.log(demo ? `已构造第二个用户：${demo.username}(id=${demo.id})，用于验「非作者不可编辑」` : '未能构造第二个用户，「非作者」一条会跳过');

// ---------------- 2. 数据夹具 ----------------
// 先自愈：上一次跑到一半被中断时可能留下临时数据，开跑前先按清单收干净。
const healed = await cleanupKnownArtifacts();
if (healed.cleaned) {
  console.log(`已自动回收上一次遗留的临时文章 ${healed.count} 篇（当前库 users=${healed.final.users} 文章(总/可见)=${healed.final.totalArticles}/${healed.final.visibleArticles} 评论=${healed.final.totalComments}）`);
}

let fx = null;
if (!OPT.noSeed) {
  fx = await ensureFixtures(adminToken, admin.id);
  console.log(`数据夹具已就绪：原有可见 ${fx.visibleTotalBefore} 篇 → 现在 ${fx.totalAfter} 篇（临时文章 id=${fx.all.join(',')}）`);
}
const PAGE_SIZE = CONFIG.pageSize;
const totalAfter = fx ? fx.totalAfter : (await listArticles(adminToken)).total;

// ---------------- 3. 起浏览器 ----------------
let chrome = null;
if (OPT.openChrome) {
  const alive = await cdpAlive();
  if (alive) {
    console.log(`复用已存在的 Chrome（端口 ${CONFIG.cdpPort}）`);
  } else {
    chrome = await launchChrome();
    if (!chrome.info) die(`Chrome 起不来（${chrome.exe}）。常见原因：忘记加 --no-sandbox，或 CHROME_PATH 指向了不可执行文件。`);
    console.log(`已拉起 headless Chrome：${chrome.exe}`);
  }
}

// ---------------- 4. CDP 会话 ----------------
let s = null;
let net = [];
try {
  s = await attach();
  await s.send('Network.enable');
  await s.send('Page.enable');
  await s.send('Runtime.enable');
} catch (e) {
  console.log('[CDP 会话建立失败] ' + (e && e.message ? e.message : String(e)) + '｜后续浏览器用例全部跳过，但会照常清理数据、关闭浏览器');
}

if (s) s.onEvent((m) => {
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (u.includes('/api/')) net.push({ method: m.params.request.method, url: u, id: m.params.requestId });
  }
  if (m.method === 'Network.responseReceived') {
    const hit = net.find((x) => x.id === m.params.requestId);
    if (hit) hit.status = m.params.response.status;
  }
});

const waitFor = async (expr, t = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    if (await s.evaluate(expr)) return true;
    await sleep(200);
  }
  return false;
};
const waitReq = async (pred, t = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < t) {
    if (net.some(pred)) return true;
    await sleep(200);
  }
  return false;
};
const clickText = (sel, text, exact = false) =>
  s.evaluate(
    `(() => { const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
      const t = (e) => (e.innerText || '').trim();
      const el = els.find(e => ${JSON.stringify(exact)} ? t(e) === ${JSON.stringify(text)} : t(e).includes(${JSON.stringify(text)}));
      if (!el) return false; el.click(); return true; })()`
  );
const titles = () =>
  s.evaluate(`Array.from(document.querySelectorAll('.article-card')).map(c => (c.innerText || '').trim().split(String.fromCharCode(10))[3] || '')`);
const firstTitle = async () => (await titles())[0] || '';
const bodyText = () => s.evaluate(`document.body.innerText`);
const curUrl = () => s.evaluate(`location.href`);
const setToken = (t) =>
  s.evaluate(t ? `localStorage.setItem('token', ${JSON.stringify(t)}); 1` : `localStorage.removeItem('token'); 1`);
const go = async (p) => {
  await s.goto(CONFIG.frontend + p);
  await sleep(1500);
};
const shot = (n) => s.screenshot(path.join(CONFIG.shots, n + '.png'));
const setValue = (sel, v) =>
  s.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
      el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
  );
const hasBtn = (t) =>
  s.evaluate(`Array.from(document.querySelectorAll('button')).some(b => (b.innerText || '').trim().includes(${JSON.stringify(t)}))`);

const uiCreatedIds = [];

// 注意：即使中途异常，也一定走到下面的收尾（关浏览器 + 清数据），避免留下脏数据和后台进程。
if (s) try {
  // ================= A 区：首页广场 =================
  await go('/');
  await setToken(null);
  await go('/');
  await waitFor(`document.querySelectorAll('.article-card').length > 0`, 10000);
  const homeCards = await s.evaluate(`document.querySelectorAll('.article-card').length`);
  const expectedFirstPage = Math.min(PAGE_SIZE, totalAfter);
  await shot('01-home-list');
  homeCards === expectedFirstPage
    ? pass('A1-1', `首页第 1 页渲染 ${expectedFirstPage} 张卡片`, `实测 ${homeCards} 张`)
    : fail('A1-1', `首页第 1 页渲染 ${expectedFirstPage} 张卡片`, `实测 ${homeCards} 张`);

  const firstReq = net.find((n) => n.url.includes('/api/articles?'));
  firstReq && firstReq.url.includes('sortBy=createdAt')
    ? pass('A1-2', '首屏请求带 sortBy=createdAt', firstReq.url.replace(CONFIG.api, '/api'))
    : fail('A1-2', '首屏请求带 sortBy=createdAt', '未捕获到 /api/articles 请求');

  const b1 = await bodyText();
  b1.includes(`共 ${totalAfter} 条`)
    ? pass('A1-3', '分页条显示总数', `共 ${totalAfter} 条`)
    : fail('A1-3', '分页条显示总数', `未找到「共 ${totalAfter} 条」`);

  // Tab
  if (fx) {
    net = [];
    await clickText('[role="tab"], .el-tabs__item', '最近更新');
    const ok1 = await waitReq((n) => n.url.includes('sortBy=updatedAt'), 8000);
    // B2 之后切 Tab 不再整块换成骨架屏，而是保留旧列表并打上 .is-refreshing，
    // 所以「卡片数 > 0」已经不能代表刷新完成（旧列表本来就在），必须等刷新标记消失。
    await waitFor(`!document.querySelector('.home-list.is-refreshing')`, 8000);
    await shot('02-tab-updated');
    ok1 ? pass('A2-1', '切「最近更新」发出 sortBy=updatedAt', '已捕获请求') : fail('A2-1', '切「最近更新」发出 sortBy=updatedAt', '8 秒内未捕获');
    const ft1 = await firstTitle();
    ft1.includes('（已更新）')
      ? pass('A2-2', '「最近更新」首条是被改过的那篇', ft1)
      : fail('A2-2', '「最近更新」首条是被改过的那篇', `首条=${ft1}`);

    net = [];
    await clickText('[role="tab"], .el-tabs__item', '最新', true);
    const ok2 = await waitReq((n) => n.url.includes('sortBy=createdAt'), 8000);
    await waitFor(`!document.querySelector('.home-list.is-refreshing')`, 8000);
    ok2 ? pass('A2-3', '切回「最新」发出 sortBy=createdAt', '已捕获请求') : fail('A2-3', '切回「最新」发出 sortBy=createdAt', '8 秒内未捕获');
    const ft2 = await firstTitle();
    const newestExpected = `${PREFIX} ${String(fx.batch.length).padStart(2, '0')}`;
    ft2 === newestExpected || !ft2.includes('（已更新）')
      ? pass('A2-4', '「最新」首条回到最新创建的那篇', ft2)
      : fail('A2-4', '「最新」首条回到最新创建的那篇', `首条=${ft2}`);
  } else {
    skip('A2-1', 'Tab 切换发出正确 sortBy', '--no-seed：数据不足');
    skip('A2-2', 'Tab 排序结果不同', '--no-seed：数据不足');
  }

  // 分页
  if (totalAfter > PAGE_SIZE) {
    net = [];
    await clickText('.el-pager li', '2', true);
    const okP = await waitReq((n) => n.url.includes('page=2'), 8000);
    await waitFor(`!document.querySelector('.home-list.is-refreshing')`, 8000);
    const rest = await s.evaluate(`document.querySelectorAll('.article-card').length`);
    await shot('03-page2');
    okP ? pass('A3-1', '点第 2 页发出 page=2', (net.find((n) => n.url.includes('page=2')) || {}).url || '') : fail('A3-1', '点第 2 页发出 page=2', '未捕获');
    rest === totalAfter - PAGE_SIZE
      ? pass('A3-2', `第 2 页渲染剩余 ${totalAfter - PAGE_SIZE} 条`, `实测 ${rest} 条`)
      : fail('A3-2', `第 2 页渲染剩余 ${totalAfter - PAGE_SIZE} 条`, `实测 ${rest} 条`);

    net = [];
    await clickText('.el-pagination__sizes .el-select__wrapper, .el-pagination__sizes input', '条/页');
    await sleep(800);
    const picked = await clickText('.el-select-dropdown__item, [role="option"]', '20条/页');
    if (picked) {
      const r20 = await waitReq((n) => n.url.includes('pageSize=20'), 6000);
      const req = net.find((n) => n.url.includes('pageSize=20'));
      await waitFor(`document.querySelectorAll('.article-card').length >= ${Math.min(20, totalAfter)}`, 6000);
      const c20 = await s.evaluate(`document.querySelectorAll('.article-card').length`);
      await shot('04-pagesize20');
      r20 ? pass('A3-3', '切每页 20 条发出 pageSize=20', req.url.replace(CONFIG.api, '/api')) : fail('A3-3', '切每页 20 条发出 pageSize=20', '未捕获');
      req && req.url.includes('page=1')
        ? pass('A3-4', '切每页条数后强制回第 1 页', '请求为 page=1')
        : fail('A3-4', '切每页条数后强制回第 1 页', req ? req.url : '无请求');
      c20 === Math.min(20, totalAfter)
        ? pass('A3-5', '每页 20 时全部数据在一页', `${c20} 条`)
        : fail('A3-5', '每页 20 时全部数据在一页', `${c20} 条`);
    } else {
      fail('A3-3', '切每页 20 条', '未能在下拉里点到选项');
    }
  } else {
    skip('A3-1', '分页翻页', `总条数 ${totalAfter} ≤ 每页 ${PAGE_SIZE}，无第 2 页`);
  }

  // 空态：用拦截返回空列表，不动真实数据
  {
    const emptyBody = JSON.stringify({ code: 0, message: 'ok', data: { list: [], page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0 } });
    await s.send('Fetch.enable', { patterns: [{ urlPattern: '*sortBy=createdAt*' }] });
    const handler = (m) => {
      if (m.method !== 'Fetch.requestPaused') return;
      s.send('Fetch.fulfillRequest', {
        requestId: m.params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Access-Control-Allow-Origin', value: CONFIG.frontend },
        ],
        body: Buffer.from(emptyBody, 'utf8').toString('base64'),
      }).catch(() => {});
    };
    s.onEvent(handler);
    await go('/');
    const okEmpty = await waitFor(`Boolean(document.querySelector('.el-empty'))`, 8000);
    const noCard = await s.evaluate(`document.querySelectorAll('.article-card').length === 0`);
    await shot('05-empty-state');
    okEmpty ? pass('A4-1', '列表为空时展示空状态', '页面出现 .el-empty') : fail('A4-1', '列表为空时展示空状态', '未出现 .el-empty');
    noCard ? pass('A4-2', '空态下不残留卡片', '卡片数=0') : fail('A4-2', '空态下不残留卡片', '仍有卡片');
    await s.send('Fetch.disable');
    s.offEvent(handler);
  }

  // ================= E 区 + C1：匿名态守卫 =================
  await setToken(null);
  await go('/editor');
  const g1 = await waitFor(`location.href.includes('/login')`, 8000);
  await shot('06-guard-editor');
  g1 ? pass('E1', '未登录访问 /editor 跳登录', await curUrl()) : fail('E1', '未登录访问 /editor 跳登录', await curUrl());

  await go('/editor/' + (fx ? fx.targetId : 1));
  const g2 = await waitFor(`location.href.includes('/login')`, 8000);
  g2 ? pass('E2', '未登录访问 /editor/:id 跳登录', await curUrl()) : fail('E2', '未登录访问 /editor/:id 跳登录', await curUrl());

  if (fx) {
    await setToken(null);
    await go('/article/' + fx.targetId);
    await waitFor(`document.body.innerText.includes('登录后才能发表评论')`, 8000);
    const b = await bodyText();
    const noTa = await s.evaluate(`!document.querySelector('textarea')`);
    await shot('07-comment-anon');
    b.includes('登录后才能发表评论') ? pass('C1-1', '未登录显示登录提示', '文案存在') : fail('C1-1', '未登录显示登录提示', '未找到文案');
    noTa ? pass('C1-2', '未登录不渲染评论输入框', '页面无 textarea') : fail('C1-2', '未登录不渲染评论输入框', '出现了 textarea');
    await clickText('button', '去登录');
    const toLogin = await waitFor(`location.href.includes('/login')`, 8000);
    toLogin ? pass('C1-3', '点「去登录」跳登录页', await curUrl()) : fail('C1-3', '点「去登录」跳登录页', await curUrl());
  }

  // ================= B 区：详情 =================
  await go('/');
  await setToken(adminToken);
  await go('/');
  await waitFor(`(document.querySelector('header')||{}).innerText && document.querySelector('header').innerText.includes(${JSON.stringify(admin.username)})`, 10000);
  const nav = await s.evaluate(`(document.querySelector('header')||{}).innerText||''`);
  const meReq = net.some((n) => n.url.includes('/auth/me'));
  await shot('08-home-admin');
  nav.includes(admin.username) ? pass('B0-1', '有 token 时头部渲染登录态', JSON.stringify(nav)) : fail('B0-1', '有 token 时头部渲染登录态', JSON.stringify(nav));
  meReq ? pass('B0-2', '带 token 加载后请求 /auth/me', '已捕获') : fail('B0-2', '带 token 加载后请求 /auth/me', '未捕获');

  if (fx) {
    const detailRaw = await (await fetch(`${CONFIG.api}/articles/${fx.targetId}`)).json();
    const detail = detailRaw.data;
    const paragraphs = String(detail.content || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const tail = paragraphs[paragraphs.length - 1] || '';

    await go('/article/' + fx.targetId);
    await waitFor(`document.body.innerText.includes(${JSON.stringify(fx.targetTitle.slice(0, 12))})`, 8000);
    const d = await bodyText();
    await shot('09-detail-admin');
    d.includes(fx.targetTitle) ? pass('B1-1', '详情页渲染标题', detail ? fx.targetTitle : '') : fail('B1-1', '详情页渲染标题', '标题未命中');
    tail && d.includes(tail) ? pass('B1-2', '详情页渲染正文段落', `末段「${tail.slice(0, 20)}…」命中`) : fail('B1-2', '详情页渲染正文段落', '正文末段未命中');
    d.includes('@' + (detail.author?.username || admin.username))
      ? pass('B1-3', '详情页渲染作者卡片', `@${detail.author?.username || admin.username}`)
      : fail('B1-3', '详情页渲染作者卡片', '未出现 @用户名');

    // 匿名 vs 作者：编辑/删除按钮
    await setToken(null);
    await go('/article/' + fx.targetId);
    await sleep(1500);
    const anonEdit = await hasBtn('编辑');
    const anonDel = await hasBtn('删除');
    await setToken(adminToken);
    await go('/article/' + fx.targetId);
    await sleep(1500);
    const adminEdit = await hasBtn('编辑');
    const adminDel = await hasBtn('删除');
    await shot('10-detail-admin-buttons');
    !anonEdit && !anonDel ? pass('B2-0', '未登录看不到编辑/删除', '两个按钮都不存在') : fail('B2-0', '未登录看不到编辑/删除', `编辑=${anonEdit} 删除=${anonDel}`);
    adminEdit && adminDel ? pass('B2-1', '作者可见编辑/删除按钮', '两个按钮都在') : fail('B2-1', '作者可见编辑/删除按钮', `编辑=${adminEdit} 删除=${adminDel}`);

    await clickText('button', '编辑');
    const navEdit = await waitFor(`location.href.includes('/editor/${fx.targetId}')`, 8000);
    await waitFor(`(document.querySelector('.editor .el-input__inner')||{}).value`, 8000);
    const pre = await s.evaluate(`(document.querySelector('.editor .el-input__inner')||{}).value||''`);
    await shot('11-editor-edit');
    navEdit ? pass('B3-1', `点编辑进入 /editor/${fx.targetId}`, await curUrl()) : fail('B3-1', '点编辑进入编辑页', await curUrl());
    pre === fx.targetTitle ? pass('B3-2', '编辑表单回填原标题', pre) : fail('B3-2', '编辑表单回填原标题', `回填=${pre}`);

    // ================= C 区：评论（登录后发表）=================
    await go('/article/' + fx.targetId);
    const taReady = await waitFor(`Boolean(document.querySelector('textarea'))`, 8000);
    if (taReady) {
      const before = Number(((await bodyText()).match(/共 (\d+) 条/) || [])[1] || 0);
      const comment = MARKERS.comment + ' ' + new Date().toISOString();
      net = [];
      await setValue('textarea', comment);
      await clickText('button', '发表评论');
      const posted = await waitReq((n) => n.method === 'POST' && n.url.includes('/comments'), 8000);
      const post = net.find((n) => n.method === 'POST' && n.url.includes('/comments'));
      await waitFor(`document.body.innerText.includes(${JSON.stringify(comment)})`, 8000);
      const afterC = await bodyText();
      await shot('12-comment-posted');
      posted ? pass('C2-1', '发表评论发出 POST /comments', `${post.url.replace(CONFIG.api, '/api')} → ${post.status || '无响应状态'}`) : fail('C2-1', '发表评论发出 POST /comments', '未捕获 POST');
      post && post.url.endsWith('/api/comments')
        ? pass('C2-2', '评论接口路径是顶层 /api/comments（符合 docs/API.md）', post.url)
        : fail('C2-2', '评论接口路径正确', post ? post.url : '无');
      afterC.includes(comment) ? pass('C2-3', '列表立刻出现新评论', '命中') : fail('C2-3', '列表立刻出现新评论', '未命中');
      const totalMatch = (afterC.match(/共 \d+ 条/g) || []).join(' / ');
      afterC.includes(`共 ${before + 1} 条`)
        ? pass('C2-4', `评论总数 ${before} → ${before + 1}`, totalMatch)
        : fail('C2-4', `评论总数 +1（发表前 ${before} 条）`, `页面上读到：${totalMatch || '无'}`);
      await s.evaluate(`document.querySelector('textarea').value === ''`)
        ? pass('C2-5', '发表后输入框清空', 'value 为空')
        : fail('C2-5', '发表后输入框清空', '仍有残留内容');
      await go('/article/' + fx.targetId);
      await waitFor(`document.body.innerText.includes(${JSON.stringify(comment)})`, 8000);
      pass('C3', '刷新后评论仍在（已落库）', '重新进入详情页仍渲染');
    } else {
      fail('C2-1', '登录后评论输入框可用', '未出现 textarea');
    }

    // ================= B4：删除流程（用脚本自己造的那篇）=================
    await go('/article/' + fx.deleteId);
    await waitFor(`Array.from(document.querySelectorAll('button')).some(b => (b.innerText||'').includes('删除'))`, 8000);
    await clickText('button', '删除');
    const dlg = await waitFor(`Boolean(document.querySelector('.el-message-box'))`, 8000);
    const dlgText = dlg ? (await s.evaluate(`(document.querySelector('.el-message-box')||{}).innerText||''`)).replace(/\n+/g, ' / ') : '';
    await shot('13-delete-confirm');
    dlg ? pass('B4-1', '点删除弹出二次确认框', dlgText) : fail('B4-1', '点删除弹出二次确认框', '未出现确认框');
    if (dlg) {
      await s.evaluate(`(() => { const b = document.querySelector('.el-message-box__btns .el-button--primary'); if (b) { b.click(); return true; } return false; })()`);
      const back = await waitFor(`location.href === ${JSON.stringify(CONFIG.frontend + '/')}`, 8000);
      const afterBucket = await waitFor(`document.body.innerText.includes('共 ${totalAfter - 1} 条')`, 8000);
      const afterText = await bodyText();
      await shot('14-after-delete');
      back ? pass('B4-2', '确认删除后返回首页', await curUrl()) : fail('B4-2', '确认删除后返回首页', await curUrl());
      afterBucket
        ? pass('B4-3', `删除后总数 ${totalAfter} → ${totalAfter - 1}`, '共 ' + (totalAfter - 1) + ' 条')
        : fail('B4-3', '删除后总数减 1', (afterText.match(/共 \d+ 条/) || ['读不到总数'])[0]);
    }
  }

  // ================= D 区：编辑器 =================
  await go('/editor');
  await waitFor(`Boolean(document.querySelector('.editor .el-input__inner'))`, 8000);
  net = [];
  await clickText('.editor button', '发表');
  const m1 = await waitFor(`document.body.innerText.includes('标题不能为空')`, 5000);
  await shot('15-validate-empty');
  m1 ? pass('D1-1', '空标题提示「标题不能为空」', 'toast 命中') : fail('D1-1', '空标题提示「标题不能为空」', '未出现');
  !net.some((n) => n.method === 'POST' && n.url.includes('/api/articles'))
    ? pass('D1-2', '校验不通过时不发创建请求', '未发出 POST /api/articles')
    : fail('D1-2', '校验不通过时不发创建请求', '竟然发了 POST');

  await setValue('.editor .el-input__inner', '随便一个标题');
  await clickText('.editor button', '发表');
  const m2 = await waitFor(`document.body.innerText.includes('正文不能为空')`, 5000);
  m2 ? pass('D1-3', '空正文提示「正文不能为空」', 'toast 命中') : fail('D1-3', '空正文提示「正文不能为空」', '未出现');

  await s.evaluate(`(() => { const el = document.querySelector('.editor .el-input__inner'); el.value = 'x'.repeat(101); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await clickText('.editor button', '发表');
  const m3 = await waitFor(`document.body.innerText.includes('标题最多 100 个字')`, 5000);
  m3 ? pass('D1-4', '标题超 100 字被拦下', 'toast「标题最多 100 个字」') : fail('D1-4', '标题超 100 字被拦下', '未触发（输入框自带 maxlength，手工输入到不了 100）');

  net = [];
  const newTitle = `${PREFIX} UI 新建产出`;
  await setValue('.editor .el-input__inner', newTitle);
  await setValue('.editor textarea', '第一段：由验收脚本点出来的正文。\n\n第二段：确认详情页能渲染换行。');
  await clickText('.editor button', '发表');
  const gotoDetail = await waitFor(`/\\/article\\/\\d+/.test(location.href)`, 10000);
  const newUrl = await curUrl();
  await waitFor(`document.body.innerText.includes(${JSON.stringify(newTitle)})`, 8000);
  await shot('16-created-detail');
  gotoDetail ? pass('D2-1', '新建成功跳详情页', newUrl) : fail('D2-1', '新建成功跳详情页', await curUrl());
  (await bodyText()).includes('第一段：由验收脚本点出来的正文。')
    ? pass('D2-2', '详情页展示新标题与正文', '均命中')
    : fail('D2-2', '详情页展示新标题与正文', '正文未命中');
  const newId = Number((newUrl.match(/\/article\/(\d+)/) || [])[1]);
  if (newId) {
    uiCreatedIds.push(newId);
    recordUiCreated(newId); // 落盘：万一脚本被杀，下次开跑能自动回收
  }

  if (fx) {
    await go('/editor/' + fx.editId);
    await waitFor(`(document.querySelector('.editor .el-input__inner')||{}).value === ${JSON.stringify(PREFIX + ' 编辑改名专用')}`, 8000);
    const preTitle = await s.evaluate(`(document.querySelector('.editor .el-input__inner')||{}).value||''`);
    const preBody = await s.evaluate(`(document.querySelector('.editor textarea')||{}).value||''`);
    preTitle === PREFIX + ' 编辑改名专用' ? pass('D3-1', '编辑页回填标题', preTitle) : fail('D3-1', '编辑页回填标题', preTitle);
    preBody.includes('改名后应该在详情页看到新标题') ? pass('D3-2', '编辑页回填正文', '命中') : fail('D3-2', '编辑页回填正文', preBody.slice(0, 30));

    const renamed = PREFIX + ' 编辑改名专用（已改名）';
    await setValue('.editor .el-input__inner', renamed);
    await clickText('.editor button', '保存');
    const backDetail = await waitFor(`location.href.endsWith('/article/${fx.editId}')`, 8000);
    await waitFor(`document.body.innerText.includes(${JSON.stringify(renamed)})`, 8000);
    await shot('17-edited-detail');
    backDetail ? pass('D3-3', '保存后跳回详情页', await curUrl()) : fail('D3-3', '保存后跳回详情页', await curUrl());
    (await bodyText()).includes(renamed) ? pass('D3-4', '详情页标题已更新', renamed) : fail('D3-4', '详情页标题已更新', '未命中');

    // 取消
    await go('/editor');
    await waitFor(`Boolean(document.querySelector('.editor .el-input__inner'))`, 8000);
    await clickText('.editor button', '取消');
    const c1 = await waitFor(`location.href === ${JSON.stringify(CONFIG.frontend + '/')}`, 8000);
    c1 ? pass('D4-1', '新建页「取消」回首页', await curUrl()) : fail('D4-1', '新建页「取消」回首页', await curUrl());
    await go('/editor/' + fx.editId);
    await waitFor(`Boolean(document.querySelector('.editor .el-input__inner'))`, 8000);
    await clickText('.editor button', '取消');
    const c2 = await waitFor(`location.href.endsWith('/article/${fx.editId}')`, 8000);
    c2 ? pass('D4-2', '编辑页「取消」回详情页', await curUrl()) : fail('D4-2', '编辑页「取消」回详情页', await curUrl());

    // 非作者
    if (demoToken && demo) {
      await setToken(demoToken);
      await go('/editor/' + fx.targetId);
      const forbidden = await waitFor(`document.body.innerText.includes('只有作者本人可以编辑这篇文章')`, 8000);
      await shot('18-forbidden');
      forbidden
        ? pass('D5', `非作者(${demo.username})打开编辑页显示无权限`, '提示「只有作者本人可以编辑这篇文章」')
        : fail('D5', '非作者打开编辑页显示无权限', '未出现无权限提示');
      await setToken(adminToken);
    } else {
      skip('D5', '非作者不可编辑', '未构造出第二个用户');
    }
  }
} catch (e) {
  console.log('\n[执行中断] ' + (e && e.message ? e.message : String(e)));
}

// ---------------- 收尾：截图 / 清理 / 关浏览器 ----------------
try {
  if (s) {
    await setToken(null);
    await go('/');
    await sleep(2000);
    console.log('回归：标题=' + (await s.evaluate(`document.title`)) + ' 卡片数=' + (await s.evaluate(`document.querySelectorAll('.article-card').length`)));
    await shot('19-final-home');
  }
} catch {
  /* noop */
}
if (s) s.close();

if (chrome) {
  await stopChrome(chrome.child);
  console.log('已关闭脚本自己拉起的 headless Chrome');
}

const idsToClean = fx ? [...fx.all, ...uiCreatedIds] : uiCreatedIds;
if (OPT.cleanup && idsToClean.length) {
  const r = await cleanupFixtures(idsToClean, [MARKERS.comment]);
  if (r.ok) {
    console.log(
      `已清理自己造的数据：文章 ${r.articles} 篇 / 评论 ${r.comments + r.marked} 条；当前库：users=${r.final.users} 文章(总/可见)=${r.final.totalArticles}/${r.final.visibleArticles} 评论=${r.final.totalComments}`
    );
    for (const f of ['fixtures.json', 'ui-created.json']) {
      try {
        fs.unlinkSync(path.join(TMP, f));
      } catch {
        /* noop */
      }
    }
  } else {
    console.log('清理未执行：' + r.reason + '｜待清 id=' + idsToClean.join(','));
  }
} else {
  console.log('未清理临时数据（--no-cleanup 或无待清 id）：' + idsToClean.join(','));
}

// ---------------- 报告 ----------------
const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;

console.log('\n========== 验收结果表 ==========');
console.log('| 结果 | 编号 | 用例 | 证据 |');
console.log('| --- | --- | --- | --- |');
for (const r of results) {
  console.log(`| ${r.status} | ${r.id} | ${r.name} | ${String(r.evidence).replace(/\|/g, '\\|')} |`);
}
console.log(`\n合计 ${results.length} 条：PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`);
console.log('截图目录：' + CONFIG.shots);

if (OPT.report) {
  const md = [
    '# 前端验收报告（自动生成）',
    '',
    `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
    `- 前端：${CONFIG.frontend}　后端：${CONFIG.api}`,
    `- 合计 ${results.length} 条：PASS ${passed} / FAIL ${failed} / SKIP ${skipped}`,
    `- 截图目录：\`${CONFIG.shots}\``,
    '',
    '| 结果 | 编号 | 用例 | 证据 |',
    '| --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.status} | ${r.id} | ${r.name} | ${String(r.evidence).replace(/\|/g, '\\|')} |`),
    '',
  ].join('\n');
  fs.writeFileSync(OPT.report, md, 'utf8');
  console.log('报告已写入：' + OPT.report);
}

process.exit(failed > 0 ? 1 : 0);
