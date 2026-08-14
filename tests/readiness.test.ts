import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { battleReadiness } from '../sites/worker.js';

class ReadOnlyDb {
  reads = 0;
  writes = 0;
  battleMarker: string | null;
  schemaMarker: string | null;

  constructor(battleMarker: string | null, schemaMarker: string | null = '17') {
    this.battleMarker = battleMarker;
    this.schemaMarker = schemaMarker;
  }

  prepare(sql: string) {
    assert.match(sql, /^\s*SELECT value FROM system_meta/);
    return {
      bind: (key: string) => ({
        first: async () => {
          this.reads += 1;
          assert.ok(['battle_v17_reset', 'battle_schema_version'].includes(key));
          const marker = key === 'battle_v17_reset' ? this.battleMarker : this.schemaMarker;
          return marker == null ? null : { value: marker };
        },
        run: async () => {
          this.writes += 1;
          throw new Error('readiness attempted a write');
        },
      }),
    };
  }
}

test('readiness is repeatable and never mutates storage', async () => {
  const db = new ReadOnlyDb('done');
  const buildSha = 'a'.repeat(40);

  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(await battleReadiness({ DB: db, BUILD_SHA: buildSha }), {
      ok: true,
      database: true,
      schemaVersion: 17,
      schemaReady: true,
      battleReady: true,
      buildSha,
    });
  }

  assert.equal(db.reads, 20);
  assert.equal(db.writes, 0);
});

test('readiness fails closed when manual initialization is absent', async () => {
  const db = new ReadOnlyDb(null);
  assert.deepEqual(await battleReadiness({ DB: db, BUILD_SHA: '' }), {
    ok: false,
    database: true,
    schemaVersion: 17,
    schemaReady: true,
    battleReady: false,
    buildSha: 'unknown',
  });
  assert.equal(db.writes, 0);
});

test('readiness fails closed when the schema marker is absent or stale', async () => {
  for (const schemaMarker of [null, '16']) {
    const db = new ReadOnlyDb('done', schemaMarker);
    const result = await battleReadiness({ DB: db, BUILD_SHA: 'c'.repeat(40) });
    assert.equal(result.ok, false);
    assert.equal(result.database, true);
    assert.equal(result.battleReady, true);
    assert.equal(result.schemaReady, false);
    assert.equal(db.writes, 0);
  }
});

test('readiness HTTP endpoints report 200/503 without running initialization', async () => {
  const readyDb = new ReadOnlyDb('done');
  const missingDb = new ReadOnlyDb(null);
  const buildSha = 'b'.repeat(40);

  for (const path of ['/api/readiness', '/api/health']) {
    const ready = await worker.fetch(
      new Request(`https://example.test${path}`),
      { DB: readyDb, BUILD_SHA: buildSha },
      {},
    );
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).buildSha, buildSha);

    const missing = await worker.fetch(
      new Request(`https://example.test${path}`),
      { DB: missingDb, BUILD_SHA: buildSha },
      {},
    );
    assert.equal(missing.status, 503);
  }
  assert.equal(readyDb.writes, 0);
  assert.equal(missingDb.writes, 0);
});
