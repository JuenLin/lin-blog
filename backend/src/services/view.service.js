// 第 9 批：阅读计数服务（POST /api/articles/:id/view）。
//
// 三个设计决策（docs/API.md「收藏与阅读量」→ POST /api/articles/:id/view）：
//   1. **免登录**：阅读是匿名行为，与点赞 / 收藏（需登录）刻意不同；
//   2. **防刷最简**：内存 Map 同 IP + 同文章 5 分钟判重——用户明确不做生产级安全
//      （WAF / 限流 / CSRF），进程重启后判重窗口清零是已知代价（尽力而为）；
//   3. **计数原子**：prisma increment，禁止 read-modify-write（并发下丢计数）。
import prisma from '../utils/prisma.js';
import { whereNotDeleted } from '../utils/query.js';
import { CODE, httpError } from '../utils/response.js';

// 判重窗口：同一 (articleId, ip) 5 分钟内重复请求不 +1。
const VIEW_DEDUP_WINDOW_MS = 5 * 60 * 1000;

// key: `${articleId}:${ip}` → 最近一次计数的时间戳。
// 不设容量上限（用户批准）：key 体积极小，博客量级下可忽略；
// 但会顺带清扫已过期条目做内存保洁——过期条目本来就不再拦截，
// 清扫不改变任何计数语义。
const recentViews = new Map();
const SWEEP_THRESHOLD = 10000;

function shouldCountView(articleId, ip) {
  const key = `${articleId}:${ip}`;
  const now = Date.now();
  const last = recentViews.get(key);

  if (last !== undefined && now - last < VIEW_DEDUP_WINDOW_MS) {
    return false;
  }

  recentViews.set(key, now);

  if (recentViews.size > SWEEP_THRESHOLD) {
    for (const [k, ts] of recentViews) {
      if (now - ts >= VIEW_DEDUP_WINDOW_MS) {
        recentViews.delete(k);
      }
    }
  }

  return true;
}

/**
 * 记录一次阅读，viewCount +1（判重命中时不变）。
 *
 * 存在性判定用**公开可读**口径（不存在 / 已软删 / 草稿一律 404），
 * 与 `GET /api/articles/:id` 的 `status: 'PUBLISHED'` 过滤一致——
 * 阅读量只统计公开可见文章的阅读，草稿不通过任何公开入口暴露。
 * （注意与 like / bookmark 用的 `requireArticleForWrite` 不同：那个只看软删。）
 *
 * @param {number} articleId 已由 zod 校验为正整数
 * @param {string} ip 来自 req.ip（无反向代理，即 socket 对端地址）
 * @returns {Promise<{ viewCount: number }>} +1 后的最新值（判重未 +1 时为当前值）
 */
export async function recordView(articleId, ip) {
  const article = await prisma.article.findFirst({
    where: whereNotDeleted({ id: articleId, status: 'PUBLISHED' }),
    select: { id: true },
  });

  if (!article) {
    throw httpError(404, CODE.NOT_FOUND, '文章不存在');
  }

  if (shouldCountView(articleId, ip)) {
    const updated = await prisma.article.update({
      where: { id: articleId },
      data: { viewCount: { increment: 1 } },
      select: { viewCount: true },
    });

    return { viewCount: updated.viewCount };
  }

  const current = await prisma.article.findUnique({
    where: { id: articleId },
    select: { viewCount: true },
  });

  return { viewCount: current ? current.viewCount : 0 };
}
