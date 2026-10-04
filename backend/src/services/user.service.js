import prisma from '../utils/prisma.js';
import { whereNotDeleted } from '../utils/query.js';
import { CODE, httpError } from '../utils/response.js';
import { hasField } from '../validators/user.validator.js';
import { deleteLocalAvatar, deleteUploadedFile, toAvatarUrl } from './upload.service.js';

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
 * ## 旧头像文件的清理（第十一批引入）
 * 若本次改动了 avatar，且**旧值是站内路径**（`/uploads/` 开头），写库成功后把旧文件删掉。
 * 顺序是**先写库、再删文件**：反过来（先删后写）一旦写库失败，用户就彻底没头像了；
 * 前者删失败只留一个垃圾文件（登记在 docs/DB.md「已知限制」第 4 条），不影响正确性。
 *
 * 外链下线后，本接口的 avatar **正常只用于清空**（传 null）——设置头像统一走
 * `POST /api/users/me/avatar`（validate 仍接受 /uploads/ 前缀的字符串，是给探针与运维留的窄口）。
 * 「旧值不是 /uploads/ 开头就不删」这条判断仍然保留：它是**脏值防御**，
 * 挡的是手工改库留下的历史值（如第九批的外链），不是「外链分支」。
 *
 * @param {object} params
 * @param {number} params.userId 来自 token
 * @param {object} params.body 已通过 zod 校验的请求体
 * @returns {Promise<object>} 完整的 public user
 */
export async function updateProfile({ userId, body }) {
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id: userId }),
    // 多查一个 avatar：写库成功后要拿旧值清文件，不查就得再发一条 SQL。
    select: { id: true, avatar: true },
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

  // 写库成功后才清旧文件；改的是 bio 时 avatar 键没出现，不做任何删除。
  // 外链下线后这里的 avatar 只会是 null（清空），下面这行负责把旧文件删掉。
  if (hasField(body, 'avatar')) {
    deleteLocalAvatar(user.avatar);
  }

  return toPublicUser(updated);
}

/**
 * 上传头像：把「multer 已落盘的文件」变成 users.avatar 的站内路径并写库。
 * 对应 docs/API.md 的 POST /api/users/me/avatar。
 *
 * ## 为什么写成三个分支（而不是一个 try 包到底）
 * 磁盘与数据库之间没有事务，只能靠**补偿动作**兜底：
 *   - 用户不存在 → 文件已经落盘了，删掉，不留孤儿
 *   - 写库失败   → 同上，删掉刚落盘的文件（API.md 处理顺序第 5 步的反向操作）
 *   - 写库成功   → 删旧头像（顺序是先写库再删，理由见 updateProfile 的注释）
 *
 * 前两个分支是「回滚」，第三个是「清理」，性质不同，分开写更清楚。
 *
 * @param {object} params
 * @param {number} params.userId 来自 token
 * @param {object} params.file multer 的 file 对象（diskStorage，必有 path）
 * @returns {Promise<object>} 完整的 public user
 */
export async function updateAvatar({ userId, file }) {
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id: userId }),
    select: { id: true, avatar: true },
  });

  if (!user) {
    deleteUploadedFile(file.path);
    throw httpError(404, CODE.NOT_FOUND, '用户不存在');
  }

  const avatar = toAvatarUrl(file);

  let updated;
  try {
    updated = await prisma.user.update({
      where: { id: user.id },
      data: { avatar },
      select: PUBLIC_FIELDS,
    });
  } catch (error) {
    deleteUploadedFile(file.path);
    throw error;
  }

  deleteLocalAvatar(user.avatar);

  return toPublicUser(updated);
}

export { toPublicUser, PUBLIC_FIELDS };
