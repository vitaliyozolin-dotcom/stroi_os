import assert from 'node:assert/strict';
import test from 'node:test';

import { createTelegramAttachmentDrafts } from '../sites/telegram/attachment-drafts.js';

const binding = { project_id: 'project-a', system_user_id: 'user-a' };
const env = { DB: {}, TELEGRAM_BOT_TOKEN: 'test-token' };

const createSubject = (onDraft: () => void) => createTelegramAttachmentDrafts({
  createDraft: async () => { onDraft(); },
  projectForBinding: async () => ({ snapshot: { state: { project: { code: 'H-001' } } } }),
  telegramBotUsername: async () => 'ikioma_bot',
});

test('group attachments addressed to another bot or without a file id create no draft', async () => {
  let draftCalls = 0;
  const subject = createSubject(() => { draftCalls += 1; });

  await subject.prepare({
    from: { id: 7 },
    chat: { id: -100, type: 'group' },
    caption: '/doc@other_bot акт.pdf',
    document: { file_id: 'telegram-file-1', file_name: 'акт.pdf' },
  }, binding, env);
  await subject.prepare({
    from: { id: 7 },
    chat: { id: 7, type: 'private' },
    document: { file_name: 'акт.pdf' },
  }, binding, env);

  assert.equal(draftCalls, 0);
});

test('pending attachment payload is bounded and keeps only resumable message fields', () => {
  const subject = createSubject(() => {});
  const payload = subject.payload({
    message_id: 42,
    caption: 'x'.repeat(1500),
    chat: { id: 7, type: 'private', title: 'Не сохранять' },
    document: { file_id: 'telegram-file-1' },
    unexpected: 'drop-me',
  });

  assert.equal(payload.caption.length, 1200);
  assert.deepEqual(payload.chat, { id: 7, type: 'private' });
  assert.deepEqual(payload.document, { file_id: 'telegram-file-1' });
  assert.equal('unexpected' in payload, false);
});
