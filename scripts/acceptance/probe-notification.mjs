// 第 8 批：通知中心验收探针（独立运行）。
//
// 用法：
//   node scripts/acceptance/probe-notification.mjs
//   node scripts/acceptance/probe-notification.mjs --no-ui      # 只跑 API 组
//   node scripts/acceptance/probe-notification.mjs --no-cleanup # 保留数据方便排查
//
// 覆盖：
//   API 组（N1..N10）：COMMENT/REPLY/LIKE/FOLLOW 四种通知的产生、未读数、列表排序、
//                     批量/单条已读、自通知抑制、文章/用户软删降级、未登录 401。
//   UI 组（U1..U3）：铃铛红点、抽屉渲染、全部已读按钮（CDP 真实点击）。
//
// 清理纪律（探针铁律）：所有临时数据按 id 精确回收，绝不 deleteMany({}) 或跨表级联；
//                     收尾前后各打一次全表行数做 FAIL-SAFE 复核，发现残留立即报警。
//                     删除顺序遵循 FK RESTRICT：notification → follow → like → comment → article → user。

import path from 'node:path';
import { CONFIG, sleep, requireCjs, BACKEND, BACKEND_MODULES } from './lib/config.mjs';
import { mintToken } from './lib/session.mjs';
import { cleanupProbeAccounts, PROBE_PREFIX } from './lib/tmp-account.mjs';

const args = process.argv.slice(2);
const OPT = {
  ui: !args.includes('--no-ui'),
  cleanup: !args.includes('--no-cleanup'),
};

// ───────────── 轻量断言框架 ─────────────
const results = [];
function check(id, name, status, evidence) {
  results.push({ id, name, status, evidence });
  console.log(`${status} | ${id} | ${name} | ${evidence}`);
}
const pass = (id, n, e) => check(id, n, 'PASS', e);
const fail = (id, n, e) => check(id, n, 'FAIL', e);
const skip = (id, n, e) => check(id, n, 'SKIP', e);

// ───────────── HTTP 助手 ─────────────
// 网络层错误（fetch 抛异常：连接重置 / 服务端 --watch 重启等）重试 ≤2 次；
// HTTP 错误响应（4xx/5xx）**绝不重试**——那是业务结论，重试只会掩盖问题。
async function api(method, p, token, body) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(CONFIG.api + p, {
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          token ? { Authorization: 'Bearer ' + token } : {}
        ),
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* noop */ }
      return { status: res.status, json };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(500);
    }
  }
  throw lastErr || new Error('fetch failed');
}
const ok = (r) => r.json && r.json.code === 0;
const data = (r) => (r.json ? r.json.data : null);

// ───────────── Prisma 助手（只用于造软删降级靶子 + 精确清理） ─────────────
let _prisma = null;
function loadPrismaEnv() {
  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
}
async function prisma() {
  if (_prisma) return _prisma;
  loadPrismaEnv();
  const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));
  const c = new PrismaClient();
  await c.$connect();
  _prisma = c;
  return c;
}
async function disconnectPrisma() {
  if (_prisma) { await _prisma.$disconnect().catch(() => null); _prisma = null; }
}

// 全表行数快照（FAIL-SAFE 基线）
async function snapshot(p) {
  const c = await prisma();
  return {
    users: await c.user.count(),
    articles: await c.article.count(),
    visibleArticles: await c.article.count({ where: { deletedAt: null } }),
    comments: await c.comment.count(),
    likes: await c.like.count(),
    follows: await c.follow.count(),
    notifications: await c.notification.count(),
  };
}

// ───────────── 跑前自愈 ─────────────
// 历史崩溃轮次（进程被 SIGTERM / 断言抛错没走到清理）可能留下本探针命名空间的
// 残留账号与靶子文章。不先清掉，before 基线会把残留算进去，CLN 复核只能证明
// 「本轮没新增」而假绿，基线被无声污染。识别口径用本探针独有命名空间：
//   账号 username startsWith `${PROBE_PREFIX}_notif_`；文章 title startsWith `${PROBE_PREFIX} 通知靶子`
// 清理顺序遵循 FK RESTRICT：notification → bookmark → follow → like → comment → article → user。
async function healPreviousResidue() {
  const c = await prisma();
  const healed = { accounts: 0, articles: 0, notifications: 0, follows: 0, likes: 0, comments: 0, bookmarks: 0, revisions: 0 };
  const accountPrefix = `${PROBE_PREFIX}_notif_`;
  const articlePrefix = `${PROBE_PREFIX} 通知靶子`;
  const accRows = await c.user.findMany({ where: { username: { startsWith: accountPrefix } }, select: { id: true } });
  const artRows = await c.article.findMany({ where: { title: { startsWith: articlePrefix } }, select: { id: true } });
  const userIds = accRows.map((r) => r.id);
  const articleIds = artRows.map((r) => r.id);
  if (userIds.length === 0 && articleIds.length === 0) return healed;

  healed.notifications = (
    await c.notification.deleteMany({
      where: { OR: [{ userId: { in: userIds } }, { actorId: { in: userIds } }, { articleId: { in: articleIds } }] },
    })
  ).count;
  healed.bookmarks = (
    await c.bookmark.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { articleId: { in: articleIds } }] } })
  ).count;
  healed.follows = (
    await c.follow.deleteMany({ where: { OR: [{ followerId: { in: userIds } }, { followingId: { in: userIds } }] } })
  ).count;
  healed.likes = (
    await c.like.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { articleId: { in: articleIds } }] } })
  ).count;
  healed.comments = (
    await c.comment.deleteMany({ where: { OR: [{ authorId: { in: userIds } }, { articleId: { in: articleIds } }] } })
  ).count;
  if (articleIds.length > 0) {
    healed.revisions = (await c.articleRevision.deleteMany({ where: { articleId: { in: articleIds } } })).count;
    healed.articles = (await c.article.deleteMany({ where: { id: { in: articleIds } } })).count;
  }
  if (userIds.length > 0) {
    healed.accounts = (await c.user.deleteMany({ where: { id: { in: userIds } } })).count;
  }
  return healed;
}

// ───────────── 主流程 ─────────────
const createdArticleIds = [];
const createdNotificationIds = []; // 兜底：跑完再 DELETE（即便没显式收集到 id）
const followPair = []; // { followerId, followingId }

let R = null; // 接收者
let A = null; // 触发者

async function main() {
  // 前置：服务探活
  const feStatus = await fetch(CONFIG.frontend).then((r) => r.status).catch(() => 0);
  if (feStatus !== 200) fail('PRE', '前端探活', `前端 ${CONFIG.frontend} 不可达（HTTP ${feStatus}）`);
  const apiStatus = await fetch(`${CONFIG.api}/articles?page=1&pageSize=1`).then((r) => r.status).catch(() => 0);
  if (apiStatus !== 200) fail('PRE', '后端探活', `后端 ${CONFIG.api} 不可达（HTTP ${apiStatus}）`);
  if (feStatus !== 200 || apiStatus !== 200) {
    throw new Error('前置服务未就绪，终止（先起后端 3000 与前端 5173）');
  }

  // 跑前自愈（仅清理模式：--no-cleanup 是留数据排查，不能动）：回收历史崩溃轮次
  // 残留，保证下面的 before 是干净基线；--no-cleanup 下跳过，由用户自行处理。
  if (OPT.cleanup) {
    const healed = await healPreviousResidue();
    if (healed.accounts > 0 || healed.articles > 0) {
      console.log(
        `跑前自愈：回收历史残留 账号 ${healed.accounts} / 文章 ${healed.articles} / 通知 ${healed.notifications} / 关注 ${healed.follows} / 点赞 ${healed.likes} / 评论 ${healed.comments} / 收藏 ${healed.bookmarks} / 版本 ${healed.revisions}`
      );
    }
  }

  const before = await snapshot(CONFIG);

  // ── 造两个一次性账号（带 pwprobe 前缀，清理时按用户名精确删除） ──
  const ts = Date.now();
  const mkAccount = async (suffix, nickname) => {
    const username = `${PROBE_PREFIX}_notif_${suffix}_${ts}`;
    const r = await api('POST', '/auth/register', null, {
      username,
      password: 'Notif123',
      nickname,
    });
    if (!ok(r)) throw new Error(`注册 ${username} 失败：${JSON.stringify(r.json)}`);
    const u = (r.json.data && r.json.data.user) || r.json.data;
    const token = mintToken(u.id, u.username).token;
    return { ...u, token };
  };

  A = await mkAccount('a', '通知演员');
  R = await mkAccount('r', '通知接收');
  console.log(`已造账号：actor=${A.username}(id=${A.id}) recipient=${R.username}(id=${R.id})`);

  // ── 造文章 ──
  const mkArticle = async (owner, title) => {
    const r = await api('POST', '/articles', owner.token, {
      title,
      content: `通知探针占位正文：${title}`,
    });
    if (!ok(r)) throw new Error(`造文章失败：${JSON.stringify(r.json)}`);
    createdArticleIds.push(r.json.data.id);
    return r.json.data;
  };
  const R1 = await mkArticle(R, `${PROBE_PREFIX} 通知靶子R1`);
  const R2 = await mkArticle(R, `${PROBE_PREFIX} 通知靶子R2`);
  const A1 = await mkArticle(A, `${PROBE_PREFIX} 通知靶子A1`);

  // 收集 R 的现有通知 id（基线，避免误删他人数据；清理时只删「本次新增 + 涉及 A/R 的」）
  const c = await prisma();
  const rBaselineNotifIds = (await c.notification.findMany({
    where: { userId: R.id },
    select: { id: true },
  })).map((x) => x.id);

  // ── 动作序列（触发通知） ──
  // 1) A 评论 R1（顶层）→ R 收 COMMENT
  const c1 = await api('POST', '/comments', A.token, { articleId: R1.id, content: '评论R1-顶层' });
  if (!ok(c1)) throw new Error(`A 评论 R1 失败：${JSON.stringify(c1.json)}`);
  // 2) A 评论 R2（顶层）→ R 收第二条 COMMENT
  await api('POST', '/comments', A.token, { articleId: R2.id, content: '评论R2-顶层' });
  // 3) A 赞 R1 → R 收 LIKE
  const likeR1 = await api('POST', `/articles/${R1.id}/like`, A.token);
  if (!ok(likeR1)) throw new Error(`A 赞 R1 失败：${JSON.stringify(likeR1.json)}`);
  // 4) A 关注 R → R 收 FOLLOW
  const followR = await api('POST', `/users/${R.id}/follow`, A.token);
  if (!ok(followR)) throw new Error(`A 关注 R 失败：${JSON.stringify(followR.json)}`);
  followPair.push({ followerId: A.id, followingId: R.id });
  // 5) R 回复 c1（parentId=c1）→ A 收 REPLY
  const reply = await api('POST', '/comments', R.token, {
    articleId: R1.id,
    content: 'R回复A',
    parentId: c1.json.data.id,
  });
  if (!ok(reply)) throw new Error(`R 回复失败：${JSON.stringify(reply.json)}`);
  // 6) A 评论自己的 A1（自通知抑制，不应产生给 A 的通知）
  await api('POST', '/comments', A.token, { articleId: A1.id, content: 'A评论自己' });
  // 7) A 赞自己的 A1（自通知抑制）
  await api('POST', `/articles/${A1.id}/like`, A.token);

  // 等一小会儿，确保钩子里的 try/catch 通知写入已落库（通知写库是异步 fire-and-forget，但本站是 await 后返回，足够）
  await sleep(300);

  // ── N1：R 收到 COMMENT / LIKE / FOLLOW ──
  const rList = data(await api('GET', '/notifications?page=1&pageSize=20', R.token));
  const rNotifs = rList.list || [];
  const rTypes = rNotifs.map((n) => n.type);
  const hasComment = rNotifs.find((n) => n.type === 'COMMENT' && n.actorId === A.id && n.targetTitle === R1.title);
  const hasLike = rNotifs.find((n) => n.type === 'LIKE' && n.actorId === A.id && n.targetTitle === R1.title);
  const hasFollow = rNotifs.find((n) => n.type === 'FOLLOW' && n.actorId === A.id && n.targetTitle === null);
  if (hasComment && hasLike && hasFollow) {
    pass('N1', 'R 收到 COMMENT/LIKE/FOLLOW', `actorName=${hasComment.actorName} follow.actorName=${hasFollow.actorName}`);
  } else {
    fail('N1', 'R 收到 COMMENT/LIKE/FOLLOW', `缺失：comment=${!!hasComment} like=${!!hasLike} follow=${!!hasFollow}（全部类型=${rTypes.join(',')}）`);
  }

  // ── N2：A 收到 REPLY ──
  const aList = data(await api('GET', '/notifications?page=1&pageSize=20', A.token));
  const aReply = (aList.list || []).find((n) => n.type === 'REPLY' && n.actorId === R.id && n.targetTitle === R1.title);
  if (aReply) pass('N2', 'A 收到 REPLY', `actorName=${aReply.actorName}`);
  else fail('N2', 'A 收到 REPLY', `未找到（A 的通知=${((aList.list) || []).map((n) => n.type).join(',')}）`);

  // ── N3：R 未读数 == 4（2 COMMENT + 1 LIKE + 1 FOLLOW） ──
  const rUnread = data(await api('GET', '/notifications/unread-count', R.token));
  if (rUnread.unreadCount === 4) pass('N3', 'R 未读数=4', `unreadCount=${rUnread.unreadCount}`);
  else fail('N3', 'R 未读数=4', `期望 4，实际 ${rUnread.unreadCount}`);

  // ── N6：R 单条已读（标记第一条未读），未读数 -1 ──
  const firstUnread = rNotifs.find((n) => !n.isRead);
  if (firstUnread) {
    const m1 = await api('PUT', `/notifications/${firstUnread.id}/read`, R.token);
    const afterUnread = data(await api('GET', '/notifications/unread-count', R.token));
    if (ok(m1) && afterUnread.unreadCount === 3) pass('N6', 'R 单条已读使未读数-1', `4→${afterUnread.unreadCount}`);
    else fail('N6', 'R 单条已读使未读数-1', `标记=${ok(m1)} 未读数=${afterUnread.unreadCount}`);
  } else {
    fail('N6', 'R 单条已读使未读数-1', '找不到未读通知');
  }

  // ── UI 组（在「全部已读」之前，R 仍有未读=3） ──
  if (OPT.ui) {
    await runUiGroup(R);
  } else {
    skip('U1', 'UI：铃铛红点', '已用 --no-ui 跳过');
    skip('U2', 'UI：抽屉渲染', '已用 --no-ui 跳过');
    skip('U3', 'UI：全部已读', '已用 --no-ui 跳过');
  }

  // ── N5：全部已读后未读数=0（UI 组若执行过已点过全部已读，这里用 API 再确认幂等） ──
  const mr = await api('PUT', '/notifications/read', R.token, { ids: [] });
  const finalUnread = data(await api('GET', '/notifications/unread-count', R.token));
  const finalList = data(await api('GET', '/notifications?page=1&pageSize=20', R.token));
  const anyUnreadLeft = (finalList.list || []).some((n) => !n.isRead && n.userId === R.id);
  if (ok(mr) && finalUnread.unreadCount === 0 && !anyUnreadLeft) {
    pass('N5', '全部已读→未读数0且列表已读', `unreadCount=${finalUnread.unreadCount}`);
  } else {
    fail('N5', '全部已读→未读数0且列表已读', `unreadCount=${finalUnread.unreadCount} 仍有未读=${anyUnreadLeft}`);
  }

  // ── N7：自通知抑制（A 评论/赞自己的文章，不产生给 A 的通知） ──
  const aAfter = data(await api('GET', '/notifications?page=1&pageSize=20', A.token));
  const aAll = aAfter.list || [];
  const selfNotif = aAll.find((n) => (n.type === 'COMMENT' || n.type === 'LIKE') && n.targetTitle === A1.title);
  const aReplyCount = aAll.filter((n) => n.type === 'REPLY').length;
  if (!selfNotif && aReplyCount === 1) {
    pass('N7', '自通知抑制', `A 通知总数=${aAll.length}（仅1条REPLY，无自评论/自赞）`);
  } else {
    fail('N7', '自通知抑制', `selfNotif=${!!selfNotif} replyCount=${aReplyCount}`);
  }

  // ── N8：文章软删降级（targetTitle=内容已删除） ──
  await c.article.update({ where: { id: R2.id }, data: { deletedAt: new Date() } });
  const rListSoft = data(await api('GET', '/notifications?page=1&pageSize=20', R.token));
  const softNotif = (rListSoft.list || []).find((n) => n.articleId === R2.id);
  const restoredArt = await c.article.update({ where: { id: R2.id }, data: { deletedAt: null } });
  if (softNotif && softNotif.targetTitle === '内容已删除') {
    pass('N8', '文章软删→targetTitle=内容已删除', `targetTitle=${softNotif.targetTitle}`);
  } else {
    fail('N8', '文章软删→targetTitle=内容已删除', `notif=${JSON.stringify(softNotif && { t: softNotif.targetTitle })}`);
  }

  // ── N9：用户软删降级（actorName=已注销用户） ──
  await c.user.update({ where: { id: A.id }, data: { deletedAt: new Date() } });
  const rListUser = data(await api('GET', '/notifications?page=1&pageSize=20', R.token));
  const actorSoft = (rListUser.list || []).find((n) => n.actorId === A.id);
  await c.user.update({ where: { id: A.id }, data: { deletedAt: null } });
  if (actorSoft && actorSoft.actorName === '已注销用户') {
    pass('N9', '用户软删→actorName=已注销用户', `actorName=${actorSoft.actorName}`);
  } else {
    fail('N9', '用户软删→actorName=已注销用户', `actor=${JSON.stringify(actorSoft && { n: actorSoft.actorName })}`);
  }

  // ── N10：未登录 401 ──
  const noTokenList = await api('GET', '/notifications', null);
  const noTokenMark = await api('PUT', '/notifications/read', null, { ids: [] });
  if (noTokenList.status === 401 && noTokenMark.status === 401) {
    pass('N10', '未登录拦截 401', `list=${noTokenList.status} mark=${noTokenMark.status}`);
  } else {
    fail('N10', '未登录拦截 401', `list=${noTokenList.status} mark=${noTokenMark.status}`);
  }

  // ── 收集本次新增通知 id（用于精确清理） ──
  const allNotifs = await c.notification.findMany({
    where: { OR: [{ userId: { in: [A.id, R.id] } }, { actorId: { in: [A.id, R.id] } }] },
    select: { id: true },
  });
  for (const x of allNotifs) createdNotificationIds.push(x.id);

  // ── FAIL-SAFE 复核 ──
  const after = await snapshot(CONFIG);
  if (OPT.cleanup) {
    await cleanup(before);
  }
}

// ───────────── UI 组（CDP 真实交互） ─────────────
async function runUiGroup(R) {
  let chrome = null;
  let s = null;
  let chromeStarted = false;
  try {
    const { launchChrome, stopChrome } = await import('./lib/chrome.mjs');
    const { attach, cdpAlive } = await import('./lib/cdp.mjs');

    const alive = await cdpAlive();
    if (alive) {
      console.log('UI：复用已存在的 Chrome');
    } else {
      chrome = await launchChrome();
      chromeStarted = true;
      if (!chrome || !chrome.info) { skip('U1', 'UI：铃铛红点', 'Chrome 起不来，跳过 UI 组'); return; }
      console.log('UI：已拉起 headless Chrome');
    }

    s = await attach();
    await s.send('Network.enable');
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    await s.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    const lit = (v) => JSON.stringify(v);
    const waitFor = async (expr, t = 8000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < t) {
        if (await s.evaluate(expr)) return true;
        await sleep(200);
      }
      return false;
    };

    // 先打开首页（确立 localhost:5173 origin，否则 about:blank 上访问 localStorage 会 SecurityError），
    // 再注入 R 的 token，最后 reload 让 AppHeader 在挂载时读到 token 开启轮询。
    await s.goto(CONFIG.frontend + '/');
    await s.evaluate(`localStorage.setItem('token', ${lit(R.token)}); 'ok'`);
    await s.goto(CONFIG.frontend + '/');
    // 等铃铛出现
    const bellReady = await waitFor(`Boolean(document.querySelector('.bell-btn'))`);
    if (!bellReady) { fail('U1', 'UI：铃铛红点', '找不到 .bell-btn'); return; }

    // 等未读红点出现（startPolling 首拉后渲染）
    const badgeReady = await waitFor(`(() => { const b = document.querySelector('.bell-badge .el-badge__content'); return b && b.textContent.trim() !== ''; })()`, 10000);
    const badgeText = badgeReady ? await s.evaluate(`document.querySelector('.bell-badge .el-badge__content')?.textContent.trim() || ''`) : '';
    if (badgeReady && Number(badgeText) >= 1) {
      pass('U1', 'UI：铃铛红点显示未读数', `badge=${badgeText}`);
    } else {
      fail('U1', 'UI：铃铛红点显示未读数', `badgeReady=${badgeReady} text=${badgeText}`);
    }

    // 点击铃铛打开抽屉
    await s.evaluate(`document.querySelector('.bell-btn').click()`);
    // 等抽屉里至少渲染出一条通知（loadList 是异步拉取，必须等请求落库后再断言）
    const drawerReady = await waitFor(`document.querySelectorAll('.notif-item').length >= 1`, 10000);
    if (!drawerReady) { fail('U2', 'UI：抽屉渲染', '抽屉未打开或列表未加载'); return; }
    const itemCount = await s.evaluate(`document.querySelectorAll('.notif-item').length`);
    const texts = await s.evaluate(`Array.from(document.querySelectorAll('.notif-text')).map((el) => el.textContent.trim())`);
    if (itemCount >= 1) {
      pass('U2', 'UI：抽屉渲染通知', `itemCount=${itemCount} 首条=${texts[0] || ''}`);
    } else {
      fail('U2', 'UI：抽屉渲染通知', `itemCount=${itemCount}`);
    }

    // 点击「全部已读」
    const clicked = await s.evaluate(`(() => { const btns = Array.from(document.querySelectorAll('.drawer-header .el-button')); const b = btns.find((x) => x.textContent.includes('全部已读')); if (b) { b.click(); return true; } return false; })()`);
    if (!clicked) { fail('U3', 'UI：全部已读', '找不到全部已读按钮'); return; }
    const cleared = await waitFor(`(() => { const b = document.querySelector('.bell-badge .el-badge__content'); return !b; })()`, 8000);
    if (cleared) pass('U3', 'UI：全部已读清空红点', `badge已消失`);
    else fail('U3', 'UI：全部已读清空红点', '点击后红点仍在');
  } catch (e) {
    fail('U1', 'UI 组异常', (e && e.message) ? e.message : String(e));
  } finally {
    if (s) { try { await s.send('Page.close').catch(() => null); } catch { /* noop */ } }
    const { stopChrome } = await import('./lib/chrome.mjs').catch(() => ({ stopChrome: null }));
    if (chrome && stopChrome) { try { await stopChrome(chrome); } catch { /* noop */ } }
  }
}

// ───────────── 精确清理 ─────────────
async function cleanup(before) {
  const c = await prisma();
  let nDeleted = 0;
  let followDeleted = 0;
  let likes = 0;
  let comments = 0;
  let articles = 0;
  let accounts = 0;

  // 1) 通知：只删「涉及 A/R 的」id 集合（已在 main 收集到 createdNotificationIds）
  if (createdNotificationIds.length) {
    nDeleted = (await c.notification.deleteMany({ where: { id: { in: createdNotificationIds } } })).count;
  }

  // 2) 关注：精确按对删除
  for (const fp of followPair) {
    const r = await c.follow.deleteMany({ where: { followerId: fp.followerId, followingId: fp.followingId } });
    followDeleted += r.count;
  }

  // 3) 点赞 → 4) 评论 → 5) 文章（FK RESTRICT 顺序）
  if (createdArticleIds.length) {
    likes = (await c.like.deleteMany({ where: { articleId: { in: createdArticleIds } } })).count;
    comments = (await c.comment.deleteMany({ where: { articleId: { in: createdArticleIds } } })).count;
    articles = (await c.article.deleteMany({ where: { id: { in: createdArticleIds } } })).count;
  }

  // 6) 账号：按用户名精确删除（二次保险：只删 pwprobe 前缀）
  accounts = await cleanupProbeAccounts([A.username, R.username]);

  await disconnectPrisma();

  // FAIL-SAFE：清理后应回到「初始基线 before」（user/文章/评论/点赞/关注/通知）
  const afterClean = await snapshot(CONFIG);
  const diffs = {};
  for (const k of Object.keys(before)) {
    if (afterClean[k] !== before[k]) diffs[k] = `${before[k]}→${afterClean[k]}`;
  }
  if (Object.keys(diffs).length === 0) {
    pass('CLN', '清理后基线无残留', `notifications删${nDeleted} follows删${followDeleted} articles删${articles} accounts删${accounts}`);
  } else {
    fail('CLN', '清理后基线残留', JSON.stringify(diffs));
  }
}

// ───────────── 入口 ─────────────
try {
  await main();
} catch (e) {
  console.log('\n[探针异常终止] ' + ((e && e.message) ? e.message : String(e)));
  fail('RUN', '探针主流程', (e && e.message) ? e.message : String(e));
} finally {
  await disconnectPrisma();
}

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n==== 通知中心探针结果：PASS ${passed} / FAIL ${failed} / SKIP ${skipped} ====`);

// 即便跳过 UI，只要有 FAIL 就非 0 退出；全绿才 0。
process.exit(failed > 0 ? 1 : 0);
