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
    const result = await prisma.user.deleteMany({
      where: {
        username: { in: targets },
      },
    });

    return result.count;
  } finally {
    await prisma.$disconnect();
  }
}

export { PROBE_PREFIX };