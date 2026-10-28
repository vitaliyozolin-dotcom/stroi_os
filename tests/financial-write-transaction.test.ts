import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectWriteHandler } from '../sites/projects/write.js';
import { seedState } from '../src/seed.ts';
import { emptyFinanceLedger } from '../src/domain/finance-ledger.js';

const headers = { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' };
const requestFor = (state: unknown, revision = 0) => new Request('https://example.test/api/state?projectId=project-1', { method: 'PUT', headers, body: JSON.stringify({ projectId: 'project-1', expectedRevision: revision, state }) });
const minimal = () => ({ version: 1, project: { id: 'project-1' }, settings: { users: [] } });
const database = () => ({ prepare: () => ({ bind: () => ({}) }), batch: async () => [{ meta: { changes: 1 } }] });
const handlerFor = (overrides: Record<string, unknown> = {}) => createProjectWriteHandler({ ensureSchema: async () => {}, readSnapshot: async () => null, changes: (result: { meta?: { changes?: number } }) => result?.meta?.changes ?? 0, applyAutomations: (_before: unknown, state: unknown) => state, buildNotificationPlan: async () => ({ deliveries: [] }), dispatchNotifications: async () => {}, ...overrides });

test('notifications start after financial COMMIT and use the original database pool', async () => {
  const order: string[] = [], scoped = database();
  const db = { ...database(), financialTransaction: async (work: (db: unknown) => Promise<Response>) => {
    order.push('begin'); const response = await work(scoped); assert.deepEqual(order, ['begin']); order.push('commit'); return response;
  } };
  const tasks: Promise<unknown>[] = [];
  const handler = handlerFor({ dispatchNotifications: async (_before: unknown, _state: unknown, env: { DB: unknown }) => { assert.equal(env.DB, db); order.push('dispatch'); } });
  const response = await handler(requestFor(minimal()), { DB: db, OWNER_EMAIL: 'owner@example.test' }, { waitUntil: (task: Promise<unknown>) => tasks.push(task) });
  assert.equal(response.status, 200);
  await Promise.all(tasks);
  assert.deepEqual(order, ['begin', 'commit', 'dispatch']);
});

test('commit failure never starts notification dispatch or a background task', async () => {
  let dispatched = 0, background = 0;
  const db = { ...database(), financialTransaction: async (work: (db: unknown) => Promise<Response>) => { await work(database()); throw Error('COMMIT failed'); } };
  const response = await handlerFor({ dispatchNotifications: async () => { dispatched++; } })(requestFor(minimal()), { DB: db, OWNER_EMAIL: 'owner@example.test' }, { waitUntil: () => { background++; } });
  assert.equal(response.status, 500); assert.equal(dispatched, 0); assert.equal(background, 0);
});

test('legacy repayment is stamped before journal checks so its original reconciliation stays exact', async () => {
  const state = structuredClone(seedState);
  state.project.id = 'project-1'; state.documents = [];
  state.financeEntries = [{ id: 'expense', kind: 'expense', status: 'paid', amount: 100, paidAmount: 100, acceptedAmount: 0, date: '2000-01-01', paidAt: '2000-01-01', approvedAt: '2000-01-01T12:00:00Z', approvedBy: 'Owner', description: 'Synthetic expense', counterparty: 'Vendor' }];
  state.treasury = { version: 1, enabled: true, accounts: [{ id: 'bank', name: 'Bank', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: true }], entryPlans: [], costEstimates: [] };
  state.financeLedger = { ...emptyFinanceLedger(), operations: [
    { id: 'reconcile', kind: 'payment', date: '2000-01-01', amountCents: 10000, accountId: 'bank', counterparty: 'Vendor', description: 'Original payment', source: 'Statement', confirmation: 'confirmed', allocations: [], legacyPayment: { entryId: 'expense', paymentId: 'legacy:expense' } },
    { id: 'refund', kind: 'supplier_refund', date: '2000-01-02', amountCents: 3000, accountId: 'bank', counterparty: 'Vendor', description: 'Refund', source: 'Statement', confirmation: 'confirmed', allocations: [{ entryId: 'expense', amountCents: 3000 }], refundOfLegacyPayment: { entryId: 'expense', paymentId: 'legacy:expense' } },
  ] };
  const candidate = structuredClone(state);
  Object.assign(candidate.financeEntries[0], { paidAmount: 130, paidAt: '2000-01-03', paymentDocument: 'Second payment' });
  const response = await handlerFor({ readSnapshot: async () => ({ state, revision: 1 }) })(requestFor(candidate, 1), { DB: database(), OWNER_EMAIL: 'owner@example.test' }, { waitUntil() {} });
  const body = await response.json() as { snapshot?: { state: typeof state }; message?: string };
  assert.equal(response.status, 200, body.message);
  assert.equal(body.snapshot?.state.financeEntries[0].legacyPayment?.amount, 100);
  assert.equal(body.snapshot?.state.financeEntries[0].payments?.[0].amount, 30);
  assert.equal(body.snapshot?.state.financeLedger?.operations[0].amountCents, 10000);
});

test('malformed ledger nested allocations fail with 422 before money calculations and writes', async () => {
  const state = { ...minimal(), financeLedger: { ...emptyFinanceLedger(), operations: [{ id: 'bad', allocations: {} }] } };
  let writes = 0;
  const response = await handlerFor()(requestFor(state), { DB: { ...database(), batch: async () => { writes++; return []; } }, OWNER_EMAIL: 'owner@example.test' }, { waitUntil() {} });
  assert.equal(response.status, 422); assert.equal(writes, 0);
  assert.equal((await response.json() as { error: string }).error, 'invalid_finance_ledger');
});
