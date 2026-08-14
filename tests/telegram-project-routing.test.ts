import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  commandFromText,
  claimTelegramDraft,
  createTelegramDraft,
  flushTelegramOutbox,
  naturalTelegramCommand,
  parseTelegramExpense,
  releaseTelegramDraft,
  resolveTelegramDraftFile,
  selectTelegramBinding,
  telegramMessageMentionsBot,
  telegramCommandTargetsBot,
  telegramTaskActionKey,
  updateTelegramDraft,
} from '../sites/worker.js';

class OutboxDb {
  row = {
    id: 'notification-1',
    chat_id: 'chat-1',
    text: 'Проверка',
    options_json: '{}',
    status: 'pending',
    attempts: 0,
    created_at: '2026-08-14T00:00:00.000Z',
    updated_at: '2026-08-14T00:00:00.000Z',
    last_error: null as string | null,
  };

  prepare(sql: string) {
    const execute = (...args: unknown[]) => ({
      run: async () => {
        if (sql.includes("SET status = 'sending'")) {
          const [lease, id, status, updatedAt, attempts] = args;
          if (this.row.id === id && this.row.status === status && this.row.updated_at === updatedAt && this.row.attempts === attempts) {
            this.row.status = 'sending';
            this.row.attempts += 1;
            this.row.updated_at = String(lease);
            return { changes: 1 };
          }
          return { changes: 0 };
        }
        if (sql.includes("WHERE id = ? AND status = 'sending' AND updated_at = ?")) {
          const [status, error, updatedAt, id, lease] = args;
          if (this.row.id === id && this.row.status === 'sending' && this.row.updated_at === lease) {
            this.row.status = String(status);
            this.row.last_error = error == null ? null : String(error);
            this.row.updated_at = String(updatedAt);
            return { changes: 1 };
          }
          return { changes: 0 };
        }
        return { changes: 0 };
      },
      all: async () => {
        if (!sql.includes('FROM telegram_outbox')) return { results: [] };
        if (sql.includes("WHERE status = 'pending'")) return { results: this.row.status === 'pending' ? [{ ...this.row }] : [] };
        if (sql.includes("WHERE status IN ('failed', 'sending')")) return { results: ['failed', 'sending'].includes(this.row.status) ? [{ ...this.row }] : [] };
        return { results: [{ ...this.row }] };
      },
      first: async () => null,
    });
    return {
      ...execute(),
      bind: (...args: unknown[]) => execute(...args),
    };
  }
}

class DraftCreateDb {
  row: Record<string, unknown> | null = null;

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (!sql.includes('INSERT INTO telegram_drafts')) return { changes: 0 };
          if (this.row) return { changes: 0 };
          const [id, telegramUserId, chatId, projectId, kind, payloadJson, createdAt, expiresAt, updatedAt] = args;
          this.row = {
            id,
            telegram_user_id: telegramUserId,
            chat_id: chatId,
            project_id: projectId,
            kind,
            payload_json: payloadJson,
            status: 'draft',
            created_at: createdAt,
            expires_at: expiresAt,
            updated_at: updatedAt,
          };
          return { changes: 1 };
        },
        first: async () => {
          if (!sql.includes('FROM telegram_drafts') || !this.row) return null;
          const [id, telegramUserId, chatId, kind] = args;
          return this.row.id === id
            && this.row.telegram_user_id === telegramUserId
            && this.row.chat_id === chatId
            && this.row.kind === kind
            ? { ...this.row }
            : null;
        },
      }),
    };
  }
}

class BacklogOutboxDb {
  rows = [
    ...Array.from({ length: 60 }, (_, index) => ({
      id: `failed-${index}`,
      chat_id: `poison-${index}`,
      text: 'Старое сообщение',
      options_json: '{}',
      status: 'failed',
      attempts: 8,
      created_at: `2026-08-13T00:00:${String(index).padStart(2, '0')}.000Z`,
      updated_at: new Date().toISOString(),
      last_error: 'temporary failure',
    })),
    {
      id: 'fresh-pending',
      chat_id: 'healthy-chat',
      text: 'Новое сообщение',
      options_json: '{}',
      status: 'pending',
      attempts: 0,
      created_at: '2026-08-14T00:00:00.000Z',
      updated_at: '2026-08-14T00:00:00.000Z',
      last_error: null,
    },
  ];

  prepare(sql: string) {
    const execute = (...args: unknown[]) => ({
      run: async () => {
        if (sql.includes("SET status = 'sending'")) {
          const [lease, id, status, updatedAt, attempts] = args;
          const row = this.rows.find((item) => item.id === id);
          if (row && row.status === status && row.updated_at === updatedAt && row.attempts === attempts) {
            row.status = 'sending';
            row.attempts += 1;
            row.updated_at = String(lease);
            return { changes: 1 };
          }
          return { changes: 0 };
        }
        if (sql.includes("WHERE id = ? AND status = 'sending' AND updated_at = ?")) {
          const [status, error, updatedAt, id, lease] = args;
          const row = this.rows.find((item) => item.id === id);
          if (row && row.status === 'sending' && row.updated_at === lease) {
            row.status = String(status);
            row.last_error = error == null ? null : String(error);
            row.updated_at = String(updatedAt);
            return { changes: 1 };
          }
          return { changes: 0 };
        }
        return { changes: 0 };
      },
      all: async () => {
        if (sql.includes("WHERE status = 'pending'")) {
          const limit = Number(args[0]) || 10;
          return { results: this.rows.filter((row) => row.status === 'pending').slice(0, limit).map((row) => ({ ...row })) };
        }
        if (sql.includes("WHERE status IN ('failed', 'sending')")) {
          return { results: this.rows.filter((row) => ['failed', 'sending'].includes(row.status)).map((row) => ({ ...row })) };
        }
        return { results: [] };
      },
      first: async () => null,
    });
    return { ...execute(), bind: (...args: unknown[]) => execute(...args) };
  }
}

class DraftDb {
  row = {
    id: 'draft-1',
    telegram_user_id: 'user-1',
    chat_id: 'chat-1',
    status: 'draft',
    payload_json: '{}',
    updated_at: '2026-08-14T00:00:00.000Z',
  };

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes("SET status = 'processing'")) {
            const [updatedAt, id, telegramUserId, chatId, expectedUpdatedAt] = args;
            if (this.row.id === id && this.row.telegram_user_id === telegramUserId && this.row.chat_id === chatId && this.row.status === 'draft' && this.row.updated_at === expectedUpdatedAt) {
              this.row.status = 'processing';
              this.row.updated_at = String(updatedAt);
              return { changes: 1 };
            }
            return { changes: 0 };
          }
          if (sql.includes("SET status = 'draft'")) {
            const [updatedAt, id, expectedUpdatedAt] = args;
            if (this.row.id === id && this.row.status === 'processing' && this.row.updated_at === expectedUpdatedAt) {
              this.row.status = 'draft';
              this.row.updated_at = String(updatedAt);
              return { changes: 1 };
            }
            return { changes: 0 };
          }
          const [payload, status, updatedAt, id, expectedStatus, expectedUpdatedAt] = args;
          if (this.row.id === id && this.row.status === expectedStatus && this.row.updated_at === expectedUpdatedAt) {
            this.row.payload_json = String(payload);
            this.row.status = String(status);
            this.row.updated_at = String(updatedAt);
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      }),
    };
  }
}

test('natural expense write is never downgraded to a note', () => {
  assert.deepEqual(
    naturalTelegramCommand('запиши расход 6000 рублей пробное бурение'),
    { name: 'expense', body: '6000 рублей пробное бурение' },
  );
  assert.deepEqual(
    naturalTelegramCommand('запиши панели привезут в пятницу'),
    { name: 'note', body: 'панели привезут в пятницу' },
  );
  assert.deepEqual(
    naturalTelegramCommand('запиши расхот 6000 рублей пробное бурение'),
    { name: 'expense', body: '6000 рублей пробное бурение' },
  );
  assert.deepEqual(
    naturalTelegramCommand('запиши рассход 6000 рублей пробное бурение'),
    { name: 'expense', body: '6000 рублей пробное бурение' },
  );
  assert.deepEqual(
    naturalTelegramCommand('добавь оплату 6000 рублей за доставку'),
    { name: 'expense', body: '6000 рублей за доставку' },
  );
  for (const typo of ['рсход', 'расод', 'расхд', 'росход', 'расходу']) {
    assert.deepEqual(
      naturalTelegramCommand(`запиши ${typo} 6000 рублей бурение`),
      { name: 'expense', body: '6000 рублей бурение' },
    );
  }
});

test('expense parser accepts common Russian amount formats and requires a description', () => {
  assert.deepEqual(parseTelegramExpense('6000 рублей пробное бурение'), { amount: 6000, description: 'пробное бурение' });
  assert.deepEqual(parseTelegramExpense('6 000,50 ₽ за доставку'), { amount: 6000.5, description: 'доставку' });
  assert.deepEqual(parseTelegramExpense('пробное бурение 6000 руб.'), { amount: 6000, description: 'пробное бурение' });
  assert.equal(parseTelegramExpense('6000 рублей'), null);
});

test('multi-project user never falls back silently to the newest binding', () => {
  const bindings = [{ project_id: 'project-a' }, { project_id: 'project-b' }];
  assert.equal(selectTelegramBinding(bindings), null);
  assert.equal(selectTelegramBinding(bindings, 'project-b')?.project_id, 'project-b');
  assert.equal(selectTelegramBinding([{ project_id: 'project-a' }])?.project_id, 'project-a');
});

test('group mention detection survives configured @ prefix and Telegram entities', () => {
  const message = {
    text: '@ikioma_bot запиши расход',
    entities: [{ type: 'mention', offset: 0, length: 11 }],
  };
  assert.equal(telegramMessageMentionsBot(message, '@ikioma_bot'), true);
  assert.equal(telegramMessageMentionsBot({ text: 'обычная переписка' }, 'ikioma_bot'), false);
});

test('commands and attachment captions addressed to another bot are ignored', () => {
  const own = commandFromText('/expense@ikioma_bot 6000 бурение');
  const other = commandFromText('/expense@other_bot 6000 бурение');
  assert.equal(telegramCommandTargetsBot(own, 'ikioma_bot'), true);
  assert.equal(telegramCommandTargetsBot(other, 'ikioma_bot'), false);
  assert.equal(other?.body, '6000 бурение');
});

test('task callback key includes project identity for duplicate task ids', () => {
  const taskId = 'auto-stage-foundation';
  const projectA = telegramTaskActionKey('project-a', taskId);
  const projectB = telegramTaskActionKey('project-b', taskId);
  assert.notEqual(projectA, projectB);
  assert.equal(projectA.length, 16);
});

test('project routing and confirmation are isolated by Telegram user, chat and draft project', () => {
  const worker = readFileSync(new URL('../sites/worker.js', import.meta.url), 'utf8');
  const bindings = readFileSync(new URL('../sites/telegram/bindings.js', import.meta.url), 'utf8');
  assert.match(worker, /PRIMARY KEY \(telegram_user_id, chat_id\)/);
  assert.match(worker, /saveTelegramProjectSelection\(env\.DB, telegramUserId, chatId, project\.id\)/);
  assert.match(worker, /bindingForTelegramProject\(env\.DB, telegramUserId, draft\.project_id\)/);
  assert.match(worker, /runClaimedTelegramDraft\(callback, draft, env/);
  assert.match(worker, /status = 'processing'/);
  assert.match(worker, /telegramConfirmVisible/);
  assert.match(worker, /replyAuthor\.username/);
  assert.match(worker, /К какому проекту относится это действие/);
  assert.match(worker, /К какому проекту относится этот файл или отчёт/);
  assert.match(worker, /command\.name === 'expense'/);
  assert.match(worker, /message is not modified/);
  assert.match(bindings, /WHERE code_hash = \? AND used_at IS NULL AND expires_at >= \?/);
  assert.match(bindings, /SET used_at = \?, claim_id = \?/);
  assert.match(bindings, /export const unlinkTelegramBinding/);
  assert.match(worker, /pending: \{ type: 'command', command, sourceMessageId:/);
  assert.match(worker, /await env\.DB\.batch\(\[stateStatement, \.\.\.outboxStatements\]\)/);
  assert.match(worker, /WHERE project_id = \? AND revision = \? AND updated_at = \? AND updated_by = \?/);
});

test('Telegram retries keep the update lease and queue confirmations before closing drafts', () => {
  const worker = readFileSync(new URL('../sites/worker.js', import.meta.url), 'utf8');
  const inbox = readFileSync(new URL('../sites/telegram/inbox.js', import.meta.url), 'utf8');
  assert.match(inbox, /TELEGRAM_UPDATE_LEASE_MS = 360_000/);
  assert.match(inbox, /now\.getTime\(\) - receivedAt <= processingTtlMs/);

  const functionBlock = (name: string, nextName: string) => {
    const start = worker.indexOf(`const ${name} =`);
    const end = worker.indexOf(`const ${nextName} =`, start + 1);
    assert.ok(start >= 0 && end > start, `missing ${name}`);
    return worker.slice(start, end);
  };
  for (const [name, nextName] of [
    ['telegramConfirmTask', 'telegramConfirmNote'],
    ['telegramConfirmNote', 'telegramConfirmExpense'],
    ['telegramConfirmExpense', 'telegramConfirmFile'],
    ['telegramConfirmFile', 'telegramChangeTaskStatus'],
  ]) {
    const block = functionBlock(name, nextName);
    assert.ok(block.indexOf('dispatchNotifications(') < block.indexOf('telegramConfirmVisible('), `${name} must queue notifications first`);
    assert.ok(block.indexOf('requireTelegramVisibility(') < block.indexOf("updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed')"), `${name} must close the draft last`);
    assert.match(block, /`telegram-draft:\$\{draft\.id\}`/);
  }

  const statusBlock = functionBlock('telegramChangeTaskStatus', 'telegramHandleCallback');
  assert.match(statusBlock, /sourceTelegramCallbackId: callback\.id/);
  assert.ok(statusBlock.indexOf('dispatchNotifications(') < statusBlock.indexOf('telegramDurableVisibility('));
  assert.match(statusBlock, /`telegram-task-status:\$\{callback\.id\}`/);
  assert.match(statusBlock, /`telegram-task-status-confirm:\$\{callback\.id\}`/);
});

test('draft claim is atomic, closes once, validates owner/chat and can be released before mutation', async () => {
  const db = new DraftDb();
  const draft = { id: 'draft-1', telegram_user_id: 'user-1', chat_id: 'chat-1', updated_at: db.row.updated_at };
  const claims = await Promise.all([
    claimTelegramDraft(db, draft),
    claimTelegramDraft(db, draft),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  await updateTelegramDraft(db, { ...draft, updated_at: db.row.updated_at }, { amount: 6000 }, 'confirmed');
  assert.equal(db.row.status, 'confirmed');
  await assert.rejects(() => updateTelegramDraft(db, { ...draft, updated_at: db.row.updated_at }, { amount: 6000 }, 'confirmed'), /draft_state_conflict/);

  const canceledDb = new DraftDb();
  const canceledDraft = { ...draft, updated_at: canceledDb.row.updated_at };
  assert.ok(await claimTelegramDraft(canceledDb, canceledDraft));
  await updateTelegramDraft(canceledDb, { ...draft, updated_at: canceledDb.row.updated_at }, {}, 'canceled');
  assert.equal(canceledDb.row.status, 'canceled');

  const releasedDb = new DraftDb();
  const releasedDraft = { ...draft, updated_at: releasedDb.row.updated_at };
  assert.ok(await claimTelegramDraft(releasedDb, releasedDraft));
  await releaseTelegramDraft(releasedDb, { ...draft, updated_at: releasedDb.row.updated_at });
  assert.equal(releasedDb.row.status, 'draft');
  assert.equal(await claimTelegramDraft(releasedDb, { ...draft, telegram_user_id: 'other-user' }), null);
});

test('a retried Telegram message reuses one deterministic draft across project context changes', async () => {
  const db = new DraftCreateDb();
  const first = await createTelegramDraft(db, 'user-1', 'chat-1', 'project-a', 'expense', { amount: 6000 }, 'message-77');
  const second = await createTelegramDraft(db, 'user-1', 'chat-1', 'project-b', 'expense', { amount: 9000 }, 'message-77');
  assert.equal(first.id, second.id);
  assert.equal(second.project_id, 'project-a');
  assert.deepEqual(second.payload, { amount: 6000 });
});

test('a committed Telegram file retry reuses saved metadata without downloading again', async () => {
  let downloads = 0;
  const draft = {
    id: 'draft-file-1',
    kind: 'document',
    payload: { fileName: 'original.pdf', mimeType: 'application/pdf' },
  };
  const state = {
    documents: [{
      id: 'document-telegram-draft-file-1',
      sourceDraftId: 'draft-file-1',
      name: 'Сохранённый документ',
      fileKey: 'project/telegram/draft-file-1-original.pdf',
      fileName: 'original.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1234,
      uploadedAt: '2026-08-14T00:00:00.000Z',
      uploadedBy: 'Виталий',
    }],
  };
  const resolved = await resolveTelegramDraftFile(state, draft, async () => {
    downloads += 1;
    throw new Error('telegram_file_unavailable');
  });
  assert.equal(downloads, 0);
  assert.equal(resolved.existing, true);
  assert.equal(resolved.attachment.key, 'project/telegram/draft-file-1-original.pdf');
  assert.equal(resolved.attachment.name, 'original.pdf');

  const reportResolved = await resolveTelegramDraftFile({
    fieldReports: [{
      id: 'field-report-telegram-draft-report-1',
      sourceDraftId: 'draft-report-1',
      attachments: [{ name: 'photo.jpg', key: 'project/telegram/photo.jpg' }],
    }],
  }, {
    id: 'draft-report-1',
    kind: 'field_report',
    payload: { fileName: 'photo.jpg', mimeType: 'image/jpeg' },
  }, async () => {
    downloads += 1;
    throw new Error('telegram_file_unavailable');
  });
  assert.equal(downloads, 0);
  assert.equal(reportResolved.existing, true);
  assert.equal(reportResolved.attachment.key, 'project/telegram/photo.jpg');

  const fresh = await resolveTelegramDraftFile({ documents: [] }, draft, async () => {
    downloads += 1;
    return { name: 'downloaded.pdf' };
  });
  assert.equal(downloads, 1);
  assert.equal(fresh.existing, false);
  assert.equal(fresh.attachment.name, 'downloaded.pdf');
});

test('parallel outbox flushes claim one delivery and never send a duplicate', async () => {
  const db = new OutboxDb();
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async () => {
    sends += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: sends } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const results = await Promise.all([
      flushTelegramOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }),
      flushTelegramOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' }),
    ]);
    assert.equal(sends, 1);
    assert.equal(results.reduce((sum, item) => sum + item.delivered, 0), 1);
    assert.equal(db.row.status, 'sent');
    assert.equal(db.row.attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fresh pending outbox message is not starved by more than fifty failed rows in backoff', async () => {
  const db = new BacklogOutboxDb();
  const originalFetch = globalThis.fetch;
  const chats: string[] = [];
  globalThis.fetch = async (_url, init) => {
    chats.push(String(JSON.parse(String(init?.body)).chat_id));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await flushTelegramOutbox({ DB: db, TELEGRAM_BOT_TOKEN: 'token' });
    assert.deepEqual(chats, ['healthy-chat']);
    assert.equal(result.delivered, 1);
    assert.equal(db.rows.find((row) => row.id === 'fresh-pending')?.status, 'sent');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
