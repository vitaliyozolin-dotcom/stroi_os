import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSharedFinanceAccountHandler } from '../sites/projects/shared-finance-account.js';
import { validateFinanceAutomationChanges } from '../src/domain/finance-automation.js';
import { seedState } from '../src/seed.ts';

const ownerHeaders = { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' };
const stateFor = (id: string, allocation: number) => ({ ...structuredClone(seedState), project: { ...seedState.project, id, name: id }, financeEntries: [], treasury: { version: 1, enabled: true, accounts: [{ id: `account-${id}`, name: 'Shared account', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: false, sharedAccountKey: 'same-bank', opening: { asOf: '2000-01-01', amountCents: 10000, confirmed: true, source: 'Opening evidence' }, restrictedCents: 0, projectAllocationCents: allocation }], entryPlans: [], costEstimates: [] } });
class AtomicDatabase {
  raw = new DatabaseSync(':memory:');
  failProject: string | null = null;
  failAudit = false;
  constructor() {
    this.raw.exec('CREATE TABLE project_state (project_id TEXT PRIMARY KEY, state_json TEXT, revision INTEGER, updated_at TEXT, updated_by TEXT, updated_role TEXT); CREATE TABLE audit_log (id TEXT PRIMARY KEY, project_id TEXT, revision INTEGER, created_at TEXT, actor TEXT, role TEXT, action TEXT, summary TEXT, state_bytes INTEGER);');
    for (const state of [stateFor('first', 4000), stateFor('second', 5000)]) this.raw.prepare('INSERT INTO project_state VALUES (?, ?, 1, NULL, NULL, NULL)').run(state.project.id, JSON.stringify(state));
  }
  prepare(sql: string) {
    const statement = (values: unknown[] = []) => ({ sql, values, bind: (...bound: unknown[]) => statement(bound), all: async () => ({ results: this.raw.prepare(sql).all(...values as []) }) });
    return statement();
  }
  async batch(statements: { sql: string; values: unknown[] }[]) {
    return statements.map(({ sql, values }) => {
      if (sql.startsWith('UPDATE') && values[5] === this.failProject) return { meta: { changes: 0 } };
      if (sql.startsWith('INSERT INTO audit_log') && this.failAudit) throw Error('audit failed');
      return { meta: { changes: Number(this.raw.prepare(sql).run(...values as []).changes) } };
    });
  }
  async financialTransaction(work: (db: AtomicDatabase) => Promise<Response>) {
    this.raw.exec('BEGIN');
    try { const response = await work(this); this.raw.exec(response.status >= 400 ? 'ROLLBACK' : 'COMMIT'); return response; }
    catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
  rows() { return this.raw.prepare('SELECT * FROM project_state ORDER BY project_id').all(); }
  audits() { return this.raw.prepare('SELECT * FROM audit_log ORDER BY project_id').all(); }
}
const input = () => ({ sharedAccountKey: 'same-bank', legalEntityId: 'company', currency: 'RUB', opening: { asOf: '2000-01-02', amountCents: 12000, confirmed: true, source: 'New bank statement' }, restrictedCents: 1000, reason: 'Daily balance reconciliation', expected: [{ projectId: 'first', accountId: 'account-first', revision: 1 }, { projectId: 'second', accountId: 'account-second', revision: 1 }], allocations: [{ projectId: 'first', accountId: 'account-first', amountCents: 6000 }, { projectId: 'second', accountId: 'account-second', amountCents: 5000 }] });
const handler = createSharedFinanceAccountHandler({ ensureSchema: async () => {} });
const send = (db: AtomicDatabase, body?: unknown, headers = ownerHeaders) => handler(new Request('https://example.test/api/finance/shared-account?key=same-bank', { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) }), { DB: db, OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Owner' });

test('shared balance GET returns revisions and allocation preview without project business facts', async () => {
  const db = new AtomicDatabase(), response = await send(db);
  assert.equal(response.status, 200);
  const result = await response.json() as { sharedAccount: { projects: { projectId: string; revision: number }[] } };
  assert.deepEqual(result.sharedAccount.projects.map(row => [row.projectId, row.revision]), [['first', 1], ['second', 1]]);
  assert.equal(JSON.stringify(result).includes('financeEntries'), false);
  assert.equal(db.audits().length, 0);
});

test('shared balance and allocations update all projects and audit atomically while preserving other contexts', async () => {
  const db = new AtomicDatabase(), before = db.rows().map(row => JSON.parse(String(row.state_json)));
  const response = await send(db, input());
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const result = await response.json() as { sharedAccount: { opening: { amountCents: number }; projects: { revision: number; allocationCents: number }[] } };
  assert.equal(result.sharedAccount.opening.amountCents, 12000);
  assert.deepEqual(result.sharedAccount.projects.map(row => [row.revision, row.allocationCents]), [[2, 6000], [2, 5000]]);
  db.rows().forEach((row, index) => {
    const state = JSON.parse(String(row.state_json));
    assert.equal(state.treasury.accounts[0].opening.asOf, '2000-01-02');
    assert.equal(state.treasury.history.length, 1);
    for (const field of ['financeEntries', 'financeLedger', 'documents', 'tasks', 'stages', 'budgetLines']) assert.deepEqual(state[field], before[index][field]);
  });
  assert.equal(db.audits().length, 2);
});

test('stale revisions, omitted projects, and excessive allocations leave every project unchanged', async () => {
  for (const alter of [
    (body: ReturnType<typeof input>) => { body.expected[1].revision = 2; },
    (body: ReturnType<typeof input>) => { body.expected.pop(); body.allocations.pop(); },
    (body: ReturnType<typeof input>) => { body.allocations[0].amountCents = 7000; },
  ]) {
    const db = new AtomicDatabase(), before = db.rows(), body = input(); alter(body);
    const response = await send(db, body);
    assert.ok([409, 422].includes(response.status)); assert.deepEqual(db.rows(), before); assert.equal(db.audits().length, 0);
  }
});

test('management access to only one linked project cannot read or mutate the shared scope', async () => {
  const db = new AtomicDatabase();
  const first = JSON.parse(String(db.rows()[0].state_json));
  first.settings.users = [{ id: 'manager', name: 'Manager', email: 'manager@example.test', role: 'management', status: 'active' }];
  db.raw.prepare('UPDATE project_state SET state_json = ? WHERE project_id = ?').run(JSON.stringify(first), 'first');
  const before = db.rows(), headers = { ...ownerHeaders, 'oai-authenticated-user-email': 'manager@example.test' };
  for (const body of [undefined, input()]) {
    const response = await send(db, body, headers);
    assert.equal(response.status, 403); assert.equal((await response.text()).includes('second'), false);
  }
  assert.deepEqual(db.rows(), before); assert.equal(db.audits().length, 0);
});

test('CAS failure after another project updated and audit failure both roll back the entire shared update', async () => {
  for (const failure of ['cas', 'audit']) {
    const db = new AtomicDatabase(), before = db.rows();
    if (failure === 'cas') db.failProject = 'second'; else db.failAudit = true;
    const response = await send(db, input());
    assert.equal(response.status, failure === 'cas' ? 409 : 500);
    assert.deepEqual(db.rows(), before); assert.equal(db.audits().length, 0);
  }
});

test('repeating an already committed shared update conflicts instead of duplicating financial history', async () => {
  const db = new AtomicDatabase();
  assert.equal((await send(db, input())).status, 200);
  const before = db.rows();
  assert.equal((await send(db, input())).status, 409);
  assert.deepEqual(db.rows(), before); assert.equal(db.audits().length, 2);
});


test('shared balance writes resolve and reopen cash-gap review history without keeping an old snooze', async () => {
  const db = new AtomicDatabase();
  const first = JSON.parse(String(db.rows()[0].state_json));
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  first.financeEntries = [{ id: 'due', kind: 'expense', status: 'committed', amount: 100, date: today, dueDate: today, description: 'Materials', counterparty: 'Supplier' }];
  first.treasury.entryPlans = [{ entryId: 'due', sourceAccountId: 'account-first', cashTreatment: 'account', source: 'Contract', tranches: [] }];
  const tracked = structuredClone(first);
  tracked.financeAutomation = { version: 1, reviews: [{ riskId: 'cash-gap:project', acknowledged: true, nextAction: 'Review funding', snoozedUntil: today }] };
  assert.equal(validateFinanceAutomationChanges(first, tracked, { role: 'management', name: 'Owner' }, new Date().toISOString()), '');
  db.raw.prepare('UPDATE project_state SET state_json = ? WHERE project_id = ?').run(JSON.stringify(tracked), 'first');
  const resolved = input(); resolved.opening.amountCents = 21000; resolved.allocations[0].amountCents = 15000;
  assert.equal((await send(db, resolved)).status, 200);
  const afterResolution = JSON.parse(String(db.rows()[0].state_json));
  assert.ok(afterResolution.financeAutomation.reviews[0].resolvedAt);
  assert.equal(afterResolution.financeAutomation.reviews[0].history.at(-1).action, 'resolved');
  const recurrent = input(); recurrent.expected.forEach(row => row.revision = 2);
  assert.equal((await send(db, recurrent)).status, 200);
  const afterRecurrence = JSON.parse(String(db.rows()[0].state_json)), review = afterRecurrence.financeAutomation.reviews[0];
  assert.equal(review.resolvedAt, undefined); assert.equal(review.acknowledged, false); assert.equal(review.snoozedUntil, undefined);
  assert.equal(review.history.at(-1).action, 'reopened');
  assert.deepEqual(afterRecurrence.financeEntries, tracked.financeEntries);
});
