import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowedTelegramPath, isPrivateRelayClient } from '../server/telegram-relay.js';

test('Telegram relay accepts only private Docker and loopback clients', () => {
  assert.equal(isPrivateRelayClient('127.0.0.1'), true);
  assert.equal(isPrivateRelayClient('::1'), true);
  assert.equal(isPrivateRelayClient('::ffff:172.20.0.4'), true);
  assert.equal(isPrivateRelayClient('10.0.0.8'), true);
  assert.equal(isPrivateRelayClient('192.168.1.10'), true);
  assert.equal(isPrivateRelayClient('188.225.38.55'), false);
  assert.equal(isPrivateRelayClient('2001:db8::1'), false);
});

test('Telegram relay exposes only Bot API and file routes', () => {
  assert.equal(isAllowedTelegramPath('/bot123:secret/getMe'), true);
  assert.equal(isAllowedTelegramPath('/bot123:secret/sendMessage'), true);
  assert.equal(isAllowedTelegramPath('/file/bot123:secret/documents/file.pdf'), true);
  assert.equal(isAllowedTelegramPath('/health'), false);
  assert.equal(isAllowedTelegramPath('/'), false);
  assert.equal(isAllowedTelegramPath('/bot123:secret/../../etc/passwd'), false);
  assert.equal(isAllowedTelegramPath('/other-host'), false);
});
