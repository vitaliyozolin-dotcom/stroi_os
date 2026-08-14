import assert from 'node:assert/strict';
import test from 'node:test';

import { claimPublicLeadRateLimit } from '../sites/worker.js';

class RateLimitDb {
  rows = new Map<string, { attempts: number; updatedAt: string }>();

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (sql.includes('DELETE FROM public_lead_rate_limits')) {
            const expiredBefore = String(args[0]);
            for (const key of this.rows.keys()) {
              if (key.split('|')[1] < expiredBefore) this.rows.delete(key);
            }
            return { changes: 0 };
          }
          const [key, windowStart, updatedAt] = args.map(String);
          const rowKey = `${key}|${windowStart}`;
          const current = this.rows.get(rowKey);
          this.rows.set(rowKey, { attempts: (current?.attempts ?? 0) + 1, updatedAt });
          return { changes: 1 };
        },
        first: async () => {
          const row = this.rows.get(`${String(args[0])}|${String(args[1])}`);
          return row ? { attempts: row.attempts } : null;
        },
      }),
    };
  }
}

test('public leads are limited per trusted client without storing its raw address', async () => {
  const db = new RateLimitDb();
  const now = Date.parse('2026-08-14T12:00:10.000Z');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await claimPublicLeadRateLimit(db, '203.0.113.7', now)).allowed, true);
  }
  assert.deepEqual(await claimPublicLeadRateLimit(db, '203.0.113.7', now), {
    allowed: false,
    retryAfter: 50,
    scope: 'client',
  });
  assert.equal([...db.rows.keys()].some((key) => key.includes('203.0.113.7')), false);
  assert.equal((await claimPublicLeadRateLimit(db, '203.0.113.8', now)).allowed, true);
});

test('public leads have a global ceiling and reset in the next time window', async () => {
  const db = new RateLimitDb();
  const now = Date.parse('2026-08-14T12:00:10.000Z');

  for (let attempt = 0; attempt < 30; attempt += 1) {
    assert.equal((await claimPublicLeadRateLimit(db, `198.51.100.${attempt}`, now)).allowed, true);
  }
  assert.deepEqual(await claimPublicLeadRateLimit(db, '192.0.2.1', now), {
    allowed: false,
    retryAfter: 50,
    scope: 'global',
  });
  assert.equal((await claimPublicLeadRateLimit(db, '192.0.2.1', now + 60_000)).allowed, true);
});
