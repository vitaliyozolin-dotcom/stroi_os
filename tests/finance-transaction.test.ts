import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase } from '../server/postgres.js';
import { validatePortfolioWrite } from '../src/domain/finance-portfolio.js';

const fakeDatabase = (rejectCommit = false) => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = { query: async (sql: string, values?: unknown[]) => { calls.push({ sql, values }); if (rejectCommit && sql === 'COMMIT') throw Error('commit failed'); return { rows: [{ id: 'saved' }], rowCount: 1 }; }, release: () => calls.push({ sql: 'RELEASE' }) };
  const database = Object.create(PostgresDatabase.prototype); database.pool = { connect: async () => client };
  return { database, calls };
};

test('financial lock, read and batch mutation use one transaction connection without nested commits', async () => {
  const { database, calls } = fakeDatabase();
  const response = await database.financialTransaction(async db => {
    await db.prepare('SELECT value FROM project_state WHERE project_id = ?').bind('p').first();
    await db.batch([db.prepare('UPDATE project_state SET value = ? WHERE project_id = ?').bind('new', 'p')]);
    return new Response('{}', { status: 200 });
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map(call => call.sql), ['BEGIN', 'SELECT pg_advisory_xact_lock(731104, 280026)', 'SELECT value FROM project_state WHERE project_id = $1', 'UPDATE project_state SET value = $1 WHERE project_id = $2', 'COMMIT', 'RELEASE']);
  assert.deepEqual(calls[3].values, ['new', 'p']);
});

test('validation responses and failed commits roll back and release the financial lock', async () => {
  const failed = fakeDatabase(); await failed.database.financialTransaction(async () => new Response('{}', { status: 422 }));
  assert.deepEqual(failed.calls.slice(-2).map(call => call.sql), ['ROLLBACK', 'RELEASE']);
  const commit = fakeDatabase(true);
  await assert.rejects(commit.database.financialTransaction(async () => new Response('{}')), /commit failed/);
  assert.deepEqual(commit.calls.slice(-3).map(call => call.sql), ['COMMIT', 'ROLLBACK', 'RELEASE']);
});

test('PostgreSQL serializes two shared allocation checks so only one overcommitting project can be saved', { skip: !process.env.AUTH_TEST_DATABASE_URL }, async () => {
  const connection = process.env.AUTH_TEST_DATABASE_URL!;
  assert.equal(new URL(connection).pathname, '/stroios_auth_test');
  const database = new PostgresDatabase(connection), table = `finance_race_${process.pid}_${Date.now()}`;
  try {
    await database.pool.query(`CREATE TABLE ${table} (project_id text PRIMARY KEY, state_json text NOT NULL)`);
    const write = id => database.financialTransaction(async db => {
      const state = { project: { id }, treasury: { accounts: [{ id: 'bank', sharedAccountKey: 'one-bank', isProjectDedicated: false, legalEntityId: 'company', currency: 'RUB', projectAllocationCents: 6000, opening: { asOf: '2026-10-28', amountCents: 10000, confirmed: true } }] } };
      const others = await db.prepare(`SELECT state_json FROM ${table}`).all();
      const error = validatePortfolioWrite(null, state, others.results.map(row => JSON.parse(row.state_json)));
      if (error) return new Response(error, { status: 422 });
      await db.batch([db.prepare(`INSERT INTO ${table}(project_id, state_json) VALUES (?, ?)`).bind(id, JSON.stringify(state))]);
      return new Response('{}');
    });
    const responses = await Promise.all([write('a'), write('b')]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 422]);
    assert.equal((await database.pool.query(`SELECT * FROM ${table}`)).rowCount, 1);
  } finally { await database.pool.query(`DROP TABLE IF EXISTS ${table}`); await database.close(); }
});
