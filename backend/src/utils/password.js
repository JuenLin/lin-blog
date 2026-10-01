import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

export function hashPassword(plainPassword) {
  return bcrypt.hashSync(plainPassword, SALT_ROUNDS);
}

export function comparePassword(plainPassword, passwordHash) {
  return bcrypt.compareSync(plainPassword, passwordHash);
}
