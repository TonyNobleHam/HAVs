import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';

const scrypt = promisify(scryptCallback);
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const csrfFor = (token) => digest(`havs-csrf-v1:${token}`);
export const normalizeEmail = (email) => typeof email === 'string' ? email.trim().toLowerCase() : '';
export const validEmail = (email) => typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
export const validPassword = (password) => typeof password === 'string' && password.length >= 12 && password.length <= 128 && Buffer.byteLength(password) <= 512;
export const validName = (name) => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 100;

export async function hashPassword(password) {
  if (!validPassword(password)) throw new Error('Password must contain 12–128 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128 || Buffer.byteLength(password) > 512) return false;
  const [algorithm, salt, hash] = encoded.split(':');
  if (algorithm !== 'scrypt' || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(hash)) return false;
  const actual = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}
