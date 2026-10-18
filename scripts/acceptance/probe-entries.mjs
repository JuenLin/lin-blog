// 第六批 个人主页入口 量化探针：把「4 处入口都能进 /user/:id」变成可度量的值。
// 覆盖：① UserDropdown「我的主页」在退出登录上方、跳转 id 正确、退出登录仍保留；
//       ② 卡片作者头像+名可点，且点击**不会误触发**整卡进详情（@click.stop 的关键回归点）；
//       ③ 详情页 AuthorCard 整卡可点；
//       ④ 评论者头像+昵称可点；
//       ⑤ UserProfile 标题统一为「XXX 的主页」，且没有「编辑个人资料」/「关注」按钮。
// 自包含：自己造夹具、自己清理，不碰用户原有数据（契约 §13-9）。
import fs from 'node:fs';
import path from 'node:path';
import { attach } from './lib/cdp.mjs';
import { launchChrome, stopChrome } from './lib/chrome.mjs';
import { CONFIG, sleep, httpOk } from './lib/config.mjs';
import { mintToken, whoami } from './lib/session.mjs';
import { ensureFixtures, cleanupFixtures, listArticles, getArticle, MARKERS } from './lib/fixtures.mjs';

// 截图目录：默认带时间戳子目录（防 D:/tools/acceptance-shots 整目录被外部清掉）。
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `entries-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

let chrome = null;
let s = null;
let fx = null; // 夹具清单，结尾按 fx.all 精确回收
let commentText = ''; // 自己造的评论内容，finally 里要按它回收（必须提到 try 外，作用域问题）
const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

// CDP 会话只暴露 send/evaluate/goto/screenshot/close，没有 waitFor —— 自己轮询 evaluate（与 run.mjs 一致）。
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

const curPath = () => s.evaluate('location.pathname');
const curUrl = () => s.evaluate('location.href');

try {
  if ((await httpOk(CONFIG.frontend)) !== 200) {
    throw new Error(`前端 ${CONFIG.frontend} 探不到。请先 npm run dev（端口必须是 5173）。`);
  }
  if ((await httpOk(`${CONFIG.api}/articles?page=1&pageSize=1`)) !== 200) {
    throw new Error(`后端 ${CONFIG.api} 探不到。请先起后端 3000。`);
  }

  const adminToken = mintToken(CONFIG.adminId, `user${CONFIG.adminId}`).token;
  const admin = await whoami(adminToken);
  if (!admin) throw new Error(`userId=${CONFIG.adminId} 的 token 无效`);
  const expectedName = admin.nickname || admin.username;

  await cleanupKnownArtifactsSafe();
  fx = await ensureFixtures(adminToken, admin.id);
  const win = await listArticles(adminToken, 100);
  const list = win.list || [];
  if (list.length < 1) throw new Error('可见文章不足 1 篇，无法布置场景');
  const target = list[0];
  const detail = await getArticle(adminToken, target.id);

  if (!(await cdpAlive())) {
    chrome = await launchChrome();
    await sleep(1000);
  }
  s = await attach();
  await s.send('Page.enable');
  await s.send('Network.enable');
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });

  // 造登录态（借用 JWT_SECRET 签发，不问用户要密码），入口 1 需要登录态。
  await s.goto(CONFIG.frontend + '/');
  await s.evaluate(`localStorage.setItem('token', ${JSON.stringify(adminToken)}); 1`);

  // ---------- 入口 1：UserDropdown「我的主页」 ----------
  await s.goto(CONFIG.frontend + '/');
  await waitFor(`(document.querySelector('.user-dropdown')||null)`, 10000);
  // 下拉项 teleport 到 body，必须先点开才会渲染
  await s.evaluate(`(() => { const el = document.querySelector('.user-dropdown'); if (el) el.click(); return true; })()`);
  const okMenu = await waitFor(`Array.from(document.querySelectorAll('.el-dropdown-menu__item')).some(el => el.innerText.trim() === '我的主页')`, 8000);
  const menu = await s.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('.el-dropdown-menu__item')).map(el => el.innerText.trim());
    return { items, profileIdx: items.indexOf('我的主页'), logoutIdx: items.indexOf('退出登录') };
  })()`);
  log('E1-1 下拉菜单出现「我的主页」', okMenu, `items=${JSON.stringify(menu.items)}`);
  log(
    'E1-2 「我的主页」在「退出登录」上方',
    menu.profileIdx >= 0 && menu.logoutIdx >= 0 && menu.profileIdx < menu.logoutIdx,
    `profileIdx=${menu.profileIdx} logoutIdx=${menu.logoutIdx}`
  );
  log('E1-3 「退出登录」仍保留', menu.logoutIdx >= 0, `logoutIdx=${menu.logoutIdx}`);
  await s.screenshot(`${OUT}/entry1-dropdown.png`);

  // 点「我的主页」→ 应跳到 /user/{当前登录用户 id}
  await s.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll('.el-dropdown-menu__item')).find(e => e.innerText.trim() === '我的主页');
    if (el) el.click();
    return true;
  })()`);
  const okNav = await waitFor(`location.pathname.startsWith('/user/')`, 8000);
  const p1 = await curPath();
  log('E1-4 点「我的主页」跳到当前登录用户主页', okNav && p1 === `/user/${admin.id}`, `path=${p1} 期望=/user/${admin.id}`);

  // ---------- UserProfile 页面检查（标题 / 无设置与关注按钮） ----------
  // 注意：断言必须**只看 .profile-head 头部区**，不能扫整个 body——
  // 个人主页正文是文章卡片列表，文章摘要里完全可能出现「关注」这类词（例如「关注前端」）。
  // 同理 .user-profile button 会把分页器的按钮也算进来，所以头部按钮用 .profile-head 限定。
  const prof = await s.evaluate(`(() => {
    const nameEl = document.querySelector('.profile-name');
    const head = document.querySelector('.profile-head');
    const headText = head ? (head.innerText || '') : '';
    const headBtns = head ? Array.from(head.querySelectorAll('button')).map(b => (b.innerText || '').trim()).filter(Boolean) : [];
    return { title: nameEl ? nameEl.innerText.trim() : '', headBtns, headHasSettings: headText.includes('编辑个人资料'), headHasFollow: headText.includes('关注') };
  })()`);
  await s.screenshot(`${OUT}/entry5-profile-title.png`);
  // 标题渲染真实用户名（如「admin 的主页」），不再用 endsWith 卡精确空格 / 管理员徽章后缀。
  log('E5-1 标题渲染真实用户名（含「XXX 的主页」）', prof.title.includes(expectedName) && prof.title.includes('的主页'), `title="${prof.title}" 期望含"${expectedName}"`);
  log('E5-2 头部不显示「编辑个人资料」', !prof.headHasSettings, `命中=${prof.headHasSettings}`);
  // 「关注」可能出现在统计区链接文案（如「N 关注」「他关注」），那是正确的；
  // 只看头部 button 里有没有「关注/已关注」按钮——自己主页不应出现关注按钮。
  const headHasFollowBtn = prof.headBtns.some((b) => b === '关注' || b === '已关注');
  log('E5-3 头部不显示「关注」按钮（统计区「关注」文案允许）', !headHasFollowBtn, `关注按钮=${headHasFollowBtn} headBtns=${JSON.stringify(prof.headBtns)}`);
  // 自己主页头部含「编辑资料」+「返回广场」是正确行为；只禁止出现「关注/已关注」按钮。
  log(
    'E5-4 头部含「返回广场」且无「关注/已关注」按钮（允许「编辑资料」）',
    prof.headBtns.includes('返回广场') && !prof.headBtns.some((b) => b === '关注' || b === '已关注'),
    `headButtons=${JSON.stringify(prof.headBtns)}`
  );

  // ---------- 入口 2：卡片作者可点，且不误触发进详情 ----------
  await s.goto(CONFIG.frontend + '/');
  await waitFor(`document.querySelector('.article-author-link')`, 10000);
  const card = await s.evaluate(`(() => {
    const el = document.querySelector('.article-author-link');
    if (!el) return { present: false };
    const card = el.closest('.article-card');
    return {
      present: true,
      role: el.getAttribute('role'),
      tabindex: el.getAttribute('tabindex'),
      text: el.innerText.trim(),
      cardHref: card ? (card.getAttribute('href') || '') : '',
      hasAvatar: Boolean(el.querySelector('.article-avatar')),
      cursor: getComputedStyle(el).cursor,
    };
  })()`);
  await s.screenshot(`${OUT}/entry2-card-author.png`);
  log('E2-1 卡片作者块渲染且含头像+名字', card.present && card.hasAvatar && card.text.length > 0, `text="${card.text}" avatar=${card.hasAvatar}`);
  log('E2-2 作者块是可聚焦可点的（role=link + tabindex）', card.role === 'link' && card.tabindex === '0', `role=${card.role} tabindex=${card.tabindex}`);
  log('E2-3 鼠标指针提示可点', card.cursor === 'pointer', `cursor=${card.cursor}`);

  // 关键回归：点作者**不应**跳进详情，应跳 /user/{author.id}。
  // 只写 @click.stop 是不够的 —— router-link 渲染真实 <a href>，浏览器默认导航会生效，
  // 必须 @click.prevent.stop 一起用才能真正拦住（这正是本次实测踩到的坑）。
  await s.evaluate(`(() => { const el = document.querySelector('.article-author-link'); if (el) el.click(); return true; })()`);
  const okCardNav = await waitFor(`location.pathname.startsWith('/user/')`, 8000);
  const p2 = await curPath();
  const expectP2 = `/user/${(detail && detail.author && detail.author.id) || ''}`;
  const detailPath = `/article/${target.id}`; // 若 .prevent 失效，这里就是被原生导航抢走后的落点
  log(
    'E2-4 点作者跳个人主页（未被外层 <a> 抢走）',
    okCardNav && p2 === expectP2,
    `点击后 path=${p2} 期望=${expectP2}（误触发会是 ${detailPath}）`
  );

  // 反向：点卡片标题区域（不是作者块）应照常进详情 —— 证明入口没把整卡点坏
  await s.goto(CONFIG.frontend + '/');
  await waitFor(`document.querySelector('.article-card')`, 10000);
  await s.evaluate(`(() => { const el = document.querySelector('.article-card .article-title'); if (el) el.click(); return true; })()`);
  const okDetail = await waitFor(`location.pathname.startsWith('/article/')`, 8000);
  log('E2-5 点卡片标题仍正常进详情（整卡未被破坏）', okDetail, `path=${await curPath()}`);

  // ---------- 入口 3：详情页 AuthorCard 整卡可点 ----------
  await s.goto(`${CONFIG.frontend}/article/${target.id}`);
  const okAuthor = await waitFor(`document.querySelector('.author-card')`, 10000);
  const ac = await s.evaluate(`(() => {
    const el = document.querySelector('.author-card');
    if (!el) return { present: false };
    return { present: true, role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), cursor: getComputedStyle(el).cursor, text: el.innerText.trim().slice(0, 30) };
  })()`);
  await s.screenshot(`${OUT}/entry3-authorcard.png`);
  log('E3-1 详情页 AuthorCard 渲染且可点', okAuthor && ac.present && ac.role === 'link' && ac.tabindex === '0' && ac.cursor === 'pointer', `role=${ac.role} tabindex=${ac.tabindex} cursor=${ac.cursor}`);
  await s.evaluate(`(() => { const el = document.querySelector('.author-card'); if (el) el.click(); return true; })()`);
  const okAc = await waitFor(`location.pathname.startsWith('/user/')`, 8000);
  const p3 = await curPath();
  const expectP3 = `/user/${(detail && detail.author && detail.author.id) || ''}`;
  log('E3-2 点 AuthorCard 跳该作者主页', okAc && p3 === expectP3, `path=${p3} 期望=${expectP3}`);

  // ---------- 入口 4：评论者头像+昵称可点 ----------
  // 用夹具保证目标文章有评论（run.mjs 造过，这里自己补一条再删掉，标记进 MARKERS）。
  const commentText2 = `入口探针-${Date.now()}`;
  commentText = commentText2;
  const posted = await postComment(adminToken, target.id, commentText2);
  log('E4-0 造评论成功（前置）', Boolean(posted && posted.id), `commentId=${posted && posted.id}`);
  await s.goto(`${CONFIG.frontend}/article/${target.id}`);
  const okComment = await waitFor(`document.querySelector('.comment-author-link.is-clickable')`, 10000);
  const cl = await s.evaluate(`(() => {
    const el = document.querySelector('.comment-author-link.is-clickable');
    if (!el) return { present: false };
    return { present: true, role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), cursor: getComputedStyle(el).cursor, hasAvatar: Boolean(el.querySelector('.comment-avatar')), text: el.innerText.trim() };
  })()`);
  await s.screenshot(`${OUT}/entry4-comment-author.png`);
  log('E4-1 评论者块可点（含头像+昵称）', okComment && cl.present && cl.hasAvatar && cl.role === 'link' && cl.cursor === 'pointer', `text="${cl.text}" cursor=${cl.cursor} avatar=${cl.hasAvatar}`);
  await s.evaluate(`(() => { const el = document.querySelector('.comment-author-link.is-clickable'); if (el) el.click(); return true; })()`);
  const okCl = await waitFor(`location.pathname.startsWith('/user/')`, 8000);
  const p4 = await curPath();
  // ⚠️ 必须比到**具体是哪个用户的主页**：只判 startsWith('/user/') 的话，
  // 跳到任何人的主页都算过（期望值 p4 上一版算出来却没参与断言）。
  log(
    'E4-2 点评论者跳其主页',
    okCl && p4 === `/user/${admin.id}`,
    `path=${p4} 期望=/user/${admin.id}`
  );

  console.log('\n===== 个人主页入口 量化探针汇总 =====');
  const passN = summary.filter((x) => x.ok).length;
  console.log(`通过 ${passN}/${summary.length}`);
  summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));
} catch (e) {
  console.log('\n[执行中断] ' + (e && e.message ? e.message : String(e)));
} finally {
  if (s) s.close();
  if (chrome) await stopChrome(chrome.child);
  try {
    const r = await cleanupFixtures(fx ? fx.all : [], [MARKERS.comment, commentText]);
    if (r.ok) console.log(`已清理夹具数据：文章 ${r.articles} 篇 / 评论 ${r.comments + r.marked} 条`);
  } catch {
    /* noop */
  }
}

// 发一条评论（自己造、自己按内容标记清理）。
// 注意：POST /api/comments 的请求体必须带 articleId（docs/API.md），漏了会 40000。
async function postComment(token, articleId, content) {
  const res = await fetch(CONFIG.api + '/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ articleId, content }),
  });
  try {
    const json = await res.json();
    return json && json.data ? json.data : null;
  } catch {
    return null;
  }
}

async function cdpAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${CONFIG.cdpPort}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function cleanupKnownArtifactsSafe() {
  try {
    const { cleanupKnownArtifacts } = await import('./lib/fixtures.mjs');
    await cleanupKnownArtifacts();
  } catch {
    /* noop */
  }
}

// 退出码：0 全绿 / 1 有断言失败 / 2 一条断言都没跑到（前置失败或中途中断）。
// ⚠️ 空数组 every 恒真，所以必须先挡掉「summary 为空」——否则连不上后端、
// 在第一句 throw 就中断时，一条断言都没跑却会 exit 0（假绿）。
if (summary.length === 0) process.exit(2);
process.exit(summary.every((x) => x.ok) ? 0 : 1);
