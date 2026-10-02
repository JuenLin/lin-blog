// 验收数据夹具：造够验「分页 / Tab 排序」的量，用完能精确回收。
// 原则：**绝不改动用户原有的文章**，也**绝不删用户的文章** —— 删除流程用的是脚本自己造的那一篇。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, PREFIX, TMP, BACKEND, BACKEND_MODULES, requireCjs } from './config.mjs';

const apiBase = () => CONFIG.api;

async function api(method, p, token, body) {
  const res = await fetch(apiBase() + p, {
    method,
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* noop */
  }
  return { status: res.status, json };
}

export async function listArticles(token, pageSize = 100) {
  const r = await api('GET', `/articles?page=1&pageSize=${pageSize}&sortBy=createdAt&order=desc`, token);
  return r.json && r.json.data ? r.json.data : { list: [], total: 0 };
}

/**
 * 保证验收集据量够用，返回夹具清单。
 * - need = max(pageSize+1 - 现有可见数, 2)：既要凑出第 2 页，也要保证「最新 / 最近更新」两 Tab 结果不同。
 * - 额外造两篇专用：一篇给「编辑后保存」，一篇给「删除流程」。
 * - 更新动作放最后做，保证被改的那篇 updatedAt 一定是全场最新。
 */
export async function ensureFixtures(token, adminId) {
  const current = await listArticles(token);
  const visibleTotal = current.total || 0;
  const need = Math.max(CONFIG.pageSize + 1 - visibleTotal, 2);

  const batch = [];
  for (let i = 1; i <= need; i += 1) {
    const n = String(i).padStart(2, '0');
    const r = await api('POST', '/articles', token, {
      title: `${PREFIX} ${n}`,
      content:
        `用于博客前端验收的占位正文 ${n}。\n\n` +
        `第二段：验证摘要截断和详情页换行渲染。\n\n第三段：验收结束后这批数据会被清理。`,
    });
    if (!r.json || r.json.code !== 0) {
      throw new Error(`造数据失败：${JSON.stringify(r.json)}`);
    }
    batch.push(r.json.data.id);
  }

  const mk = async (title, content) => {
    const r = await api('POST', '/articles', token, { title, content });
    if (!r.json || r.json.code !== 0) throw new Error(`造数据失败：${JSON.stringify(r.json)}`);
    return r.json.data.id;
  };
  const editId = await mk(`${PREFIX} 编辑改名专用`, '原始正文：改名后应该在详情页看到新标题。');
  const deleteId = await mk(`${PREFIX} 删除流程专用`, '这篇专门用来跑删除流程，删它不动用户数据。');

  // 最后再改：保证它是 updatedAt 最新的一篇
  const updatedId = batch[0];
  await api('PUT', '/articles/' + updatedId, token, {
    title: `${PREFIX} 01（已更新）`,
    content: '正文被改过，updatedAt 应当让它排到「最近更新」首位。',
  });

  const all = [...batch, editId, deleteId];

  // 找一个「admin 自己的文章」做详情/编辑回填的靶子：优先挑用户原有的文章，
  // 这样 B 区验的是真实内容，也不会和后面要删的那篇撞车。
  const fresh = await listArticles(token);
  const owned =
    (fresh.list || []).find((a) => a.author && a.author.id === adminId && !all.includes(a.id)) ||
    (fresh.list || []).find((a) => a.author && a.author.id === adminId);

  const fx = {
    batch,
    editId,
    deleteId,
    updatedId,
    all,
    targetId: owned ? owned.id : editId,
    targetTitle: owned ? owned.title : `${PREFIX} 编辑改名专用`,
    visibleTotalBefore: visibleTotal,
    totalAfter: fresh.total,
  };
  fs.writeFileSync(path.join(TMP, 'fixtures.json'), JSON.stringify(fx, null, 2), 'utf8');
  return fx;
}

/**
 * 清理：硬删除自己造的文章及其评论，还原到验收前的库内容。
 * ids 里可以包含 UI 操作流程中新建出来的文章 id（脚本会记录下来传进来）。
 */
export async function cleanupFixtures(ids, commentMarkers = []) {
  const list = Array.from(new Set((ids || []).filter((x) => Number.isInteger(Number(x))))).map(Number);
  loadPrismaEnv();

  let prisma;
  try {
    const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));
    prisma = new PrismaClient();
    await prisma.$connect();
  } catch (e) {
    return { ok: false, reason: '无法加载 Prisma 客户端：' + e.message, ids: list };
  }

  let comments = 0;
  let articles = 0;
  let marked = 0;
  try {
    if (list.length) {
      // 外键顺序：先评论后文章（RESTRICT）
      comments = (await prisma.comment.deleteMany({ where: { articleId: { in: list } } })).count;
      articles = (await prisma.article.deleteMany({ where: { id: { in: list } } })).count;
    }
    if (commentMarkers.length) {
      marked = (
        await prisma.comment.deleteMany({
          where: { OR: commentMarkers.map((m) => ({ content: { contains: m } })) },
        })
      ).count;
    }
    const users = await prisma.user.count();
    const totalArticles = await prisma.article.count();
    const visibleArticles = await prisma.article.count({ where: { deletedAt: null } });
    const totalComments = await prisma.comment.count();
    return {
      ok: true,
      comments,
      articles,
      marked,
      final: {
        users,
        totalArticles,
        visibleArticles,
        totalComments,
      },
    };
  } finally {
    await prisma.$disconnect();
  }
}

function loadPrismaEnv() {
  requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
}

/**
 * 自愈清理：读回上次跑留下的清单（夹具 + UI 新建的 + 标题兜底 + 评论标记）。
 * run.mjs 每次开跑前会先调它，保证「上一次跑到一半被杀」不会留下脏数据。
 */
export async function cleanupKnownArtifacts() {
  const files = [path.join(TMP, 'fixtures.json'), path.join(TMP, 'ui-created.json')];
  let ids = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      ids = ids.concat(Array.isArray(data) ? data : data.all || []);
    } catch {
      /* noop */
    }
  }
  ids = Array.from(new Set(ids.map(Number).filter(Number.isInteger)));

  // 标题兜底：万一清单文件丢了，凡是带 PREFIX 的文章一律视为本次产物
  loadPrismaEnv();
  let orphan = [];
  try {
    const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));
    const prisma = new PrismaClient();
    const list = await prisma.article.findMany({ where: { title: { contains: PREFIX } }, select: { id: true } });
    orphan = list.map((a) => a.id);
    await prisma.$disconnect();
  } catch {
    /* noop */
  }

  const all = Array.from(new Set(ids.concat(orphan)));
  if (!all.length) return { cleaned: false, count: 0 };

  const r = await cleanupFixtures(all, [MARKERS.comment]);
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* noop */
    }
  }
  return { cleaned: true, count: r.articles || 0, final: r.final };
}

// UI 流程里新建出来的 id，必须落盘，否则脚本被中途杀掉就追不回来了。
export function recordUiCreated(id) {
  const f = path.join(TMP, 'ui-created.json');
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
  const next = Array.from(new Set(cur.concat([Number(id)]).filter(Number.isInteger)));
  fs.writeFileSync(f, JSON.stringify(next), 'utf8');
  return next;
}

export const MARKERS = {
  comment: '这条评论由验收脚本自动发表',
};
