import prisma from '../utils/prisma.js';
import { whereNotDeleted } from '../utils/query.js';
import { CODE, httpError } from '../utils/response.js';
import { hasField } from '../validators/user.validator.js';

// 对外返回的 user 字段。
// **与 validators/user.validator.js 的 forbiddenIdentityFields 是两回事**：
// 那里管的是「请求体不许传什么」，这里管的是「响应体返回什么」。
// 两者刻意都包含 username / nickname，因为它们都是公开信息；
// 但 password 永远不出现在这里，也永远不进 select。
const PUBLIC_FIELDS = {
  id: true,
  username: true,
  nickname: true,
  avatar: true,
  bio: true,
  createdAt: true,
};

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    avatar: user.avatar,
    bio: user.bio,
    createdAt: user.createdAt,
  };
}

/**
 * 修改当前用户的资料（头像 / 简介）。对应 docs/API.md 的 PUT /api/users/me。
 *
 * 身份完全来自 token 的 userId，请求体里的 id / userId / username / password
 * 已由 validators/user.validator.js 拦掉，这里不再考虑。
 *
 * ## 三态语义（本函数的核心）
 * 靠 **hasOwnProperty 判断键是否出现**，而不是判断值：
 *   - 键不出现→ 不把这个字段放进 update.data，Prisma 就不碰这一列
 *   - 键出现且值为 null → 写入 null，即清空该列
 *   - 键出现且值为字符串 → 写入该字符串
 *
 * 为什么不写成 `if (avatar) ...` 之类：
 *   ① `if (avatar)` 会把「空串」和「没传」混为一谈；
 *   ② 用 `avatar !== undefined` 判断同样有坑——zod 的 .optional() 会把
 *      「键缺失」和「键存在但值为 undefined」都归一成 undefined，
 *      于是「显式传 undefined」会被误当成「不改」，而「没传 avatar」
 *      在某些写法下又会被误当成清空。hasOwnProperty 是唯一可靠判据。
 *
 * 空串处理：bio 传 '' 时视为「清空」（docs/API.md 规定），
 * 统一转成 null 存储，不接受「空字符串」这种状态。
 *
 * @param {object} params
 * @param {number} params.userId 来自 token
 * @param {object} params.body 已通过 zod 校验的请求体
 * @returns {Promise<object>} 完整的 public user
 */
export async function updateProfile({ userId, body }) {
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id: userId }),
    select: { id: true },
  });

  if (!user) {
    throw httpError(404, CODE.NOT_FOUND, '用户不存在');
  }

  const data = {};

  if (hasField(body, 'avatar')) {
    // 空串已被 validator 拒（avatar 空串要传 null），这里只需处理 null / 字符串。
    data.avatar = body.avatar ?? null;
  }

  if (hasField(body, 'bio')) {
    // '' → null：空串代表「清空简介」，与 null 同义。
    data.bio = body.bio === '' ? null : body.bio ?? null;
  }

  // data 至少有一个键（validator 的 superRefine 已保证），
  // 但仍做一次防御：万一 validator 被绕过，不至于发出空 update。
  if (Object.keys(data).length === 0) {
    throw httpError(400, CODE.PARAM_ERROR, 'avatar 与 bio 至少要传一个');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    select: PUBLIC_FIELDS,
  });

  return toPublicUser(updated);
}

export { toPublicUser, PUBLIC_FIELDS };
