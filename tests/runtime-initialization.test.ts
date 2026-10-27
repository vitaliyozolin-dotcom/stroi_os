import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ensureSchema, initializeBattleRuntime, BATTLE_RESET_KEY } from '../sites/runtime/initialization.js';

test('installed deployment gate reads the actual runtime marker after module extraction', () => {
  const worker = readFileSync(new URL('../sites/worker.js', import.meta.url), 'utf8');
  const marker = execFileSync('sed', ['-n', "s/^const BATTLE_RESET_KEY = '\\([^']*\\)';$/\\1/p"], { input: worker, encoding: 'utf8' }).trim();
  assert.equal(marker, BATTLE_RESET_KEY);
  assert.match(marker, /^[A-Za-z0-9_-]{1,80}$/);
  assert.match(worker, /BATTLE_RESET_KEY !== RUNTIME_BATTLE_RESET_KEY/);
});

test('initialization retries schema failure, never seeds business records and requires manual readiness', async () => {
  let fail = true;
  let ready = false;
  const statements: string[] = [];
  const db = { prepare: (sql: string) => {
    statements.push(sql);
    const statement = {
      bind: (...values: string[]) => ({
        run: async () => {
          assert.deepEqual(values.slice(0, 2), ['battle_schema_version', '17']);
        },
        first: async () => ({ value: values[0] === 'battle_schema_version' ? '17' : ready ? 'done' : null }),
      }),
      run: async () => {
        if (fail && sql.includes('CREATE TABLE IF NOT EXISTS project_state')) throw new Error('schema_failed');
        if (sql.startsWith('ALTER TABLE')) throw new Error('duplicate column');
      },
    };
    return statement;
  } };
  await assert.rejects(() => initializeBattleRuntime({ DB: db }), /schema_failed/);
  fail = false;
  await assert.rejects(() => initializeBattleRuntime({ DB: db }), /battle_manual_initialization_required/);
  assert.equal(statements.filter(sql => sql.includes('CREATE TABLE IF NOT EXISTS project_state')).length, 2);
  ready = true;
  await initializeBattleRuntime({ DB: db });
  const count = statements.length;
  await Promise.all([ensureSchema(db), initializeBattleRuntime({ DB: db })]);
  assert.equal(statements.length, count);
  for (const sql of statements.filter(sql => /INSERT|UPDATE|DELETE/.test(sql) && !sql.includes('CREATE TABLE'))) {
    assert.match(sql, /INSERT INTO system_meta/);
    assert.doesNotMatch(sql, /project_state|audit_log|lead_inbox/);
  }
});
