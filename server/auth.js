import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'stroios_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

const sign = (value, secret) => createHmac('sha256', secret).update(value).digest('base64url');

const parseCookies = (header = '') => Object.fromEntries(
  header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)];
  }),
);

export const createSessionAuth = ({ username, password, email, name, sessionSecret = password }) => {
  if (!password || password.length < 10) throw new Error('APP_PASSWORD must contain at least 10 characters');
  if (!sessionSecret || sessionSecret.length < 10) throw new Error('SESSION_SECRET must contain at least 10 characters');

  const verifyCredentials = (candidateUser, candidatePassword) => (
    safeEqual(candidateUser, username) && safeEqual(candidatePassword, password)
  );

  const issue = (now = Date.now()) => {
    const payload = Buffer.from(JSON.stringify({
      email,
      name,
      exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
    })).toString('base64url');
    return `${payload}.${sign(payload, sessionSecret)}`;
  };

  const verify = (token, now = Date.now()) => {
    if (!token) return null;
    const separator = token.lastIndexOf('.');
    if (separator < 1) return null;
    const payload = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!safeEqual(signature, sign(payload, sessionSecret))) return null;
    try {
      const identity = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!identity?.email || !identity?.name || !Number.isFinite(identity.exp)) return null;
      if (identity.exp <= Math.floor(now / 1000)) return null;
      return { email: identity.email, name: identity.name };
    } catch {
      return null;
    }
  };

  const fromRequest = (request) => verify(parseCookies(request.headers.get('cookie'))[SESSION_COOKIE]);

  const sessionCookie = (request, now = Date.now()) => {
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return `${SESSION_COOKIE}=${issue(now)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
  };

  const clearCookie = (request) => {
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  };

  return { verifyCredentials, fromRequest, sessionCookie, clearCookie };
};

export class LoginRateLimiter {
  constructor({ limit = 5, windowMs = 15 * 60_000, blockMs = 15 * 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.entries = new Map();
  }

  isBlocked(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.blockedUntil > now) return true;
    if (now - entry.startedAt >= this.windowMs) this.entries.delete(key);
    return false;
  }

  fail(key, now = Date.now()) {
    const current = this.entries.get(key);
    const entry = !current || now - current.startedAt >= this.windowMs
      ? { count: 0, startedAt: now, blockedUntil: 0 }
      : current;
    entry.count += 1;
    if (entry.count >= this.limit) entry.blockedUntil = now + this.blockMs;
    this.entries.set(key, entry);
  }

  success(key) {
    this.entries.delete(key);
  }
}
