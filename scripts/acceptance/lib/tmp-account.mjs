// 一次性验收账号的清理：按**用户名精确**删除，绝不误伤用户真实数据。
//
// 为什么需要它：probe-password.mjs 之类的探针要真登录才能验证密码语义，
// 而 login 只认用户名 + 密码 —— 没法用 mintToken 造 token（那是直接签名，
// 压根不经过密码校验，测不到本接口）。所以必须注册一个一次性账号，
// 跑完再删掉。
//
// **MVP 没有 DELETE /api/users**（docs/API.md 登记为「未实现」），
// 所以这里直连 Prisma 删除。按用户名精确匹配，绝不手写 SQL（契约 §11）。
import { requireCjs, BACKEND_MODULES, BACKEND } from './config.mjs';
import path from 'node:path';

// 探针账号的用户名前缀，只有带这个前缀的才允许删—— 二次保险，
// 万一调用方传错参数，也不会误删真实用户。
const PROBE_PREFIX = 'pwprobe';

let loaded = false;
async function getPrisma() {
  if (loaded) {
    const { prisma } = await getPrisma.cached;
    return prisma;
  }

  getPrisma.cached = (async () => {
    // .env 路径用绝对路径（与 session.mjs 一致），不依赖 cwd——
    // 否则从别的目录跑探针会加载不到 JWT_SECRET / DATABASE_URL。
    requireCjs(path.join(BACKEND_MODULES, 'dotenv')).config({ path: path.join(BACKEND, '.env') });
    const { PrismaClient } = requireCjs(path.join(BACKEND_MODULES, '@prisma/client'));
    const prisma = new PrismaClient();
    return { prisma };
  })();

  loaded = true;
  const { prisma } = await getPrisma.cached;
  return prisma;
}

/**
 * 删除指定用户名的探针账号。
 *
 * **硬删除**（不是软删除）：这些账号是探针造的垃圾数据，
 * 留在库里会让 users 表和登录时的用户名唯一性校验都受影响。
 * 只按 userId 精确删，不动 articles / comments（这个账号刚建，没写过东西）。
 *
 * @param {string[]} usernames 要删的用户名
 * @returns {Promise<number>} 实际删除条数
 */
export async function cleanupProbeAccounts(usernames) {
  if (!Array.isArray(usernames) || usernames.length === 0) return 0;

  // 只删带探针前缀的
  const targets = usernames.filter((name) => typeof name === 'string' && name.startsWith(PROBE_PREFIX));

  if (targets.length === 0) {
    throw new Error(`拒绝删除：没有用户名带 ${PROBE_PREFIX} 前缀（传入=${JSON.stringify(usernames)}）`);
  }

  const prisma = await getPrisma();

  try {
    // 先拿到这些账号的 id（用户名 → id）。
    const users = await prisma.user.findMany({
      where: { username: { in: targets } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return 0;

    // 这些账号名下造过的文章（用于连带清理其评论 / 点赞 / 通知）。
    const articleIds = (
      await prisma.article.findMany({ where: { authorId: { in: ids } }, select: { id: true } })
    ).map((a) => a.id);

    // 相关评论：账号写的 + 落在自造文章上的（comment_likes 要按 commentId 双侧清理）。
    const commentIds = (
      await prisma.comment.findMany({
        where: { OR: [{ authorId: { in: ids } }, { articleId: { in: articleIds } }] },
        select: { id: true },
      })
    ).map((c) => c.id);

    // 外键顺序（全部 RESTRICT，必须按依赖反向删）：
    // 通知 → 收藏 → 点赞 → 关注 → 评论赞 → 评论 → 文章 → 系列 → 用户。
    // ⚠️ 第 8 批新增 notifications 表，actor_id / user_id 都指向 users 且 RESTRICT；
    //    之前的探针账号只要在评论 / 点赞 / 关注里当过触发者或接收者，就会在硬删用户时
    //    触发 P2003。这里按 `id: { in: [...] }` 精确清理，绝不误伤真实数据。
    // ⚠️ 第 9 批新增 bookmarks 表，user_id / article_id 双 RESTRICT（对镜 likes）：
    //    探针账号只要收藏过文章（自己的或别人的），硬删 user / article 就会被 1452 拦。
    //    清理条件与 likes 同构（userId OR articleId 双侧），顺序放在 notifications 之后。
    // ⚠️ 第 10 批新增 series 表：series.authorId → users 是 RESTRICT（探针账号建的
    //    系列挡删用户）；articles.seriesId → series 是 SET NULL（删文章不解绑系列，
    //    反过来删系列会自动解绑文章）。所以 series 必须删在 users 之前。
    // ⚠️ 第 11 批新增 comment_likes 表：user_id / comment_id 双 RESTRICT（对镜 likes）。
    //    探针账号点过别人的评论、或自己的评论被别人赞过，都会挡删 comment / user。
    //    清理条件按 userId OR commentId 双侧（commentId 已含「自造文章上的所有评论」），
    //    顺序在 follows 之后、comments 之前（评论赞行必须先于评论行删）。
    await prisma.notification.deleteMany({
      where: {
        OR: [{ actorId: { in: ids } }, { userId: { in: ids } }, { articleId: { in: articleIds } }],
      },
    });
    await prisma.bookmark.deleteMany({
      where: {
        OR: [{ userId: { in: ids } }, { articleId: { in: articleIds } }],
      },
    });
    await prisma.like.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { articleId: { in: articleIds } }] },
    });
    await prisma.follow.deleteMany({
      where: { OR: [{ followerId: { in: ids } }, { followingId: { in: ids } }] },
    });
    await prisma.commentLike.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { commentId: { in: commentIds } }] },
    });
    await prisma.comment.deleteMany({
      where: { OR: [{ authorId: { in: ids } }, { articleId: { in: articleIds } }] },
    });
    await prisma.article.deleteMany({ where: { id: { in: articleIds } } });
    await prisma.series.deleteMany({ where: { authorId: { in: ids } } });

    const result = await prisma.user.deleteMany({
      where: { username: { in: targets } },
    });

    return result.count;
  } finally {
    await prisma.$disconnect();
  }
}

export { PROBE_PREFIX };