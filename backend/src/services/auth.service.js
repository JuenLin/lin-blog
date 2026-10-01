import prisma from '../utils/prisma.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { signToken, buildPayload } from '../utils/jwt.js';
import { whereNotDeleted } from '../utils/query.js';
import { CODE, httpError } from '../utils/response.js';

const PUBLIC_FIELDS = {
  id: true,
  username: true,
  nickname: true,
  createdAt: true,
};

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname,
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
