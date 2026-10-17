import prisma from '../utils/prisma.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { signToken, buildPayload } from '../utils/jwt.js';
import { whereNotDeleted } from '../utils/query.js';
import { CODE, httpError } from '../utils/response.js';

const PUBLIC_FIELDS = {
  id: true,
  username: true,
  nickname: true,
  avatar: true,
  bio: true,
  role: true,
  createdAt: true,
};

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    avatar: user.avatar,
    bio: user.bio,
    role: user.role,
    createdAt: user.createdAt,
  };
}

export async function register({ username, password, nickname }) {
  const existing = await prisma.user.findFirst({
    where: whereNotDeleted({ username }),
    select: {
      id: true,
    },
  });

  if (existing) {
    throw httpError(409, CODE.CONFLICT, '用户名已存在');
  }

  const user = await prisma.user.create({
    data: {
      username,
      password: hashPassword(password),
      nickname: nickname ?? null,
    },
    select: PUBLIC_FIELDS,
  });

  return toPublicUser(user);
}

export async function login({ username, password }) {
  const record = await prisma.user.findFirst({
    where: whereNotDeleted({ username }),
    select: {
      id: true,
      username: true,
      nickname: true,
      password: true,
      avatar: true,
      bio: true,
      role: true,
      status: true,
      createdAt: true,
    },
  });

  if (!record) {
    throw httpError(401, CODE.UNAUTHORIZED, '用户名或密码错误');
  }

  const matched = comparePassword(password, record.password);

  if (!matched) {
    throw httpError(401, CODE.UNAUTHORIZED, '用户名或密码错误');
  }

  // 第 5 批：封禁拦截（登录侧）。刻意放在密码比对**之后**——
  // 输错密码只得到「用户名或密码错误」，输对才提示封禁
  // （docs/API.md 的 POST /api/auth/login 失败段）。
  if (record.status === 'BANNED') {
    throw httpError(401, CODE.ACCOUNT_BANNED, '账号已封禁');
  }

  const user = toPublicUser(record);

  return {
    token: signToken(buildPayload(record)),
    user,
  };
}

export async function getMe(userId) {
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id: userId }),
    select: PUBLIC_FIELDS,
  });

  if (!user) {
    throw httpError(404, CODE.NOT_FOUND, '用户不存在');
  }

  return toPublicUser(user);
}

/**
 * 修改当前用户的密码（docs/API.md 的 PUT /api/auth/password）。
 *
 * 身份完全来自 token 的 userId，请求体里的 userId / id / username
 * 已由 validators/auth.validator.js 拦掉，这里不再考虑。
 *
 * 旧 token **不失效**（docs/API.md「旧 token 语义」一节）：JWT 载荷只有
 * { userId, username }，不含密码版本号，auth 中间件只验签名与过期时间。
 * 所以这个函数**不需要**动任何已签发的 token，前端约定自行清 token 跳登录。
 *
 * 失败口径：
 * - 用户不存在 → 404，与 getMe 一致
 * - oldPassword 不匹配 → 401「用户名或密码错误」，与 login 一致，
 *   不区分「用户不存在」和「密码错」，避免变成账号枚举接口
 *
 * @returns {Promise<null>} 固定返回 null，成功响应体里 data 为 null
 */
export async function changePassword({ userId, oldPassword, newPassword }) {
  const user = await prisma.user.findFirst({
    where: whereNotDeleted({ id: userId }),
    select: {
      id: true,
      password: true,
    },
  });

  if (!user) {
    throw httpError(404, CODE.NOT_FOUND, '用户不存在');
  }

  const matched = comparePassword(oldPassword, user.password);

  if (!matched) {
    throw httpError(401, CODE.UNAUTHORIZED, '用户名或密码错误');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashPassword(newPassword),
    },
  });

  return null;
}
