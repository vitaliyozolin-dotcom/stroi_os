import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInviteUrl, cookieValue, hashPassword, hashToken, passwordIssue, verifyPassword } from '../server/auth.js';

test('stores passwords as salted scrypt hashes', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('wrong password', stored), false);
});

test('requires a password of at least 10 characters', () => {
  assert.equal(passwordIssue('123456789'), 'password_too_short');
  assert.equal(passwordIssue('1234567890'), '');
});

test('hashes opaque invitation tokens before storage', () => {
  assert.equal(hashToken('invite-token').length, 64);
  assert.notEqual(hashToken('invite-token'), 'invite-token');
});

test('builds a manual one-time invitation URL on the configured public origin', () => {
  assert.equal(
    buildInviteUrl('https://stroios.example/path?old=1', 'token with spaces'),
    'https://stroios.example/?invite=token+with+spaces',
  );
});

test('reads only the named cookie', () => {
  assert.equal(cookieValue('theme=dark; stroios_session=secret%20token; a=1', 'stroios_session'), 'secret token');
  assert.equal(cookieValue('theme=dark', 'stroios_session'), '');
});
