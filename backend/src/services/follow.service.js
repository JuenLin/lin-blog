// ⚠️ 不能写 `import { PrismaClientKnownRequestError } from '@prisma/client'`：
// 顶层导出里**没有**这个名字（实测为 undefined），`error instanceof undefined` 会直接抛
// TypeError，重复关注会变成 500 而不是预期的幂等成功。正确写法是从 `Prisma` 命名空间上取。
import { Prisma } from '@prisma/client';

import prisma from '../utils/prisma.js';
import { CODE, httpError } from '../utils/response.js';
import { whereNotDeleted, buildOrderBy } from '../utils/query.js';
import { parsePagination, buildPaginationMeta } from '../utils/pagination.js';
import { toPublicUser, PUBLIC_FIELDS, requireUserExists } from './user.service.js';
import { notifyOnFollow } from './notification.service.js';

// docs/API.md GET /api/users/:id/followers|following：
// sortBy 白名单为 followedAt / id，默认 followedAt desc。
// 前端 Tab **不暴露排序控件**，其余项是给探针与将来用的，与 GET /api/users/me/likes 同做法。
const FOLLOW_SORT_FIELDS = ['followedAt', 'id'];

// followedAt / id 两个 API 字段名 → Prisma orderBy 片段。
//
// followedAt 是**API 层虚拟名**，follows 表里对应列叫 created_at（Prisma 侧 createdAt），
// 直接 orderBy { followedAt } 会报 Unknown argument（实测）。
// 而这里的 `{ createdAt: order }` 因为查询主模型是 Follow，解析到的是
// **follows.createdAt**（关注发生时间），正是我们要的语义。
//
// id 走 buildOrderBy 的默认同名列映射 → `{ id: order }`，即 **follows.id**（关系行主键），
// **不是 users.id** —— 见 docs/API.md GET /followers「次级排序用 follows.id」。
// 若写成 `{ user: { id } }` 会切到 users.id，那是另一个语义（粉丝编号），最容易混。
const FOLLOW_SORT_MAP = {
  followedAt: (order) => ({ createdAt: order }),
};

/**
 * 某用户的粉丝数（被多少人关注）。
 *
 * 只算「粉丝用户未软删」的记录：软删的粉丝不计入，与 GET /followers 的 total 口径一致。
 * where 形态与 listFollowers 的 count 完全相同 → 四数同源（见下方「四数口径一致」）。
 *
 * @param {number} targetId 被关注者 id（路径 :id）
 * @returns {Promise<number>}
 */
async function countFollowers(targetId) {
  return prisma.follow.count({
    where: { followingId: targetId, follower: { deletedAt: null } },
  });
}

/**
 * 某用户的关注数（主动关注了谁）。
 *
 * 只算「被关注者未软删」的记录：软删的被关注者不计入，与 GET /following 的 total 口径一致。
 *
 * @param {number} userId 关注者 id（当前登录用户）
 * @returns {Promise<number>}
 */
async function countFollowing(userId) {
  return prisma.follow.count({
    where: { followerId: userId, following: { deletedAt: null } },
  });
}

/**
 * 组装 POST / DELETE 返回的双计数。
 *
 * followerCount = 被关注者(:id) 的粉丝数；followingCount = 当前用户的关注数。
 * 两者都只算未软删的另一端用户，与两个列表的 total 同源。
 *
 * @param {number} targetId 被关注者 id
 * @param {number} followerId 当前登录用户 id
 * @param {boolean} following 关系当前状态（关注后恒 true / 取关后恒 false）
 */
function buildFollowCounts(targetId, followerId, following) {
  return Promise.all([countFollowers(targetId), countFollowing(followerId)]).then(
    ([followerCount, followingCount]) => ({ following, followerCount, followingCount })
  );
}

/**
 * 关注某用户（POST /api/users/:id/follow）。
 *
 * 判断顺序（docs/API.md）：参数 → 鉴权(auth 中间件) → 自操作 → 目标存在性 → 幂等写入。
 *
 * ## 与 like 刻意不同的 4 点（写进注释防将来误「修」）
 *   1. 重复关注 → **200 幂等成功**（不是 409）。唯一约束拦截的并发重复关注，
 *      应用层「先查再插」有竞态，只能由数据库唯一约束兜底，捕获 P2002 后转 200。
 *   2. 计数排除软删的**对方**用户（likeCount 含软删点赞者，这里刻意相反）。
 *   3. 次级排序 id = follows.id（不是 users.id）。
 *   4. `:id === 自己` → **400**（不能关注自己）。
 *
 * @param {number} targetId 路径 :id（被关注者）
 * @param {number} followerId 来自 token（关注者）
 * @returns {Promise<{ following: true, followerCount: number, followingCount: number }>}
 */
export async function followUser(targetId, followerId) {
  // 不能关注自己：先于存在性检查，否则会把「自己」误判成「不存在」，
  // 或写入 follower_id = following_id 的自关注记录。唯一约束虽能拦，但语义应直接 400。
  if (targetId === followerId) {
    throw httpError(400, CODE.PARAM_ERROR, '不能关注自己');
  }

  // 目标存在性（排除软删）→ 不存在 404。必须在写入之前。
  await requireUserExists(targetId);

  try {
    await prisma.follow.create({
      data: { followerId, followingId: targetId },
    });
  } catch (error) {
    // 唯一约束 follows_follower_id_following_id_key（底层 MySQL 1062）→ 已关注。
    // 转 **200 幂等成功**，不转 409 —— 与 POST /api/articles/:id/like 的「转 409」刻意相反。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return buildFollowCounts(targetId, followerId, true);
    }

    throw error;
  }

  // 第 8 批：新关注成功 → 通知被关注者（followUser 已拒绝「关注自己」，这里再兜底）。
  // 包裹 try/catch：通知是附加价值，失败不影响「已关注」的返回。
  try {
    await notifyOnFollow({ followerId, followingId: targetId });
  } catch (notifyError) {
    console.error('[notify] 关注通知发送失败（不影响关注结果）:', notifyError);
  }

  return buildFollowCounts(targetId, followerId, true);
}

/**
 * 取消关注（DELETE /api/users/:id/follow）。
 *
 * 与 like 刻意不同：未关注也返回 **200**（no-op 成功），不报 404 / 不报 409。
 * 理由（docs/API.md）：follows 的取消是「确认关系不存在」，没关注本来就是这个状态，
 * 语义是幂等成功；likes 的取消是「取消一个动作」，重复是错误。
 * 将来读代码的人容易以为是 bug，故显式注释。
 *
 * 自操作（DELETE 自己的关注态）视为 no-op，不单独报 400（400 只限 POST）。
 *
 * @param {number} targetId 路径 :id（被关注者）
 * @param {number} followerId 来自 token（关注者）
 * @returns {Promise<{ following: false, followerCount: number, followingCount: number }>}
 */
export async function unfollowUser(targetId, followerId) {
  // 目标存在性（排除软删）→ 404。DELETE 也要先验目标，与 POST 一致。
  await requireUserExists(targetId);

  // deleteMany 而非 delete：后者在记录不存在时抛 P2025，前者返回 { count }。
  // count === 0（本来就没关注）→ 仍返回 200 幂等成功，不报 404。
  await prisma.follow.deleteMany({
    where: { followerId, followingId: targetId },
  });

  return buildFollowCounts(targetId, followerId, false);
}

/**
 * 某用户的粉丝列表（GET /api/users/:id/followers），真后端分页，公开只读。
 *
 * followers = 关注 :id 的人。查询从 follows 表出发：
 *   WHERE following_id = :id，JOIN 粉丝端用户(relation `follower`) 排除软删。
 * list 与 count 用**同一个 `where`**，保证「列表条数」与「total」同源、口径一致
 * （杜绝「列表 total=5、POST 返回 followerCount=6 含软删」的数字跳变）。
 *
 * 列表项：公开用户资料(toPublicUser) + 虚拟字段 followedAt(= follows.createdAt)。
 *
 * @param {number} targetId 路径 :id
 * @param {object} query Express 的 req.query
 */
export async function listFollowers(targetId, query) {
  // 用户不存在/已软删 → 404；存在但 0 粉丝 → 200 + list:[] + total:0。
  await requireUserExists(targetId);

  const pagination = parsePagination(query, {
    allowedSort: FOLLOW_SORT_FIELDS,
    defaultSort: 'followedAt',
  });

  const where = {
    followingId: targetId,
    follower: { deletedAt: null },
  };

  const [rows, total] = await Promise.all([
    prisma.follow.findMany({
      where,
      select: {
        createdAt: true,
        follower: { select: PUBLIC_FIELDS },
      },
      // followedAt 走 FOLLOW_SORT_MAP 翻译成 follows.createdAt；次级 id 自动补 follows.id。
      orderBy: buildOrderBy(pagination, { map: FOLLOW_SORT_MAP }),
      skip: pagination.skip,
      take: pagination.take,
    }),
    // total 与 list 用同一个 where，保证口径一致。
    prisma.follow.count({ where }),
  ]);

  return {
    list: rows.map((row) => ({ ...toPublicUser(row.follower), followedAt: row.createdAt })),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}

/**
 * 某用户主动关注的列表（GET /api/users/:id/following），与 followers 完全对称。
 *
 * 只把查询条件换成 WHERE follower_id = :id，JOIN 被关注者端用户(relation `following`) 排除软删；
 * list[] 是「被关注者」的摘要。其余（分页 / 排序 / 四数口径 / 虚拟字段）机制同源。
 *
 * @param {number} targetId 路径 :id
 * @param {object} query Express 的 req.query
 */
export async function listFollowing(targetId, query) {
  await requireUserExists(targetId);

  const pagination = parsePagination(query, {
    allowedSort: FOLLOW_SORT_FIELDS,
    defaultSort: 'followedAt',
  });

  const where = {
    followerId: targetId,
    following: { deletedAt: null },
  };

  const [rows, total] = await Promise.all([
    prisma.follow.findMany({
      where,
      select: {
        createdAt: true,
        following: { select: PUBLIC_FIELDS },
      },
      orderBy: buildOrderBy(pagination, { map: FOLLOW_SORT_MAP }),
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.follow.count({ where }),
  ]);

  return {
    list: rows.map((row) => ({ ...toPublicUser(row.following), followedAt: row.createdAt })),
    ...buildPaginationMeta(pagination.page, pagination.pageSize, total),
  };
}
