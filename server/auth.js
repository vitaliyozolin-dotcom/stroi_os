import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export const normalizeLogin = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';

export const passwordIssue = (password) => {
  if (typeof password !== 'string' || password.length < 12) return 'password_too_short';
  if (password.length > 256) return 'password_too_long';
  return '';
};

export const hashPassword = async (password, salt = randomBytes(16).toString('hex')) => {
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`;
};

export const verifyPassword = async (password, stored) => {
  const [algorithm, salt, expectedHex] = String(stored || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = Buffer.from(await scrypt(password, salt, KEY_LENGTH));
  return timingSafeEqual(actual, expected);
};

export const newOpaqueToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token) => createHash('sha256').update(String(token || '')).digest('hex');

export const cookieValue = (cookieHeader, name) => {
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return '';
};
