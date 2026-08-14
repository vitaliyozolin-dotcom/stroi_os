import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { activationPage } from '../server/access-page.js';
import {
  ACCESS_SESSION_COOKIE,
  UserAccessService,
  hashAccessPassword,
  hashAccessToken,
  normalizeAccessAddress,
  parseCookieHeader,
  validateAccessPassword,
  verifyAccessPassword,
} from '../server/user-access.js';

test('passwords use the bounded memory-hard profile and never store plaintext', async () => {
  const password = 'correct horse battery staple';
  const encoded = await hashAccessPassword(password);
  assert.match(encoded, /^scrypt\$32768\$8\$3\$/);
  assert.doesNotMatch(encoded, new RegExp(password));
  assert.equal(await verifyAccessPassword(password, encoded), true);
  assert.equal(await verifyAccessPassword('wrong-password-value', encoded), false);
  assert.equal(await verifyAccessPassword(password, encoded.replace('32768', '1048576')), false);
});

test('password limits are checked before scrypt work', () => {
  assert.equal(validateAccessPassword('short'), 'weak_password');
  assert.equal(validateAccessPassword('a'.repeat(14)), 'weak_password');
  assert.equal(validateAccessPassword('a'.repeat(15)), '');
  assert.equal(validateAccessPassword('я'.repeat(129)), 'weak_password');
});

test('opaque invite and session tokens are represented only by SHA-256 hashes', () => {
  const raw = 'one-time-secret-token';
  const digest = hashAccessToken(raw);
  assert.equal(digest.length, 64);
  assert.doesNotMatch(digest, /one-time/);
  assert.equal(hashAccessToken(raw), digest);
});

test('login rate addresses isolate IPv4 and normalize IPv6 to a source /64', () => {
  assert.equal(normalizeAccessAddress('203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeAccessAddress('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeAccessAddress('2001:db8:1:2::1'), '2001:0db8:0001:0002::/64');
  assert.equal(normalizeAccessAddress('2001:db8:1:2:ffff::9'), '2001:0db8:0001:0002::/64');
  assert.equal(normalizeAccessAddress('2001:db8:1:3::1'), '2001:0db8:0001:0003::/64');
});

test('session cookie is server-side, HttpOnly, same-site and secure from configured origin', () => {
  const service = new UserAccessService({
    database: { pool: {} },
    ownerEmail: 'owner@example.test',
    ownerName: 'Owner',
    ownerUsername: 'owner',
    ownerPassword: 'owner-password-long',
    publicUrl: 'https://os.example.test',
  });
  const cookie = service.cookie('opaque');
  assert.match(cookie, new RegExp(`${ACCESS_SESSION_COOKIE}=opaque`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.equal(parseCookieHeader(cookie)[ACCESS_SESSION_COOKIE], 'opaque');
  assert.match(service.clearCookie(), /Max-Age=0/);
  assert.throws(() => new UserAccessService({
    database: { pool: {} }, ownerEmail: 'owner@example.test', ownerName: 'Owner', ownerUsername: 'owner',
    ownerPassword: 'owner-password-long', publicUrl: 'http://public.example.test',
  }), /HTTPS/);
  assert.throws(() => new UserAccessService({
    database: { pool: {} }, ownerEmail: 'owner@example.test', ownerName: 'Owner', ownerUsername: 'owner',
    ownerPassword: 'replace-with-a-different-long-random-secret', publicUrl: 'https://os.example.test',
  }), /non-placeholder/);
});

test('activation page escapes account data and does not consume a link on GET', () => {
  const page = activationPage({
    token: 'token-value',
    invite: { purpose: 'activate', name: '<script>', email: 'user@example.test', role: 'foreman', projectName: 'Дом' },
  });
  assert.doesNotMatch(page, /<script>/);
  assert.match(page, /&lt;script&gt;/);
  assert.match(page, /method="post" action="\/api\/auth\/activate"/);
  assert.match(page, /type="hidden" name="token"/);
});

test('server strips forged identity headers and uses revocable personal sessions', async () => {
  const [server, access] = await Promise.all([
    readFile(new URL('../server/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../server/user-access.js', import.meta.url), 'utf8'),
  ]);
  assert.match(server, /headers\.delete\('oai-authenticated-user-email'\)/);
  assert.match(server, /headers\.delete\('oai-authenticated-user-projects'\)/);
  assert.match(server, /await userAccess\.fromRequest\(request\)/);
  assert.match(server, /Clear-Site-Data/);
  assert.match(access, /UPDATE auth_sessions SET revoked_at/);
  assert.match(access, /UPDATE auth_tokens SET revoked_at/);
  assert.doesNotMatch(access, /password_hash\s*=\s*password/);
});
