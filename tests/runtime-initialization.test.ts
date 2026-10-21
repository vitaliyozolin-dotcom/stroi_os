import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureSchema, initializeBattleRuntime } from '../sites/runtime/initialization.js';

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
