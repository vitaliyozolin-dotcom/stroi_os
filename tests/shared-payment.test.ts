import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSharedPaymentHandler, validateSharedPaymentWrite } from '../sites/projects/shared-payment.js';
import { createProjectWriteHandler } from '../sites/projects/write.js';
import { createTelegramProjectStore } from '../sites/telegram/project-store.js';
import { emptyFinanceLedger, ledgerEffect, ledgerEntryBalance, validateFinanceLedgerChanges } from '../src/domain/finance-ledger.js';
import { financePortfolio, validatePortfolioWrite } from '../src/domain/finance-portfolio.js';
import { sharedPaymentBankKey, sharedPaymentInputError } from '../src/domain/shared-payment.js';
import { bankStatementIdentity } from '../src/domain/banking/statement.ts';
import { seedState } from '../src/seed.ts';
import type { AppState } from '../src/entities/index.ts';
import type { SharedPaymentInput } from '../src/entities/shared-payment.ts';

const ownerHeaders = { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' };
const stateFor = (id: string, allocation: number): AppState => ({ ...structuredClone(seedState),
  project: { ...seedState.project, id, name: `Заказ ${id}` },
  financeEntries: [{ id: `entry-${id}`, kind: 'expense', status: 'committed', amount: 400000, date: '2024-01-01', dueDate: '2024-01-04', description: 'Материалы', counterparty: 'Поставщик', approvedAt: '2024-01-01T12:00:00Z', approvedBy: 'Owner' }],
  financeLedger: emptyFinanceLedger(),
  treasury: { version: 1, enabled: true, accounts: [{ id: `account-${id}`, name: 'Общий счёт', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: false,
    sharedAccountKey: 'same-bank', opening: { asOf: '2024-01-01', amountCents: 100000000, confirmed: true, source: 'Остаток выписки' }, restrictedCents: 0, projectAllocationCents: allocation }],
    entryPlans: [{ entryId: `entry-${id}`, sourceAccountId: `account-${id}`, source: 'Договор', tranches: [] }], costEstimates: [] },
});
class AtomicDatabase {
  raw = new DatabaseSync(':memory:'); failProject: string | null = null; failAudit = false;
  queue: Promise<unknown> = Promise.resolve();
  constructor() {
    this.raw.exec(`CREATE TABLE project_state (project_id TEXT PRIMARY KEY, state_json TEXT, revision INTEGER, updated_at TEXT, updated_by TEXT, updated_role TEXT);
      CREATE TABLE audit_log (id TEXT PRIMARY KEY, project_id TEXT, revision INTEGER, created_at TEXT, actor TEXT, role TEXT, action TEXT, summary TEXT, state_bytes INTEGER);
      CREATE TABLE shared_payment_records (id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL, created_at TEXT, created_by TEXT);
      CREATE TABLE shared_payment_project_shares (payment_id TEXT REFERENCES shared_payment_records(id), project_id TEXT REFERENCES project_state(project_id), operation_id TEXT, amount_cents BIGINT CHECK(amount_cents > 0), PRIMARY KEY(payment_id, project_id), UNIQUE(project_id, operation_id));`);
    for (const state of [stateFor('first', 60000000), stateFor('second', 30000000)]) this.raw.prepare('INSERT INTO project_state VALUES (?, ?, 1, NULL, NULL, NULL)').run(state.project.id, JSON.stringify(state));
  }
  prepare(sql: string) {
    const statement = (values: unknown[] = []) => ({ sql, values, bind: (...bound: unknown[]) => statement(bound), all: async () => ({ results: this.raw.prepare(sql).all(...values as []) }),
      run: async () => ({ meta: { changes: Number(this.raw.prepare(sql).run(...values as []).changes) } }) });
    return statement();
  }
  async batch(statements: { sql: string; values: unknown[] }[]) {
    return statements.map(({ sql, values }) => {
      if (sql.startsWith('UPDATE project_state') && values[5] === this.failProject) return { meta: { changes: 0 } };
      if (sql.startsWith('INSERT INTO audit_log') && this.failAudit) throw Error('audit failed');
      return { meta: { changes: Number(this.raw.prepare(sql).run(...values as []).changes) } };
    });
  }
  async financialTransaction(work: (db: AtomicDatabase) => Promise<Response>) {
    const run = this.queue.then(async () => {
      this.raw.exec('BEGIN');
      try { const response = await work(this); this.raw.exec(response.status >= 400 ? 'ROLLBACK' : 'COMMIT'); return response; }
      catch (error) { this.raw.exec('ROLLBACK'); throw error; }
    });
    this.queue = run.catch(() => undefined); return run;
  }
  rows() { return this.raw.prepare('SELECT * FROM project_state ORDER BY project_id').all(); }
  state(id = 'first'): AppState { return JSON.parse(String(this.rows().find(row => row.project_id === id)!.state_json)); }
  put(state: AppState) { this.raw.prepare('UPDATE project_state SET state_json = ? WHERE project_id = ?').run(JSON.stringify(state), state.project.id); }
  count(table: string) { return Number(this.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n); }
}
const input = (): SharedPaymentInput => ({ id: 'one-real-payment', sourceKey: 'payment-document-123', kind: 'payment', date: '2024-01-02', amountCents: 30000000, currency: 'RUB',
  sharedAccountKey: 'same-bank', legalEntityId: 'company', payer: 'ООО Заказчик', payee: 'Поставщик', description: 'Одна оплата материалов по двум заказам', source: 'Платёжное поручение 123', sourceReference: '123', confirmation: 'confirmed', cashTreatment: 'account',
  expected: [{ projectId: 'first', revision: 1 }, { projectId: 'second', revision: 1 }], allocations: [
    { projectId: 'first', accountId: 'account-first', entryId: 'entry-first', amountCents: 20000000 },
    { projectId: 'second', accountId: 'account-second', entryId: 'entry-second', amountCents: 10000000 },
  ] });
const handler = createSharedPaymentHandler({ ensureSchema: async () => {} });
const send = (db: AtomicDatabase, body?: unknown, headers = ownerHeaders, projectId = 'first') => handler(new Request(`https://example.test/api/finance/shared-payments?projectId=${projectId}`, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }), { DB: db, OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Owner' });
const ensureOk = async (response: Response) => { assert.equal(response.status, 200, await response.clone().text()); return response.json(); };

test('one RUB 300,000 payment creates 200,000 and 100,000 shares, exact company cash and partial obligations', async () => {
  const db = new AtomicDatabase(), before = [db.state(), db.state('second')];
  const result = await ensureOk(await send(db, input()));
  assert.equal(result.payment.principal.amountCents, 30000000); assert.equal(result.replayed, false);
  assert.equal(result.snapshot.projectId, 'first'); assert.equal(result.snapshot.revision, 2);
  assert.equal(db.count('shared_payment_records'), 1); assert.equal(db.count('shared_payment_project_shares'), 2); assert.equal(db.count('audit_log'), 2);
  const states = [db.state(), db.state('second')];
  assert.deepEqual(states.map(state => state.financeLedger!.operations[0].amountCents), [20000000, 10000000]);
  assert.equal(states.flatMap(state => ledgerEffect(state).cashMovements).reduce((sum, row) => sum + row.outflowCents, 0), 30000000);
  assert.deepEqual(states.map(state => ledgerEntryBalance(state, `entry-${state.project.id}`)!.remainingCents), [20000000, 30000000]);
  states.forEach((state, index) => {
    assert.deepEqual(state.financeEntries, before[index].financeEntries); assert.deepEqual(state.documents, before[index].documents); assert.deepEqual(state.treasury, before[index].treasury);
    assert.equal(state.financeLedger!.history!.length, 1); const operation = state.financeLedger!.operations[0];
    assert.equal(operation.sharedPaymentId, input().id); assert.equal(operation.sourceKey, undefined);
    assert.equal(operation.actualPayer, 'ООО Заказчик'); assert.equal(operation.actualPayee, 'Поставщик'); assert.equal(operation.confirmation, 'confirmed');
    assert.equal(validatePortfolioWrite(before[index], state, states.filter(other => other.project.id !== state.project.id)), '');
  });
  const portfolio = financePortfolio(states, { today: '2024-01-02', horizonDays: 1 });
  const portfolioBefore = financePortfolio(before, { today: '2024-01-02', horizonDays: 1 });
  assert.equal(portfolioBefore.summary.openingCents! - portfolio.summary.openingCents!, 30000000);
  assert.equal(portfolioBefore.companies[0].openingCents! - portfolio.companies[0].openingCents!, 30000000);
  assert.equal(await validateSharedPaymentWrite(db, states[0], states[0]), '');
});

test('same intent retries ignore stale expected revisions but create no history twice; different source identity conflicts', async () => {
  const db = new AtomicDatabase(); await ensureOk(await send(db, input())); const before = db.rows();
  const retry = input(); retry.allocations.reverse(); const result = await ensureOk(await send(db, retry));
  assert.equal(result.replayed, true); assert.deepEqual(db.rows(), before); assert.equal(db.count('audit_log'), 2);
  for (const mutate of [(body: SharedPaymentInput) => { body.id = 'different-id'; }, (body: SharedPaymentInput) => { body.description = 'Different intent'; }]) {
    const body = input(); mutate(body); assert.equal((await send(db, body)).status, 409); assert.deepEqual(db.rows(), before);
  }
});

test('concurrent same ID retries settle once; competing payments with stale revisions cannot both commit', async () => {
  const db = new AtomicDatabase();
  const responses = await Promise.all([send(db, input()), send(db, input())]);
  assert.deepEqual(responses.map(row => row.status), [200, 200]); assert.equal(db.count('shared_payment_records'), 1); assert.equal(db.count('audit_log'), 2);
  const other = new AtomicDatabase(), first = input(), second = input(); second.id = 'second-payment'; second.sourceKey = 'second-source';
  const outcomes = await Promise.all([send(other, first), send(other, second)]);
  assert.deepEqual(outcomes.map(row => row.status), [200, 409]); assert.equal(other.count('shared_payment_records'), 1);
});

test('CAS or audit failures roll back principal, shares, both projects and audit', async () => {
  for (const mode of ['cas', 'audit']) {
    const db = new AtomicDatabase(), before = db.rows(); if (mode === 'cas') db.failProject = 'second'; else db.failAudit = true;
    assert.equal((await send(db, input())).status, mode === 'cas' ? 409 : 500);
    assert.deepEqual(db.rows(), before); assert.equal(db.count('shared_payment_records'), 0); assert.equal(db.count('shared_payment_project_shares'), 0); assert.equal(db.count('audit_log'), 0);
  }
});

test('invalid split, excess debt, future fact, foreign account, stale version and held retention leave old books untouched', async () => {
  const mutations: ((body: SharedPaymentInput, db: AtomicDatabase) => void)[] = [
    body => { body.allocations[0].amountCents++; },
    body => { body.amountCents = 60000000; body.allocations[0].amountCents = 50000000; },
    body => { body.date = '2099-01-01'; },
    body => { body.allocations[1].accountId = 'account-first'; },
    body => { body.expected[1].revision = 2; },
    (body, db) => { const state = db.state(); state.financeLedger!.retentions = [{ id: 'held', entryId: 'entry-first', amountCents: 30000000, status: 'held', source: 'Договор' }]; db.put(state); body.allocations[0].retentionId = 'held'; },
  ];
  for (const mutate of mutations) { const db = new AtomicDatabase(), body = input(); mutate(body, db); const before = db.rows(); const response = await send(db, body);
    assert.ok([409, 422].includes(response.status), await response.text()); assert.deepEqual(db.rows(), before); assert.equal(db.count('shared_payment_records'), 0); }
});

test('manager sees only authorized orders and cannot read global totals or write a cross-project payment without all rights', async () => {
  const db = new AtomicDatabase(); await ensureOk(await send(db, input()));
  const state = db.state(); state.settings.users = [{ id: 'manager', name: 'Manager', email: 'manager@example.test', role: 'management', status: 'active' }]; db.put(state);
  const headers = { ...ownerHeaders, 'oai-authenticated-user-email': 'manager@example.test' };
  const preview = await ensureOk(await send(db, undefined, headers));
  assert.deepEqual(preview.projects.map((row: { projectId: string }) => row.projectId), ['first']); assert.deepEqual(preview.payments, []);
  assert.equal(JSON.stringify(preview).includes('Заказ second'), false);
  assert.equal((await send(db, input(), headers)).status, 403); assert.equal((await send(db, undefined, headers, 'second')).status, 403);
  const before = db.rows(); assert.equal((await send(db, input(), { ...headers, 'oai-authenticated-user-email': 'stranger@example.test' })).status, 403); assert.deepEqual(db.rows(), before);
});

test('canonical guard rejects forged, removed or edited shares, separate confirmation and altered account identity', async () => {
  const db = new AtomicDatabase(); await ensureOk(await send(db, input())); const previous = db.state();
  const mutations: ((next: AppState) => void)[] = [
    next => { next.financeLedger!.operations = []; },
    next => { next.financeLedger!.operations[0].amountCents++; },
    next => { next.financeLedger!.operations[0].actualPayer = 'Someone else'; },
    next => { delete next.financeLedger!.operations[0].sharedPaymentId; },
    next => { const original = next.financeLedger!.operations[0]; next.financeLedger!.operations.push({ ...original, id: 'forged', sharedPaymentId: 'forged-master' }); },
    next => { next.financeLedger!.confirmations.push({ id: 'confirm-part', operationId: next.financeLedger!.operations[0].id, confirmation: 'reconciled', source: 'Assertion only' }); },
    next => { next.treasury!.accounts[0].sharedAccountKey = 'other-bank'; },
  ];
  for (const mutate of mutations) { const next = structuredClone(previous); mutate(next); assert.ok(await validateSharedPaymentWrite(db, previous, next)); }
  const fresh = stateFor('fresh', 0); fresh.financeLedger!.operations.push({ ...previous.financeLedger!.operations[0], id: 'forged-outside' });
  assert.ok(await validateSharedPaymentWrite(db, stateFor('fresh', 0), fresh));
});

test('project unallocated remainder can later settle its own obligation via append-only event, and a real partial refund remains valid', async () => {
  const db = new AtomicDatabase(), body = input(); delete body.allocations[0].entryId;
  await ensureOk(await send(db, body)); const old = db.state(), next = structuredClone(old), operation = next.financeLedger!.operations[0];
  assert.equal(ledgerEntryBalance(old, 'entry-first')!.settledCents, 0);
  assert.equal(operation.allocations.length, 0);
  assert.equal(ledgerEffect(old).cashMovements[0].outflowCents, 20000000);
  assert.match(ledgerEffect(old).warnings.join(' '), /не распределено/);
  const portfolio = financePortfolio([old, db.state('second')], { today: '2024-01-02', horizonDays: 1 });
  assert.equal(portfolio.summary.openingCents, 60000000); // 900,000 allocated opening minus one 300,000 payment, including the unattributed debt remainder.
  next.financeLedger!.allocationEvents!.push({ id: 'later-allocation', operationId: operation.id, allocations: [{ entryId: 'entry-first', amountCents: 15000000 }], source: 'Расшифровка первоначального платежа' });
  next.financeLedger!.changeReason = 'Распределён остаток внутри заказа';
  assert.equal(await validateSharedPaymentWrite(db, old, next), ''); assert.equal(validateFinanceLedgerChanges(old, next, { role: 'management', name: 'Owner' }, '2024-01-03T12:00:00Z'), '');
  assert.equal(ledgerEntryBalance(next, 'entry-first')!.settledCents, 15000000); assert.equal(next.financeLedger!.operations[0].amountCents, 20000000);
  db.put(next); const refund = structuredClone(next);
  refund.financeLedger!.operations.push({ id: 'real-return', kind: 'supplier_refund', date: '2024-01-03', amountCents: 1000000, accountId: 'account-first', counterparty: 'Поставщик', description: 'Фактический возврат', source: 'Возврат 124', confirmation: 'confirmed', refundOfOperationId: operation.id, allocations: [{ entryId: 'entry-first', amountCents: 1000000 }] });
  refund.financeLedger!.changeReason = 'Подтверждён реальный возврат';
  assert.equal(await validateSharedPaymentWrite(db, next, refund), ''); assert.equal(validateFinanceLedgerChanges(next, refund, { role: 'management', name: 'Owner' }, '2024-01-03T12:00:00Z'), '');
  assert.equal(ledgerEntryBalance(refund, 'entry-first')!.settledCents, 14000000);
});

const readSnapshot = async (db: AtomicDatabase, projectId: string) => {
  const row = db.rows().find(item => item.project_id === projectId);
  return row ? { projectId, state: JSON.parse(String(row.state_json)), revision: Number(row.revision), updatedAt: String(row.updated_at ?? ''), updatedBy: String(row.updated_by ?? ''), updatedRole: 'management' } : null;
};
const writeHandler = createProjectWriteHandler({ ensureSchema: async () => {}, readSnapshot, changes: (result: { meta?: { changes?: number } }) => result?.meta?.changes ?? 0,
  applyAutomations: (_previous: unknown, state: unknown) => state, buildNotificationPlan: async () => ({ deliveries: [] }), dispatchNotifications: async () => {} });
const ordinaryPut = async (db: AtomicDatabase | object, state: AppState, revision = 2) => writeHandler(new Request(`https://example.test/api/state?projectId=${state.project.id}`, {
  method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ projectId: state.project.id, expectedRevision: revision, state }),
}), { DB: db, OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Owner' }, { waitUntil: () => {} });
const additionalOperation = (state: AppState, sourceKey?: string) => ({ id: 'additional-operation', kind: 'payment' as const, date: '2024-01-03', amountCents: 100, accountId: state.treasury!.accounts[0].id,
  counterparty: 'Поставщик', description: 'Дополнительная запись', source: 'Проверяемый источник', confirmation: sourceKey ? 'reconciled' as const : 'confirmed' as const, allocations: [], ...(sourceKey ? { sourceKey } : {}) });

test('real ordinary PUT guards reject forged shared metadata and canonical source reuse after ledger stamping', async () => {
  for (const kind of ['forged', 'duplicate-bank', 'delete']) {
    const db = new AtomicDatabase(); await ensureOk(await send(db, input())); const next = db.state(), before = db.rows();
    if (kind === 'delete') next.financeLedger!.operations = [];
    else next.financeLedger!.operations.push({ ...additionalOperation(next, kind === 'duplicate-bank' ? input().sourceKey : undefined), ...(kind === 'forged' ? { sharedPaymentId: input().id, sharedPaymentSourceKey: input().sourceKey } : {}) });
    next.financeLedger!.changeReason = 'Поддельная попытка'; const response = await ordinaryPut(db, next);
    assert.equal(response.status, 422, await response.clone().text());
    if (kind !== 'delete') assert.equal((await response.json()).error, 'invalid_shared_payment');
    assert.deepEqual(db.rows(), before); assert.equal(db.count('audit_log'), 2); assert.equal(db.count('shared_payment_records'), 1);
  }
});

test('ordinary PUT preserves immutable share while appending allocation and server-owned audit', async () => {
  const db = new AtomicDatabase(), body = input(); delete body.allocations[0].entryId; await ensureOk(await send(db, body));
  const before = db.state(), next = structuredClone(before);
  next.financeLedger!.allocationEvents!.push({ id: 'ordinary-later-allocation', operationId: next.financeLedger!.operations[0].id, allocations: [{ entryId: 'entry-first', amountCents: 10000000 }], source: 'Поздняя расшифровка' });
  next.financeLedger!.changeReason = 'Дополнение распределения';
  const result = await ensureOk(await ordinaryPut(db, next));
  assert.equal(result.snapshot.revision, 3); assert.deepEqual(db.state().financeLedger!.operations, before.financeLedger!.operations);
  assert.equal(ledgerEntryBalance(db.state(), 'entry-first')!.settledCents, 10000000);
  assert.equal(db.count('shared_payment_records'), 1); assert.equal(db.count('audit_log'), 3);
});

test('real Telegram mutation guards reject forged shares and global source duplicates without changing state or audit', async () => {
  const store = createTelegramProjectStore({ ensureSchema: async () => {}, readSnapshot, changes: (result: { meta?: { changes?: number } }) => result?.meta?.changes ?? 0, mutationNoop: Symbol('noop') });
  for (const kind of ['forged', 'duplicate-bank']) {
    const db = new AtomicDatabase(); await ensureOk(await send(db, input())); const before = db.rows();
    await assert.rejects(store.mutate({ DB: db }, 'first', 'Owner', 'management', 'test', 'Проверка защиты', (next: AppState) => {
      next.financeLedger!.operations.push({ ...additionalOperation(next, kind === 'duplicate-bank' ? input().sourceKey : undefined), ...(kind === 'forged' ? { sharedPaymentId: input().id, sharedPaymentSourceKey: input().sourceKey } : {}) });
      next.financeLedger!.changeReason = 'Поддельная попытка';
    }), /invalid_shared_payment/);
    assert.deepEqual(db.rows(), before); assert.equal(db.count('audit_log'), 2); assert.equal(db.count('shared_payment_records'), 1);
  }
});

test('receipt shares settle each customer balance while the company receives only the original amount', async () => {
  const db = new AtomicDatabase(), body = input(); body.kind = 'receipt'; body.payer = 'Заказчик'; body.payee = 'ООО Компания';
  for (const id of ['first', 'second']) { const state = db.state(id); state.financeEntries[0].kind = 'income'; db.put(state); }
  await ensureOk(await send(db, body));
  assert.deepEqual([db.state(), db.state('second')].map(state => ledgerEntryBalance(state, state.financeEntries[0].id)!.settledCents), [20000000, 10000000]);
  assert.equal([db.state(), db.state('second')].flatMap(state => ledgerEffect(state).cashMovements).reduce((sum, row) => sum + row.inflowCents, 0), 30000000);
});

test('bank ID reserves the existing bank import identity; reconciled requires a protected original', async () => {
  const body = input(); body.confirmation = 'reconciled'; assert.ok(sharedPaymentInputError(body));
  body.bankEvidence = { projectId: 'first', documentId: 'bank-original', externalId: 'unique-bank-id', source: 'Выписка банка' };
  body.sourceKey = sharedPaymentBankKey('same-bank', 'unique-bank-id');
  assert.equal(body.sourceKey, bankStatementIdentity({ date: body.date, amountCents: body.amountCents, direction: 'out', externalId: 'unique-bank-id', counterparty: body.payee, purpose: body.description }, 'shared:same-bank').key);
  const db = new AtomicDatabase(); assert.equal((await send(db, body)).status, 422);
  const state = db.state(); state.documents.push({ id: 'bank-original', name: 'Оригинал выписки', type: 'pdf', updatedAt: '2024-01-02', clientVisible: false, status: 'signed', fileKey: 'first/bank/original.pdf' }); db.put(state);
  await ensureOk(await send(db, body)); const previous = db.state();
  const alterEvidence = structuredClone(previous); alterEvidence.documents.find(row => row.id === 'bank-original')!.fileKey = 'first/bank/replaced.pdf';
  assert.ok(await validateSharedPaymentWrite(db, previous, alterEvidence));
  const next = structuredClone(previous); next.financeLedger!.operations.push({ id: 'duplicate-bank-import', kind: 'payment', date: body.date, amountCents: body.amountCents, accountId: 'account-first', counterparty: 'Поставщик', description: 'Импорт той же полной строки', source: 'Повторный импорт', sourceKey: body.sourceKey, confirmation: 'reconciled', allocations: [] });
  assert.ok(await validateSharedPaymentWrite(db, previous, next));
  const other = stateFor('unrelated', 0); other.financeLedger!.operations.push(next.financeLedger!.operations.at(-1)!);
  assert.ok(await validateSharedPaymentWrite(db, stateFor('unrelated', 0), other));
});

test('previous ordinary bank payment cannot be imported again as a shared master and dedup across old journals remains active', async () => {
  const db = new AtomicDatabase(), state = db.state();
  state.financeLedger!.operations.push({ id: 'existing', kind: 'payment', date: '2024-01-02', amountCents: 1, accountId: 'account-first', counterparty: 'Поставщик', description: 'Существующая запись', source: 'Банк', sourceKey: input().sourceKey, confirmation: 'reconciled', allocations: [] }); db.put(state);
  assert.equal((await send(db, input())).status, 409); assert.equal(db.count('shared_payment_records'), 0);
  const duplicate = db.state('second'); duplicate.financeLedger!.operations.push({ ...state.financeLedger!.operations[0], accountId: 'account-second' });
  assert.ok(validatePortfolioWrite(db.state('second'), duplicate, [state]));
});

test('direct participant payment settles debts without fictional cash and rejects bank reconciliation', async () => {
  const db = new AtomicDatabase(), body = input(); body.cashTreatment = 'participant_direct'; delete body.sharedAccountKey; body.allocations.forEach(row => { delete row.accountId; });
  await ensureOk(await send(db, body)); assert.equal(ledgerEffect(db.state()).cashMovements.length, 0); assert.equal(ledgerEntryBalance(db.state(), 'entry-first')!.settledCents, 20000000);
  body.confirmation = 'reconciled'; assert.ok(sharedPaymentInputError(body));
});
