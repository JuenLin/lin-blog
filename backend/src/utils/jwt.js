import jwt from 'jsonwebtoken';

function getSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    const error = new Error('缺少环境变量 JWT_SECRET，请检查 backend/.env');
    error.businessCode = 50000;
    throw error;
  }

  return secret;
}

export function signToken(payload) {
  return jwt.sign(payload, getSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

export function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

export function buildPayload(user) {
  return {
    userId: user.id,
    username: user.username,
  };
}
