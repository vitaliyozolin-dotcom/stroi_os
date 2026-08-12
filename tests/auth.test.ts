import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionAuth, LoginRateLimiter, SESSION_COOKIE } from '../server/auth.js';

const config = {
  username: 'vitaliy', password: '1234567890', sessionSecret: 'a-secret-at-least-10',
  email: 'vitaliyozolin@gmail.com', name: 'Виталий Озолин',
};

test('valid credentials issue a verifiable secure session', () => {
  const auth = createSessionAuth(config);
  assert.equal(auth.verifyCredentials('vitaliy', '1234567890'), true);
  assert.equal(auth.verifyCredentials('vitaliy', 'wrong-password'), false);
  const request = new Request('https://example.com/');
  const cookie = auth.sessionCookie(request);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  const token = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))[1];
  const authenticated = new Request('https://example.com/', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.deepEqual(auth.fromRequest(authenticated), { email: config.email, name: config.name });
});

test('tampered and expired sessions are rejected', () => {
  const auth = createSessionAuth(config);
  const cookie = auth.sessionCookie(new Request('https://example.com/'), 1_000);
  const token = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))[1];
  const tampered = new Request('https://example.com/', { headers: { cookie: `${SESSION_COOKIE}=${token}x` } });
  assert.equal(auth.fromRequest(tampered), null);
  const expiredAuth = createSessionAuth({ ...config, sessionSecret: 'another-secret-10' });
  const oldCookie = expiredAuth.sessionCookie(new Request('https://example.com/'), 1_000);
  const oldToken = oldCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))[1];
  const oldRequest = new Request('https://example.com/', { headers: { cookie: `${SESSION_COOKIE}=${oldToken}` } });
  assert.equal(expiredAuth.fromRequest(oldRequest), null);
});

test('rate limiter blocks repeated failures and resets after success', () => {
  const limiter = new LoginRateLimiter({ limit: 2, windowMs: 1_000, blockMs: 2_000 });
  limiter.fail('ip', 0);
  assert.equal(limiter.isBlocked('ip', 100), false);
  limiter.fail('ip', 200);
  assert.equal(limiter.isBlocked('ip', 300), true);
  limiter.success('ip');
  assert.equal(limiter.isBlocked('ip', 300), false);
});
