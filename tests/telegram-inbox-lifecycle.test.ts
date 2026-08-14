import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeTelegramUpdate,
  failTelegramUpdate,
  readTelegramUpdateStatus,
} from '../sites/telegram/inbox.js';

class InboxDatabase {
  row = {
    update_id: 'update-1',
    status: 'processing',
    received_at: '2026-08-14T12:00:00.000Z',
    processed_at: null as string | null,
    error: null as string | null,
  };

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    return {
      bind: (...values: unknown[]) => ({
        first: async () => (
          String(values[0]) === this.row.update_id
            ? { status: this.row.status, received_at: this.row.received_at }
            : null
        ),
        run: async () => {
          if (normalized.includes("SET status = 'done'")) {
            const [processedAt, updateId, lease] = values.map(String);
            if (updateId !== this.row.update_id || this.row.status !== 'processing' || lease !== this.row.received_at) return { changes: 0 };
            this.row.status = 'done';
            this.row.processed_at = processedAt;
            this.row.error = null;
            return { changes: 1 };
          }
          if (normalized.includes("SET status = 'error'")) {
            const [processedAt, error, updateId, lease] = values.map(String);
            if (updateId !== this.row.update_id || this.row.status !== 'processing' || lease !== this.row.received_at) return { changes: 0 };
            this.row.status = 'error';
            this.row.processed_at = processedAt;
            this.row.error = error;
            return { changes: 1 };
          }
          throw new Error(`Unexpected SQL: ${normalized}`);
        },
      }),
    };
  }
}

const completedAt = new Date('2026-08-14T12:01:00.000Z');

test('only the current Telegram inbox lease can complete an update', async () => {
  const db = new InboxDatabase();
  assert.equal(await readTelegramUpdateStatus(db, 'update-1'), 'processing');
  assert.equal(await completeTelegramUpdate(db, 'update-1', 'stale-lease', { now: completedAt }), false);
  assert.equal(db.row.status, 'processing');
  assert.equal(await completeTelegramUpdate(db, 'update-1', db.row.received_at, { now: completedAt }), true);
  assert.equal(db.row.status, 'done');
  assert.equal(db.row.processed_at, completedAt.toISOString());
});

test('only the current Telegram inbox lease can record a bounded failure', async () => {
  const db = new InboxDatabase();
  assert.equal(await failTelegramUpdate(db, 'update-1', 'stale-lease', new Error('temporary'), { now: completedAt }), false);
  assert.equal(await failTelegramUpdate(db, 'update-1', db.row.received_at, new Error('temporary'), { now: completedAt }), true);
  assert.equal(db.row.status, 'error');
  assert.equal(db.row.error, 'temporary');
  assert.equal(db.row.processed_at, completedAt.toISOString());
});
