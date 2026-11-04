import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PostgresDatabase } from '../server/postgres.js';
import { ensureSchema } from '../sites/runtime/initialization.js';
import { createOrderDirectoryHandler } from '../sites/orders/directory.js';
import { createSharedPaymentHandler } from '../sites/projects/shared-payment.js';
import { createProjectWriteHandler } from '../sites/projects/write.js';
import { readSnapshot } from '../sites/projects/snapshot.js';
import { applyBattleAutomations } from '../sites/automations/battle.js';
import { createDraftOrderState, seedState } from '../src/seed.ts';
import { emptyFinanceLedger, ledgerEffect, ledgerEntryBalance } from '../src/domain/finance-ledger.js';
import type { AppState, OrderDirectoryResponse, SharedPaymentInput } from '../src/entities/index.ts';

const connectionString = process.env.AUTH_TEST_DATABASE_URL || '';
const ownerHeaders = { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' };
const now = '2024-01-01T12:00:00.000Z';

const financeState = (id: string, allocationCents: number): AppState => ({
  ...structuredClone(seedState),
  project: { ...seedState.project, id, code: id, name: `Synthetic PostgreSQL order ${id}`, status: 'active' },
  documents: [],
  financeEntries: [{ id: `entry-${id}`, kind: 'expense', status: 'committed', amount: 400000,
    date: '2024-01-01', dueDate: '2024-01-04', description: 'Synthetic materials', counterparty: 'Synthetic supplier',
    approvedAt: now, approvedBy: 'Owner' }],
  financeLedger: emptyFinanceLedger(),
  treasury: { version: 1, enabled: true, accounts: [{ id: `account-${id}`, name: 'Synthetic shared bank account',
    currency: 'RUB', legalEntityId: 'company', isProjectDedicated: false, sharedAccountKey: 'same-bank',
    opening: { asOf: '2024-01-01', amountCents: 100000000, confirmed: true, source: 'Synthetic opening evidence' },
    restrictedCents: 0, projectAllocationCents: allocationCents }],
    entryPlans: [{ entryId: `entry-${id}`, sourceAccountId: `account-${id}`, source: 'Synthetic contract', tranches: [] }], costEstimates: [] },
});

const paymentInput = (id = 'pg-shared-payment', revision = 1, firstCents = 20000000, secondCents = 10000000): SharedPaymentInput => ({
  id, sourceKey: `synthetic-source:${id}`, kind: 'payment', date: '2024-01-02', amountCents: firstCents + secondCents,
  currency: 'RUB', legalEntityId: 'company', sharedAccountKey: 'same-bank', payer: 'Synthetic company', payee: 'Synthetic supplier',
  description: 'One synthetic payment attributed to two orders', source: 'Synthetic verified payment order', sourceReference: id,
  confirmation: 'confirmed', cashTreatment: 'account',
  expected: [{ projectId: 'first', revision }, { projectId: 'second', revision }],
  allocations: [{ projectId: 'first', accountId: 'account-first', entryId: 'entry-first', amountCents: firstCents },
    { projectId: 'second', accountId: 'account-second', entryId: 'entry-second', amountCents: secondCents }],
});

/**
 * Opt-in PostgreSQL gate. Nothing connects without AUTH_TEST_DATABASE_URL, and
 * no DDL runs unless both the URL and server identify the disposable auth DB.
 * Only this run's generated schema is ever created or dropped; public is excluded
 * from the application's search_path, including every transaction pool client.
 */
test('PostgreSQL customer-order APIs preserve isolated drafts, CAS, exactly-once payments and atomic audit', {
  skip: !connectionString,
  timeout: 60_000,
}, async t => {
  let parsed: URL;
  try { parsed = new URL(connectionString); }
  catch { throw new Error('AUTH_TEST_DATABASE_URL must be a valid PostgreSQL URL for stroios_auth_test'); }
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'Use a PostgreSQL connection URL');
  assert.equal(parsed.pathname, '/stroios_auth_test', 'This test may connect only to the disposable stroios_auth_test database');

  const schema = `ikioma_orders_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^ikioma_orders_[0-9]+_[a-f0-9]{32}$/);
  const control = new PostgresDatabase(connectionString);
  let database: PostgresDatabase | undefined;
  let createdOwnSchema = false;
  try {
    const connectedDatabase = (await control.pool.query('SELECT current_database() AS database_name')).rows[0].database_name;
    assert.equal(connectedDatabase, 'stroios_auth_test', 'Refusing all schema mutations outside the disposable test database');
    await control.pool.query(`CREATE SCHEMA "${schema}"`);
    createdOwnSchema = true;

    const scopedUrl = new URL(parsed);
    scopedUrl.searchParams.set('options', `-c search_path=${schema} -c statement_timeout=15000 -c lock_timeout=10000`);
    scopedUrl.searchParams.set('application_name', 'ikioma_customer_orders_pg_test');
    database = new PostgresDatabase(scopedUrl.toString());
    // At least two real server sessions are needed to exercise the advisory lock.
    // This affects only this private pool, never process-wide environment settings.
    database.pool.options.max = Math.max(4, Number(database.pool.options.max) || 4);
    const db = database;
    const context = (await db.pool.query('SELECT current_schema() AS schema_name, current_database() AS database_name')).rows[0];
    assert.deepEqual(context, { schema_name: schema, database_name: 'stroios_auth_test' });
    await ensureSchema(db);
    await ensureSchema(db); // The real initializer is safe to call again.
    assert.equal((await db.prepare('SELECT value FROM system_meta WHERE key = ?').bind('battle_schema_version').first())?.value, '18');

    const seed = [financeState('first', 60000000), financeState('second', 30000000)];
    for (const state of seed) await db.prepare(`INSERT INTO project_state
      (project_id, state_json, revision, created_at, updated_at, updated_by, updated_role)
      VALUES (?, ?, 1, ?, ?, ?, ?)`)
      .bind(state.project.id, JSON.stringify(state), now, now, 'Owner', 'management').run();
    const env = { DB: db, OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Owner' };
    const directory = createOrderDirectoryHandler({ ensureSchema });
    const payments = createSharedPaymentHandler({ ensureSchema });
    const pendingDispatches: Promise<unknown>[] = [];
    const write = createProjectWriteHandler({ ensureSchema, readSnapshot,
      changes: (result: { changes?: number; meta?: { changes?: number } }) => Number(result?.meta?.changes ?? result?.changes ?? 0),
      applyAutomations: applyBattleAutomations,
      // Exercise the real state transaction while keeping this test entirely offline.
      buildNotificationPlan: async () => ({ deliveries: [] }), dispatchNotifications: async () => {},
    });
    const sendDirectory = (recordName: string, expectedRevision: number, recordId = 'pg-party') => directory(new Request(
      'https://example.test/api/order-directory?projectId=first', {
        method: 'POST', headers: ownerHeaders,
        body: JSON.stringify({ record: { id: recordId, kind: 'party', data: { name: recordName, partyType: 'person' } }, expectedRevision, reason: 'Synthetic verified contact update' }),
      }), env);
    const sendPayment = (body: SharedPaymentInput) => payments(new Request('https://example.test/api/finance/shared-payments?projectId=first', {
      method: 'POST', headers: ownerHeaders, body: JSON.stringify(body),
    }), env);
    const putDraft = (state: AppState) => write(new Request(`https://example.test/api/state?projectId=${state.project.id}`, {
      method: 'PUT', headers: ownerHeaders,
      body: JSON.stringify({ projectId: state.project.id, expectedRevision: 0, state, action: 'project_created', summary: 'Synthetic new customer order' }),
    }), env, { waitUntil: (promise: Promise<unknown>) => { pendingDispatches.push(promise); } });
    const ok = async (response: Response) => {
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const count = async (table: string) => {
      assert.ok(['project_state', 'audit_log', 'order_directory_records', 'order_directory_audit', 'shared_payment_records', 'shared_payment_project_shares', 'telegram_outbox'].includes(table));
      return Number((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count);
    };
    const readFinancialOrders = async () => Promise.all(['first', 'second'].map(async id => (await readSnapshot(db, id)).state as AppState));
    const footprint = async () => {
      const tables = [
        ['project_state', 'project_id'], ['audit_log', 'id'], ['order_directory_records', 'id'], ['order_directory_audit', 'id'],
        ['shared_payment_records', 'id'], ['shared_payment_project_shares', 'payment_id, project_id'], ['telegram_outbox', 'id'],
      ];
      const result: Record<string, unknown[]> = {};
      for (const [table, order] of tables) result[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()).results;
      return result;
    };

    await t.test('real directory INSERT, CAS UPDATE, concurrent writers and audit preserve one canonical record', async () => {
      const created = await ok(await sendDirectory('Initial PostgreSQL customer', 0)) as OrderDirectoryResponse;
      assert.equal(created.records[0].revision, 1);
      const updated = await ok(await sendDirectory('Verified PostgreSQL customer', 1)) as OrderDirectoryResponse;
      assert.equal(updated.records[0].revision, 2);
      const beforeStale = await footprint();
      assert.equal((await sendDirectory('Stale overwrite', 1)).status, 409);
      assert.deepEqual(await footprint(), beforeStale);
      const outcomes = await Promise.all([sendDirectory('Concurrent customer A', 2), sendDirectory('Concurrent customer B', 2)]);
      assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
      assert.equal(await count('order_directory_records'), 1); assert.equal(await count('order_directory_audit'), 3);
      assert.equal((await db.prepare('SELECT revision FROM order_directory_records WHERE id = ?').bind('pg-party').first()).revision, 3);
      // Stored project snapshots use JSON, which omits optional undefined fields.
      assert.deepEqual(await readFinancialOrders(), JSON.parse(JSON.stringify(seed)));
    });

    await t.test('two successive empty drafts reuse the canonical customer and lost-response retries return the existing snapshot', async () => {
      const canonicalName = JSON.parse((await db.prepare('SELECT payload_json FROM order_directory_records WHERE id = ?').bind('pg-party').first()).payload_json).name;
      const drafts = ['DRAFT-A', 'DRAFT-B'].map(code => createDraftOrderState(seed[0], {
        code, name: `Synthetic draft ${code}`, actor: 'Owner', customerId: 'pg-party', customerName: 'Stale cached display name',
      }));
      assert.notEqual(drafts[0].project.id, drafts[1].project.id);
      assert.ok(drafts.every(state => state.project.creationRequestId));
      assert.notEqual(drafts[0].project.creationRequestId, drafts[1].project.creationRequestId);
      for (const draft of drafts) {
        const created = await ok(await putDraft(draft)) as { snapshot: { projectId: string; revision: number; state: AppState } };
        assert.equal(created.snapshot.projectId, draft.project.id); assert.equal(created.snapshot.revision, 1);
        assert.equal(created.snapshot.state.project.creationRequestId, draft.project.creationRequestId);
        assert.equal(created.snapshot.state.project.clientNames, canonicalName);
        assert.equal(created.snapshot.state.orderRelations!.customerId, 'pg-party');
        assert.equal(created.snapshot.state.project.status, 'draft');
        assert.deepEqual(created.snapshot.state.project.unknownFields, ['area', 'contractValue', 'targetCost']);
        for (const key of ['stages', 'financeEntries', 'budgetLines', 'documents', 'tasks'] as const) assert.deepEqual(created.snapshot.state[key], []);
      }
      const saved = await footprint();
      for (const draft of drafts) {
        const retry = await putDraft(draft); assert.equal(retry.status, 409, await retry.clone().text());
        const body = await retry.json() as { error: string; current: { projectId: string; revision: number; state: AppState } };
        assert.equal(body.error, 'revision_conflict'); assert.equal(body.current.projectId, draft.project.id); assert.equal(body.current.revision, 1);
        assert.equal(body.current.state.project.creationRequestId, draft.project.creationRequestId);
      }
      assert.deepEqual(await footprint(), saved); assert.equal(await count('project_state'), 4); assert.equal(await count('audit_log'), 2);
      await Promise.all(pendingDispatches);
    });

    await t.test('concurrent retries record one 300000 RUB payment, exactly 200000 and 100000 RUB shares and one audit per order', async () => {
      const input = paymentInput();
      const responses = await Promise.all([sendPayment(input), sendPayment(structuredClone(input))]);
      const results = await Promise.all(responses.map(ok)) as { replayed: boolean; payment: { principal: { amountCents: number } } }[];
      assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
      assert.ok(results.every(result => result.payment.principal.amountCents === 30000000));
      assert.equal(await count('shared_payment_records'), 1); assert.equal(await count('shared_payment_project_shares'), 2);
      assert.equal(await count('audit_log'), 4); // Two draft audits plus two financial project audits.
      const states = await readFinancialOrders();
      assert.deepEqual(states.map(state => state.financeLedger!.operations[0].amountCents), [20000000, 10000000]);
      assert.equal(states.flatMap(state => ledgerEffect(state).cashMovements).reduce((sum, movement) => sum + movement.outflowCents, 0), 30000000);
      assert.deepEqual(states.map(state => ledgerEntryBalance(state, `entry-${state.project.id}`)!.remainingCents), [20000000, 30000000]);
      for (let index = 0; index < states.length; index++) {
        assert.deepEqual(states[index].financeEntries, seed[index].financeEntries);
        assert.deepEqual(states[index].treasury, seed[index].treasury);
        assert.equal(states[index].financeLedger!.operations.length, 1);
        assert.equal(states[index].financeLedger!.history!.length, 1);
      }
      assert.deepEqual((await db.prepare('SELECT project_id, revision FROM project_state WHERE project_id IN (?, ?) ORDER BY project_id').bind('first', 'second').all()).results,
        [{ project_id: 'first', revision: 2 }, { project_id: 'second', revision: 2 }]);
    });

    await t.test('competing payments with the same expected project revisions cannot both commit', async () => {
      const first = paymentInput('competing-a', 2, 20000, 10000), second = paymentInput('competing-b', 2, 20000, 10000);
      const outcomes = await Promise.all([sendPayment(first), sendPayment(second)]);
      assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 409]);
      const losing = outcomes.find(response => response.status === 409)!;
      assert.equal((await losing.json() as { error: string }).error, 'revision_conflict');
      assert.equal(await count('shared_payment_records'), 2); assert.equal(await count('shared_payment_project_shares'), 4); assert.equal(await count('audit_log'), 6);
      const states = await readFinancialOrders();
      assert.equal(states.flatMap(state => ledgerEffect(state).cashMovements).reduce((sum, movement) => sum + movement.outflowCents, 0), 30030000);
      assert.ok(states.every(state => state.financeLedger!.operations.length === 2));
      for (const id of ['first', 'second']) assert.equal((await readSnapshot(db, id)).revision, 3);
    });

    await t.test('an actual PostgreSQL audit trigger failure rolls back masters, shares, project snapshots, directory and outbox', async () => {
      const before = await footprint();
      await db.pool.query(`CREATE FUNCTION "${schema}".reject_customer_order_audit() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN RAISE EXCEPTION 'synthetic_customer_order_audit_failure'; END;
      $body$`);
      await db.pool.query(`CREATE TRIGGER reject_project_audit BEFORE INSERT ON "${schema}".audit_log
        FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_customer_order_audit()`);
      await db.pool.query(`CREATE TRIGGER reject_directory_audit BEFORE INSERT ON "${schema}".order_directory_audit
        FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_customer_order_audit()`);
      const failedPayment = await sendPayment(paymentInput('audit-failure-payment', 3, 6000, 4000));
      assert.equal(failedPayment.status, 500, await failedPayment.clone().text());
      assert.deepEqual(await footprint(), before);
      const failedDirectory = await sendDirectory('Must roll back', 0, 'audit-failure-party');
      assert.equal(failedDirectory.status, 500, await failedDirectory.clone().text());
      assert.deepEqual(await footprint(), before);
      const retryableDraft = createDraftOrderState(seed[0], { code: 'RETRY', name: 'Synthetic retry after failed commit', actor: 'Owner', customerId: 'pg-party' });
      const failedDraft = await putDraft(retryableDraft);
      assert.equal(failedDraft.status, 500, await failedDraft.clone().text());
      assert.deepEqual(await footprint(), before);
      await db.pool.query(`DROP TRIGGER reject_project_audit ON "${schema}".audit_log`);
      await db.pool.query(`DROP TRIGGER reject_directory_audit ON "${schema}".order_directory_audit`);
      const recovered = await ok(await putDraft(retryableDraft)) as { snapshot: { revision: number; state: AppState } };
      assert.equal(recovered.snapshot.revision, 1);
      assert.equal(recovered.snapshot.state.project.creationRequestId, retryableDraft.project.creationRequestId);
      assert.equal(await count('shared_payment_records'), 2); assert.equal(await count('shared_payment_project_shares'), 4);
      assert.equal(await count('order_directory_records'), 1); assert.equal(await count('order_directory_audit'), 3);
      assert.equal(await count('audit_log'), 7); assert.equal(await count('telegram_outbox'), 0);
      await Promise.all(pendingDispatches);
    });
  } finally {
    // Close scoped sessions before dropping ONLY the schema this run created.
    try { if (database) await database.close(); }
    finally {
      try { if (createdOwnSchema) await control.pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await control.close(); }
    }
  }
});
