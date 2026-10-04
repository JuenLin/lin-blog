// 第二步 搜索（GET /api/articles?keyword=）量化探针：把 docs/API.md 写死的语义逐条变成可度量的断言。
// 本探针只打后端 API，不依赖前端页面，因此不需要 Chrome —— 纯 fetch + 造夹具 + 精确回收。
//
// 覆盖 docs/API.md「keyword 语义」5 条：
//   1. 匹配范围 = title OR content，不含作者昵称
//   2. 空串 / 纯空白 = 视为不传（返回全量，不报错）
//   3. 超长（>50 字符）= 400 / 40000
//   4. 与分页 / 排序正交（total 是命中总数，两页不重叠，asc/desc 反序，sortBy 白名单仍生效）
//   5. 软删除文章不参与搜索
// 另加：重复传值报错、trim 容错、不传 keyword 时行为与改动前完全一致（回归保护）。
//
// 自包含：自己造夹具、自己清理，不碰用户原有数据（契约 §13-9）。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, sleep, httpOk } from './lib/config.mjs';
import { mintToken, whoami } from './lib/session.mjs';
import { ensureFixtures, cleanupFixtures, listArticles, MARKERS } from './lib/fixtures.mjs';

// 截图/报告目录：默认带时间戳子目录（防 D:/tools/acceptance-shots 整目录被外部清掉）。
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT = process.argv[2] || path.join('D:/tools/acceptance-shots', `search-${stamp}`);
fs.mkdirSync(OUT, { recursive: true });

let fx = null; // 夹具清单，结尾按 fx.all 精确回收
const selfMade = []; // 本脚本自造的靶子文章 id（不在 fx.all 里，必须单独回收）
const summary = [];
const log = (label, ok, detail) => {
  summary.push({ label, ok: !!ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${label} | ${detail}`);
};

const ARTICLES = `${CONFIG.api}/articles`;

// 统一入口：所有查询都必须绕过本机代理（本机 curl/node 默认走 http_proxy，会拦 localhost）。
async function get(qs) {
  const res = await fetch(ARTICLES + qs);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* noop */
  }
  return { status: res.status, json };
}

async function createArticle(token, title, content) {
  const res = await fetch(ARTICLES, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ title, content }),
  });
  const json = await res.json();
  return json && json.data ? json.data : null;
}

try {
  if ((await httpOk(`${CONFIG.api}/articles?page=1&pageSize=1`)) !== 200) {
    throw new Error(`后端 ${CONFIG.api} 探不到。请先起后端 3000。`);
  }

  const adminToken = mintToken(CONFIG.adminId, `user${CONFIG.adminId}`).token;
  const admin = await whoami(adminToken);
  if (!admin) throw new Error(`userId=${CONFIG.adminId} 的 token 无效`);

  await cleanupKnownArtifactsSafe();
  fx = await ensureFixtures(adminToken, admin.id);

  // 造两篇靶子：一篇只在**标题**含关键词，一篇只在**正文**含关键词。
  // 关键词用罕见串，避免与库里既有内容误撞。
  const KW_TITLE = 'zz标题词zz';
  const KW_BODY = 'zz正文词zz';
  const KW_NEVER = 'zz绝不存在zz';

  const titleHit = await createArticle(adminToken, `一篇${KW_TITLE}的文章`, '正文里没有任何关键词。');
  const bodyHit = await createArticle(adminToken, '标题很普通的一篇', `正文第二段出现 ${KW_BODY}，只在这里。`);
  if (!titleHit || !bodyHit) throw new Error('造靶子文章失败（标题命中 / 正文命中）');

  // 软删除靶子：正文含关键词但已被软删除，用于验「软删除不参与搜索」。
  const softTitle = `软删${KW_TITLE}的`;
  const softHit = await createArticle(adminToken, softTitle, '这篇稍后会被软删除。');
  if (!softHit) throw new Error('造软删除靶子失败');
  // 三篇自造靶子必须自己回收：它们不在 fx.all 里，漏掉就会每轮往库里留 2 篇
  // （软删那篇 deleteMany 能清掉，但可见的两篇会一直堆着）。
  selfMade.push(titleHit.id, bodyHit.id, softHit.id);
  const delRes = await fetch(`${ARTICLES}/${softHit.id}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + adminToken },
  });
  const delJson = await delRes.json();
  if (!delJson || delJson.code !== 0) throw new Error('软删除靶子失败');
  // 软删除后应立刻搜不到（先验一次，确认前提成立）
  const afterDelete = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(KW_TITLE)}`);
  const stillThere = afterDelete.json.data.list.some((a) => a.id === softHit.id);
  if (stillThere) throw new Error('前提不成立：软删除的文章仍能被搜到，无法验该语义');

  // ---------- 语义 1：匹配范围 = title OR content ----------
  const t1 = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(KW_TITLE)}`);
  const tIds = t1.json.data.list.map((a) => a.id);
  log(
    'S1-1 命中标题：只在标题含词的靶子被返回',
    t1.status === 200 && tIds.includes(titleHit.id) && !tIds.includes(bodyHit.id),
    `status=${t1.status} total=${t1.json.data.total} 命中标题靶子=${tIds.includes(titleHit.id)} 误带正文靶子=${tIds.includes(bodyHit.id)}`
  );

  const t2 = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(KW_BODY)}`);
  const bIds = t2.json.data.list.map((a) => a.id);
  log(
    'S1-2 命中正文：只在正文含词的靶子被返回',
    t2.status === 200 && bIds.includes(bodyHit.id) && !bIds.includes(titleHit.id),
    `status=${t2.status} total=${t2.json.data.total} 命中正文靶子=${bIds.includes(bodyHit.id)} 误带标题靶子=${bIds.includes(titleHit.id)}`
  );

  const t3 = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(KW_NEVER)}`);
  log(
    'S1-3 搜不到：命中 0 条',
    t3.status === 200 && t3.json.data.total === 0 && t3.json.data.list.length === 0,
    `status=${t3.status} total=${t3.json.data.total} list=${t3.json.data.list.length}`
  );

  // 不含作者昵称：用 admin 的昵称当关键词，期望搜不到任何文章（除非标题/正文恰好含它）。
  const nick = admin.nickname || admin.username;
  const t4 = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(nick)}`);
  const nickLeak = t4.json.data.total;
  log(
    'S1-4 不匹配作者昵称（作者维度不在本期范围）',
    t4.status === 200 && nickLeak === 0,
    `nickname="${nick}" 当关键词 total=${nickLeak}（期望 0；靶子文章的标题/正文都不含昵称）`
  );

  // ---------- 语义 2：空串 / 纯空白 = 视为不传 ----------
  const base = await get('?page=1&pageSize=100');
  const baseTotal = base.json.data.total;
  const empty = await get('?page=1&pageSize=100&keyword=');
  const spaces = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent('   ')}`);
  log(
    'S2-1 keyword= 空串不 400 且等价于不传',
    empty.status === 200 && empty.json.code === 0 && empty.json.data.total === baseTotal,
    `status=${empty.status} total=${empty.json.data.total} 基线total=${baseTotal}`
  );
  log(
    'S2-2 纯空白 keyword 等价于不传',
    spaces.status === 200 && spaces.json.code === 0 && spaces.json.data.total === baseTotal,
    `status=${spaces.status} total=${spaces.json.data.total} 基线total=${baseTotal}`
  );

  // ---------- 语义 3：超长报错 ----------
  const kw51 = 'a'.repeat(51);
  const kw50 = 'a'.repeat(50);
  const over = await get(`?page=1&pageSize=5&keyword=${kw51}`);
  log(
    'S3-1 keyword 超 50 字符 → 400 / 40000',
    over.status === 400 && over.json.code === 40000,
    `status=${over.status} body=${JSON.stringify(over.json).slice(0, 90)}`
  );
  const exact = await get(`?page=1&pageSize=5&keyword=${kw50}`);
  log(
    'S3-2 keyword 恰好 50 字符 → 200（边界不含错误）',
    exact.status === 200 && exact.json.code === 0,
    `status=${exact.status} total=${exact.json.data && exact.json.data.total}`
  );

  // ---------- 语义 4：与分页 / 排序正交 ----------
  // 用「的」这种高频词，保证命中数 > pageSize，能真正翻页。
  const KW_MULTI = '的';
  const p1 = await get(`?page=1&pageSize=3&keyword=${encodeURIComponent(KW_MULTI)}`);
  const p2 = await get(`?page=2&pageSize=3&keyword=${encodeURIComponent(KW_MULTI)}`);
  const ids1 = p1.json.data.list.map((a) => a.id);
  const ids2 = p2.json.data.list.map((a) => a.id);
  const overlap = ids1.filter((i) => ids2.includes(i)).length;
  const expectedTotalPages = Math.ceil(p1.json.data.total / 3);
  log(
    'S4-1 搜索结果 total 是命中总数（不是全库总数）',
    p1.json.data.total > 0 && p1.json.data.total !== baseTotal && p1.json.data.totalPages === expectedTotalPages,
    `搜索total=${p1.json.data.total} 全库total=${baseTotal} totalPages=${p1.json.data.totalPages} 期望=${expectedTotalPages}`
  );
  log(
    'S4-2 搜索结果可翻页且两页不重复',
    p1.status === 200 && p2.status === 200 && overlap === 0 && ids1.length === 3 && ids2.length === 3,
    `page1=${ids1.length}条 page2=${ids2.length}条 重叠=${overlap}`
  );

  const asc = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(KW_MULTI)}&sortBy=createdAt&order=asc`);
  const desc = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(KW_MULTI)}&sortBy=createdAt&order=desc`);
  const aIds = asc.json.data.list.map((a) => a.id);
  const dIds = desc.json.data.list.map((a) => a.id);
  log(
    'S4-3 搜索下 asc / desc 顺序相反（排序仍生效）',
    aIds.length > 1 && JSON.stringify(aIds) === JSON.stringify([...dIds].reverse()),
    `asc首=${aIds[0]} asc末=${aIds[aIds.length - 1]} | desc首=${dIds[0]} desc末=${dIds[dIds.length - 1]}`
  );

  const ub = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(KW_MULTI)}&sortBy=updatedAt`);
  const badSort = await get('?keyword=a&sortBy=nonexistent');
  log(
    'S4-4 搜索下 sortBy 白名单仍生效（updatedAt 可用 / 非法值仍 400）',
    ub.status === 200 && ub.json.code === 0 && badSort.status === 400 && badSort.json.code === 40000,
    `updatedAt status=${ub.status} | 非法sortBy status=${badSort.status} msg=${JSON.stringify(badSort.json.message)}`
  );

  // 搜索与 sortBy 共存时，返回条数应与不带搜索时同条件一致（不被 keyword 误改）
  const pagNoKw = await get('?page=1&pageSize=100&sortBy=createdAt&order=desc');
  log(
    'S4-5 不传 keyword 时行为与改动前一致（回归保护）',
    pagNoKw.status === 200 && pagNoKw.json.data.total === baseTotal,
    `total=${pagNoKw.json.data.total} 期望=${baseTotal}`
  );

  // ---------- 语义 5：软删除不参与搜索 ----------
  const softKwRes = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(KW_TITLE)}`);
  const softIds = softKwRes.json.data.list.map((a) => a.id);
  log(
    'S5-1 软删除文章搜不到',
    !softIds.includes(softHit.id),
    `软删文章id=${softHit.id} 是否出现在结果=${softIds.includes(softHit.id)} 命中total=${softKwRes.json.data.total}`
  );

  // ---------- 额外：重复传值 + trim 容错 ----------
  const dup = await get('?keyword=a&keyword=b');
  log(
    'S6-1 keyword 重复传值 → 400（不被静默取第一个）',
    dup.status === 400 && dup.json.code === 40000,
    `status=${dup.status} msg=${JSON.stringify(dup.json.message)}`
  );

  const padded = await get(`?page=1&pageSize=100&keyword=${encodeURIComponent(`  ${KW_TITLE}  `)}`);
  const paddedIds = padded.json.data.list.map((a) => a.id);
  log(
    'S6-2 keyword 首尾空格被 trim（等价于不 trim 的结果）',
    padded.status === 200 && paddedIds.includes(titleHit.id),
    `status=${padded.status} 命中标题靶子=${paddedIds.includes(titleHit.id)}`
  );

  console.log('\n===== 搜索（keyword）量化探针汇总 =====');
  const passN = summary.filter((x) => x.ok).length;
  console.log(`通过 ${passN}/${summary.length}`);
  summary.forEach((x) => console.log(`  ${x.ok ? '✓' : '✗'} ${x.label}`));

  // 报告落盘，便于事后翻证据
  const report = [
    `# 搜索（GET /api/articles?keyword=）探针报告`,
    ``,
    `- 时间戳目录：${OUT}`,
    `- 结果：${passN}/${summary.length} 通过`,
    ``,
    `| 结果 | 断言 | 证据 |`,
    `| --- | --- | --- |`,
    ...summary.map((x) => `| ${x.ok ? 'PASS' : 'FAIL'} | ${x.label} | ${String(x.detail).replace(/\|/g, '\\|')} |`),
    ``,
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), report, 'utf8');
  console.log(`报告已写入：${path.join(OUT, 'report.md')}`);
} catch (e) {
  console.log('\n[执行中断] ' + (e && e.message ? e.message : String(e)));
} finally {
  try {
    const r = await cleanupFixtures(fx ? [...fx.all, ...selfMade] : selfMade, [MARKERS.comment]);
    if (r.ok) console.log(`已清理夹具数据：文章 ${r.articles} 篇 / 评论 ${r.comments + r.marked} 条`);
  } catch {
    /* noop */
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
