import assert from 'node:assert/strict';
import test from 'node:test';
import { claimTelegramUpdate } from '../sites/worker.js';

type UpdateRow = {
  status: string;
  received_at: string;
  processed_at: string | null;
  error: string | null;
};

class TelegramUpdateDatabase {
  rows = new Map<string, UpdateRow>();

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (normalized.startsWith('INSERT INTO telegram_updates')) {
            const [updateId, receivedAt] = values.map(String);
            if (this.rows.has(updateId)) return { changes: 0, meta: { changes: 0 } };
            this.rows.set(updateId, { status: 'processing', received_at: receivedAt, processed_at: null, error: null });
            return { changes: 1, meta: { changes: 1 } };
          }
          if (normalized.startsWith('UPDATE telegram_updates')) {
            if (normalized.includes("status = 'error'")) {
              const [receivedAt, updateId] = values.map(String);
              const row = this.rows.get(updateId);
              if (!row || row.status !== 'error') return { changes: 0, meta: { changes: 0 } };
              this.rows.set(updateId, { status: 'processing', received_at: receivedAt, processed_at: null, error: null });
              return { changes: 1, meta: { changes: 1 } };
            }
            const [receivedAt, updateId, expectedReceivedAt] = values.map(String);
            const expectedStatus = 'processing';
            const row = this.rows.get(updateId);
            if (!row || row.status !== expectedStatus || row.received_at !== expectedReceivedAt) {
              return { changes: 0, meta: { changes: 0 } };
            }
            this.rows.set(updateId, { status: 'processing', received_at: receivedAt, processed_at: null, error: null });
            return { changes: 1, meta: { changes: 1 } };
          }
          throw new Error(`Unexpected run SQL: ${normalized}`);
        },
        first: async () => {
          if (!normalized.startsWith('SELECT status, received_at FROM telegram_updates')) {
            throw new Error(`Unexpected first SQL: ${normalized}`);
          }
          return this.rows.get(String(values[0])) ?? null;
        },
      }),
    };
  }
}

const now = new Date('2026-08-14T12:00:00.000Z');

test('first Telegram delivery atomically claims its update id', async () => {
  const db = new TelegramUpdateDatabase();
  const result = await claimTelegramUpdate(db, '101', { now });
  assert.equal(result, now.toISOString());
  assert.equal(db.rows.get('101')?.status, 'processing');
});

test('active and completed Telegram deliveries are treated as duplicates', async () => {
  const db = new TelegramUpdateDatabase();
  await claimTelegramUpdate(db, '102', { now });
  assert.equal(await claimTelegramUpdate(db, '102', { now: new Date(now.getTime() + 30_000) }), null);
  const row = db.rows.get('102');
  assert.ok(row);
  row.status = 'done';
  assert.equal(await claimTelegramUpdate(db, '102', { now: new Date(now.getTime() + 60_000) }), null);
});

test('failed Telegram delivery can be claimed for retry', async () => {
  const db = new TelegramUpdateDatabase();
  db.rows.set('103', { status: 'error', received_at: '2026-08-14T11:59:00.000Z', processed_at: '2026-08-14T11:59:01.000Z', error: 'processing_failed' });
  const result = await claimTelegramUpdate(db, '103', { now });
  assert.equal(result, now.toISOString());
  assert.deepEqual(db.rows.get('103'), { status: 'processing', received_at: now.toISOString(), processed_at: null, error: null });
});

test('stale processing delivery can be reclaimed but only once', async () => {
  const db = new TelegramUpdateDatabase();
  db.rows.set('104', { status: 'processing', received_at: '2026-08-14T11:55:00.000Z', processed_at: null, error: null });
  assert.equal(await claimTelegramUpdate(db, '104', { now, processingTtlMs: 120_000 }), now.toISOString());
  assert.equal(await claimTelegramUpdate(db, '104', { now, processingTtlMs: 120_000 }), null);
});
