import assert from 'node:assert/strict';
import test from 'node:test';
import { telegramFileToR2 } from '../sites/telegram/files.js';
import { telegramConfirmVisible, telegramSendPhoto } from '../sites/telegram/visibility.js';
import { claimUploadAdmission } from '../sites/lib/upload-admission.js';

test('file transport retains project ownership, stable retry key and bounded streaming', async t => {
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'POST') return Response.json({ ok: true, result: { file_path: 'file', file_size: 3 } });
    downloads++;
    return new Response('abc', { headers: { 'content-type': 'image/jpeg' } });
  });
  const writes: any[] = [];
  const env = { TELEGRAM_BOT_TOKEN: 'test', BUCKET: { put: async (key, body, options) => {
    assert.equal(await new Response(body).text(), 'abc');
    writes.push({ key, ...options });
  } } };
  const first = await telegramFileToR2(env, 'project', 'file-id', 'photo.jpg', 'image/jpeg', 'Owner', 'draft');
  const second = await telegramFileToR2(env, 'project', 'file-id', 'photo.jpg', 'image/jpeg', 'Owner', 'draft');
  assert.equal(downloads, 2);
  assert.equal(first.key, second.key);
  assert.equal(first.key, 'project/telegram/draft-photo.jpg');
  assert.equal(writes[0].maxBytes, 20 * 1024 * 1024);
  assert.equal(writes[0].customMetadata.projectId, 'project');
});

test('oversized metadata prevents download and failed storage releases upload admission', async t => {
  let oversized = true;
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.method === 'POST') return Response.json({ ok: true, result: { file_path: 'file', file_size: oversized ? 21 * 1024 * 1024 : 3 } });
    downloads++;
    return new Response('abc');
  });
  const env = { BUCKET: { put: async () => { throw new Error('storage_failed'); } } };
  await assert.rejects(() => telegramFileToR2(env, 'p', 'f', 'f', '', 'Owner', 'draft'), /telegram_file_too_large/);
  assert.equal(downloads, 0);
  oversized = false;
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => telegramFileToR2(env, 'p', 'f', 'f', '', 'Owner', 'draft'), /storage_failed/);
  }
  const releaseA = claimUploadAdmission();
  const releaseB = claimUploadAdmission();
  try {
    assert.ok(releaseA && releaseB);
    await assert.rejects(() => telegramFileToR2(env, 'p', 'f', 'f', '', 'Owner', 'draft'), /upload_busy/);
  } finally {
    releaseA?.(); releaseB?.();
  }
});

test('visible edits and photo captions use bounded Telegram text; unchanged edits succeed', async t => {
  const payloads: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return Response.json({ ok: true });
  });
  assert.equal(await telegramConfirmVisible({}, 1, 2, 'x'.repeat(5000)), 'edited');
  await telegramSendPhoto('test', 1, 'photo', 'x'.repeat(2000));
  assert.ok(payloads[0].text.length <= 4000);
  assert.ok(payloads[1].caption.length <= 1000);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: false, description: 'message is not modified' }, { status: 400 }));
  assert.equal(await telegramConfirmVisible({}, 1, 2, 'same'), 'edited');
});
