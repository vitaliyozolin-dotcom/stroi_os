import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createOrderDirectoryHandler, validateOrderDirectoryReferences } from '../sites/orders/directory.js';
import { emptyOrderRelations, validateOrderRelationsChanges } from '../src/domain/order-relations.js';
import type { OrderDirectoryResponse, OrderRelationsState } from '../src/entities/index.ts';

const ownerHeaders = { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' };
const headersFor = (email: string) => ({ ...ownerHeaders, 'oai-authenticated-user-email': email });
const user = (name: string, role = 'management') => ({ id: name, name, email: `${name}@example.test`, role, status: 'active' });
const project = (id: string) => ({ project: { id, name: `Project ${id}`, code: id, contractValue: id === 'two' ? 987654321 : 1234, clientNames: 'Legacy customer', unknownFields: [] as string[] },
  settings: { users: [user(id === 'one' ? 'manager-one' : 'manager-two'), user('manager-all'), user('foreman', 'foreman'), user('client', 'client')] },
  orderRelations: emptyOrderRelations(), documents: [] as { id: string }[], financeEntries: [{ id: `private-finance-${id}`, kind: 'income', amount: 999999 }], budgetLines: [], stages: [], tasks: [] });

class AtomicDatabase {
  raw = new DatabaseSync(':memory:');
  failAudit = false;
  failMutation = false;
  transactions = 0;
  constructor() {
    this.raw.exec(`
      CREATE TABLE project_state (project_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE order_directory_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('party','plot','asset','agreement')), origin_project_id TEXT NOT NULL, payload_json TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
      CREATE TABLE order_directory_audit (id TEXT PRIMARY KEY, record_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL, actor_name TEXT NOT NULL, reason TEXT NOT NULL, payload_json TEXT NOT NULL);
    `);
    this.putProject(project('one')); this.putProject(project('two'));
  }
  putProject(state: ReturnType<typeof project>) { this.raw.prepare('INSERT INTO project_state VALUES (?, ?, 1) ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json').run(state.project.id, JSON.stringify(state)); }
  getProject(id: string): ReturnType<typeof project> { return JSON.parse(String(this.raw.prepare('SELECT state_json FROM project_state WHERE project_id = ?').get(id)!.state_json)); }
  seedRecord(id: string, kind: string, data: unknown, origin = 'one') {
    this.raw.prepare('INSERT INTO order_directory_records VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)').run(id, kind, origin, JSON.stringify(data), '2026-11-01T00:00:00Z', 'Owner', '2026-11-01T00:00:00Z', 'Owner');
  }
  prepare(sql: string) {
    const statement = (values: unknown[] = []) => ({ sql, values, bind: (...bound: unknown[]) => statement(bound),
      all: async () => ({ results: this.raw.prepare(sql).all(...values as []) }),
      first: async () => this.raw.prepare(sql).get(...values as []) ?? null,
      run: async () => ({ meta: { changes: Number(this.raw.prepare(sql).run(...values as []).changes) } }) });
    return statement();
  }
  async batch(statements: { sql: string; values: unknown[] }[]) {
    return statements.map(({ sql, values }) => {
      if (this.failAudit && sql.startsWith('INSERT INTO order_directory_audit')) throw new Error('Synthetic audit storage failure');
      if (this.failMutation && (sql.startsWith('UPDATE order_directory_records') || sql.startsWith('INSERT INTO order_directory_records'))) return { meta: { changes: 0 } };
      return { meta: { changes: Number(this.raw.prepare(sql).run(...values as []).changes) } };
    });
  }
  async financialTransaction(work: (db: AtomicDatabase) => Promise<Response>) {
    this.transactions++; this.raw.exec('BEGIN');
    try { const result = await work(this); this.raw.exec(result.status >= 400 ? 'ROLLBACK' : 'COMMIT'); return result; }
    catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
  records() { return this.raw.prepare('SELECT * FROM order_directory_records ORDER BY id').all(); }
  audits() { return this.raw.prepare('SELECT * FROM order_directory_audit ORDER BY record_id, revision').all(); }
  projects() { return this.raw.prepare('SELECT * FROM project_state ORDER BY project_id').all(); }
}
const envFor = (db: AtomicDatabase) => ({ DB: db, OWNER_EMAIL: 'owner@example.test', OWNER_NAME: 'Owner' });
const handler = createOrderDirectoryHandler({ ensureSchema: async () => {} });
const request = (projectId = 'one', body?: unknown, headers = ownerHeaders) => new Request(`https://example.test/api/order-directory?projectId=${projectId}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const send = (db: AtomicDatabase, body?: unknown, headers = ownerHeaders, projectId = 'one') => handler(request(projectId, body, headers), envFor(db));
const partyInput = (id = 'party', name = 'Customer', expectedRevision = 0) => ({ record: { id, kind: 'party', data: { name, partyType: 'person', phone: '+70000000000' } }, expectedRevision, reason: 'Verified customer data' });
const refs = (db: AtomicDatabase, nextState: ReturnType<typeof project>, previousState: ReturnType<typeof project> | null = null, headers = ownerHeaders) => validateOrderDirectoryReferences({ db, request: request(nextState.project.id, undefined, headers), env: envFor(db), previousState, nextState });
const linkAsset = (state: ReturnType<typeof project>, id = 'asset') => { state.orderRelations.objects = [{ id: `scope-${state.project.id}`, assetId: id, title: 'Work on the shared house', status: 'planned', specifications: [] }]; return state; };
const agreementInput = () => ({ record: { id: 'master', kind: 'agreement', data: { name: 'Shared supplier contract', number: 'SUP-1', partyIds: ['supplier'], totalAmountCents: 60000007, currency: 'RUB', status: 'signed', signedDate: '2026-11-01', documentIds: ['signed-doc'], source: 'Private master source', notes: 'Private master allocation note' } }, expectedRevision: 0, reason: 'Signed shared supplier original' });
const seedAgreement = async (db: AtomicDatabase) => {
  db.seedRecord('supplier', 'party', { name: 'Original supplier', partyType: 'company', inn: '1234567890' });
  const one = db.getProject('one'); one.documents = [{ id: 'signed-doc', category: 'contract', status: 'signed', fileKey: 'one/contracts/original.pdf', clientVisible: false } as { id: string }]; db.putProject(one);
  const result = await send(db, agreementInput()); assert.equal(result.status, 200, await result.clone().text());
};
const localShare = (state: ReturnType<typeof project>, amountCents: number) => {
  state.orderRelations.contracts = [{ id: `part-${state.project.id}`, title: `Supplier part for ${state.project.id}`, kind: 'supplier', sharedAgreementId: 'master', number: 'SUP-1', partyIds: ['supplier'], objectIds: [], status: 'signed', currency: 'RUB', amountCents, signedDate: '2026-11-01', documentIds: [], source: 'Approved allocation for this order' }];
  state.orderRelations.changeReason = 'Allocate supplier contract'; return state;
};

test('directory creation and revision edits are atomic audited changes and leave all project money unchanged', async () => {
  const db = new AtomicDatabase(), before = db.projects();
  const created = await send(db, partyInput()); assert.equal(created.status, 200, await created.clone().text());
  const body = await created.json() as OrderDirectoryResponse;
  assert.equal(body.records[0].revision, 1); assert.equal(body.records[0].originProjectId, 'one'); assert.equal(body.records[0].canEdit, true);
  assert.equal(body.orders.length, 2); assert.equal(db.transactions, 1); assert.equal(db.audits().length, 1);
  const changed = await send(db, partyInput('party', 'Corrected customer name', 1)); assert.equal(changed.status, 200);
  assert.equal(db.records()[0].revision, 2); assert.equal(db.audits().length, 2); assert.deepEqual(db.projects(), before);
  assert.equal(db.audits()[1].actor, 'owner@example.test'); assert.equal(JSON.parse(String(db.audits()[0].payload_json)).name, 'Customer');
});

test('stale revisions conflict; successful retries and no-op edits never duplicate records or audit', async () => {
  const db = new AtomicDatabase(); assert.equal((await send(db, partyInput())).status, 200);
  const before = db.records();
  assert.equal((await send(db, partyInput())).status, 409); assert.deepEqual(db.records(), before); assert.equal(db.audits().length, 1);
  assert.equal((await send(db, partyInput('party', 'Customer', 1))).status, 200); assert.deepEqual(db.records(), before); assert.equal(db.audits().length, 1);
  assert.equal((await send(db, partyInput('party', 'New name', 1))).status, 200);
  assert.equal((await send(db, partyInput('party', 'Stale name', 1))).status, 409); assert.equal(db.audits().length, 2);
});

test('CAS failure and audit failure both roll back the record and its audit together', async () => {
  for (const failure of ['cas', 'audit']) {
    const db = new AtomicDatabase(); db.seedRecord('party', 'party', { name: 'Original', partyType: 'person' }); const before = db.records();
    if (failure === 'cas') db.failMutation = true; else db.failAudit = true;
    const result = await send(db, partyInput('party', 'After', 1));
    assert.equal(result.status, failure === 'cas' ? 409 : 500); assert.deepEqual(db.records(), before); assert.equal(db.audits().length, 0);
  }
});

test('writes fail closed without atomic transaction support; scoped reads remain available', async () => {
  const db = new AtomicDatabase(), withoutTransactions = { prepare: db.prepare.bind(db), batch: db.batch.bind(db) };
  const env = { ...envFor(db), DB: withoutTransactions };
  assert.equal((await handler(request('one', partyInput()), env)).status, 503); assert.equal(db.records().length, 0);
  assert.equal((await handler(request(), env)).status, 200);
});

test('GET returns only management-visible orders and referenced/originated records; hidden origins and money do not leak', async () => {
  const db = new AtomicDatabase();
  db.seedRecord('own-party', 'party', { name: 'Own customer', partyType: 'person' });
  db.seedRecord('shared-party', 'party', { name: 'Shared customer', partyType: 'person' }, 'two');
  db.seedRecord('hidden-party', 'party', { name: 'Hidden customer', partyType: 'person' }, 'two');
  const one = db.getProject('one'); one.orderRelations.customerId = 'shared-party'; one.project.unknownFields = ['contractValue']; db.putProject(one);
  const response = await send(db, undefined, headersFor('manager-one@example.test')); assert.equal(response.status, 200);
  const body = await response.json() as OrderDirectoryResponse, serialized = JSON.stringify(body);
  assert.deepEqual(body.records.map(row => row.id), ['own-party', 'shared-party']); assert.deepEqual(body.orders.map(row => row.id), ['one']);
  assert.equal(body.records.find(row => row.id === 'shared-party')!.originProjectId, undefined); assert.equal(body.orders[0].contractValue, null);
  for (const forbidden of ['hidden-party', 'Hidden customer', 'Project two', '987654321', 'private-finance', 'financeEntries', 'originProjectId":"two']) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('foreman, client, unauthenticated and out-of-scope current project requests cannot read or change directory', async () => {
  const db = new AtomicDatabase(); db.seedRecord('party', 'party', { name: 'Customer', partyType: 'person' });
  for (const headers of [headersFor('foreman@example.test'), headersFor('client@example.test'), headersFor('uninvited@example.test'), { 'content-type': 'application/json' }]) {
    for (const input of [undefined, partyInput('party', 'Modified', 1)]) {
      const response = await send(db, input, headers as typeof ownerHeaders); assert.equal(response.status, 403); assert.equal((await response.text()).includes('Customer'), false);
    }
  }
  assert.equal((await send(db, undefined, headersFor('manager-one@example.test'), 'two')).status, 403);
  assert.equal((await send(db, undefined, ownerHeaders, 'unknown-project')).status, 403); assert.equal(db.audits().length, 0);
});

test('local-membership project limits cannot be widened by a stored management role', async () => {
  const db = new AtomicDatabase(); db.seedRecord('hidden', 'party', { name: 'Other customer', partyType: 'person' }, 'two');
  const headers = { ...headersFor('manager-all@example.test'), 'oai-authenticated-user-access-mode': 'local-membership', 'oai-authenticated-user-projects': 'one' };
  const response = await send(db, undefined, headers), body = await response.json() as OrderDirectoryResponse;
  assert.deepEqual(body.orders.map(row => row.id), ['one']); assert.equal(body.records.length, 0);
  assert.equal((await send(db, undefined, headers, 'two')).status, 403);
});

test('a manager of one order may read a shared contact but only management of every referencing order may edit it', async () => {
  const db = new AtomicDatabase(); db.seedRecord('shared', 'party', { name: 'Shared', partyType: 'person' });
  for (const id of ['one', 'two']) { const state = db.getProject(id); state.orderRelations.customerId = 'shared'; db.putProject(state); }
  const preview = await (await send(db, undefined, headersFor('manager-one@example.test'))).json() as OrderDirectoryResponse;
  assert.equal(preview.records[0].canEdit, false); assert.deepEqual(preview.orders.map(row => row.id), ['one']);
  const denied = await send(db, partyInput('shared', 'Changed', 1), headersFor('manager-one@example.test'));
  assert.equal(denied.status, 403); assert.equal((await denied.text()).includes('two'), false); assert.equal(db.audits().length, 0);
  assert.equal((await send(db, partyInput('shared', 'Managed together', 1), headersFor('manager-all@example.test'))).status, 200);
  assert.equal((await send(db, partyInput('shared', 'Owner correction', 2))).status, 200);
});

test('asset, plot and landowner dependencies are shared transitively and protected across all referencing orders', async () => {
  const db = new AtomicDatabase();
  db.seedRecord('landowner', 'party', { name: 'Land owner', partyType: 'person' }, 'two');
  db.seedRecord('plot', 'plot', { name: 'Plot', ownerPartyIds: ['landowner'], cadastralNumber: '77:01:0001:1' }, 'two');
  db.seedRecord('asset', 'asset', { name: 'House', assetType: 'house', plotId: 'plot' }, 'two');
  for (const id of ['one', 'two']) db.putProject(linkAsset(db.getProject(id)));
  const body = await (await send(db, undefined, headersFor('manager-one@example.test'))).json() as OrderDirectoryResponse;
  assert.deepEqual(body.records.map(row => row.id), ['asset', 'landowner', 'plot']); assert.ok(body.records.every(row => !row.canEdit && row.originProjectId === undefined));
  assert.deepEqual(body.orders[0].assetIds, ['asset']); assert.deepEqual(body.orders[0].plotIds, ['plot']); assert.deepEqual(body.orders[0].participantPartyIds, ['landowner']);
  const denied = await send(db, partyInput('landowner', 'Replacement owner', 1), headersFor('manager-one@example.test'));
  assert.equal(denied.status, 403); assert.equal(db.audits().length, 0);
});

test('record identity is immutable; fake cross-scope references and exact cadastral duplicates are rejected', async () => {
  const db = new AtomicDatabase(); db.seedRecord('party', 'party', { name: 'Customer', partyType: 'person' });
  db.seedRecord('hidden-plot', 'plot', { name: 'Private plot', cadastralNumber: '77:01:0001:1' }, 'two');
  const typeChange = { record: { id: 'party', kind: 'plot', data: { name: 'New plot' } }, expectedRevision: 1, reason: 'Type change' };
  assert.equal((await send(db, typeChange)).status, 422);
  const badOrigin = { ...partyInput('new'), record: { ...partyInput('new').record, originProjectId: 'two' } };
  assert.equal((await send(db, badOrigin)).status, 422);
  const asset = { record: { id: 'asset', kind: 'asset', data: { name: 'House', assetType: 'house', plotId: 'hidden-plot' } }, expectedRevision: 0, reason: 'Link plot' };
  const denied = await send(db, asset, headersFor('manager-one@example.test')); assert.equal(denied.status, 422); assert.equal((await denied.text()).includes('Private plot'), false);
  const wrongKind = { ...asset, record: { ...asset.record, data: { ...asset.record.data, plotId: 'party' } } };
  assert.equal((await send(db, wrongKind)).status, 422);
  const duplicate = { record: { id: 'duplicate-plot', kind: 'plot', data: { name: 'Plot duplicate', cadastralNumber: '77:01:0001:1' } }, expectedRevision: 0, reason: 'Create' };
  assert.equal((await send(db, duplicate)).status, 422); assert.equal(db.audits().length, 0);
});

test('equal phone numbers never merge different canonical participants automatically', async () => {
  const db = new AtomicDatabase();
  assert.equal((await send(db, partyInput('first-person', 'First'))).status, 200);
  assert.equal((await send(db, partyInput('second-person', 'Second'))).status, 200);
  assert.equal(db.records().length, 2); assert.equal(db.audits().length, 2);
});

test('first draft save may reference an accessible existing customer while incoming state cannot grant directory access', async () => {
  const db = new AtomicDatabase(); db.seedRecord('customer', 'party', { name: 'Canonical customer', partyType: 'person', phone: '+70000000000' }, 'two');
  const draft = project('new-order'); draft.orderRelations.customerId = 'customer';
  assert.equal(await refs(db, draft), ''); assert.equal(draft.project.clientNames, 'Canonical customer');
  const current = db.getProject('one'), forged = structuredClone(current); forged.orderRelations.customerId = 'customer';
  const error = await refs(db, forged, current, headersFor('manager-one@example.test'));
  assert.match(error, /недоступен/); assert.equal(forged.project.clientNames, 'Legacy customer');
  const forgedDraft = project('new-forged'); forgedDraft.orderRelations.customerId = 'customer';
  assert.match(await refs(db, forgedDraft, null, headersFor('manager-all@example.test')), /доступ «Управление»/);
});

test('new signatures snapshot canonical names without contacts; later shared renames do not rewrite signed facts', async () => {
  const db = new AtomicDatabase(); db.seedRecord('customer', 'party', { name: 'Original name', partyType: 'person', phone: '+70000000000', email: 'private@example.test' });
  const state = linkAsset(db.getProject('one')); db.seedRecord('asset', 'asset', { name: 'House', assetType: 'house' });
  state.orderRelations.customerId = 'customer'; state.documents = [{ id: 'doc' }];
  state.orderRelations.contracts = [{ id: 'contract', kind: 'customer', title: 'Build', partyIds: ['customer'], objectIds: ['scope-one'], status: 'signed', currency: 'RUB', amountCents: 10000, signedDate: '2026-11-01', documentIds: ['doc'], source: 'Signed original', partySnapshots: [{ partyId: 'customer', name: 'Forged name', partyType: 'person' }] }];
  const before = db.getProject('one'); assert.equal(await refs(db, state, before), '');
  assert.deepEqual(state.orderRelations.contracts[0].partySnapshots, [{ partyId: 'customer', name: 'Original name', partyType: 'person' }]);
  state.orderRelations.changeReason = 'Attach signed agreement';
  assert.equal(validateOrderRelationsChanges(before, state, { role: 'management', name: 'Owner' }, '2026-11-04T12:00:00Z'), ''); db.putProject(state);
  assert.equal((await send(db, partyInput('customer', 'Current corrected name', 1))).status, 200);
  const next = structuredClone(state); assert.equal(await refs(db, next, state), '');
  assert.equal(next.project.clientNames, 'Current corrected name'); assert.equal(next.orderRelations.contracts[0].partySnapshots![0].name, 'Original name');
  assert.equal(JSON.stringify(next.orderRelations.contracts[0].partySnapshots).includes('phone'), false);
  assert.equal(validateOrderRelationsChanges(state, next, { role: 'management', name: 'Owner' }, '2026-11-04T13:00:00Z'), '');
});

test('unchanged private relations do not block foreman work or read the private directory', async () => {
  const db = new AtomicDatabase(), previous = db.getProject('one'), next = structuredClone(previous);
  previous.orderRelations.customerId = 'retained-private-party'; next.orderRelations = structuredClone(previous.orderRelations);
  const guardedDb = { prepare() { throw new Error('Directory must not be read for unchanged private relations'); } };
  const error = await validateOrderDirectoryReferences({ db: guardedDb, request: request('one', undefined, headersFor('foreman@example.test')), env: envFor(db), previousState: previous, nextState: next });
  assert.equal(error, ''); assert.equal(next.project.clientNames, 'Legacy customer');
});

test('scope limit fails closed instead of returning an incomplete authorization picture', async () => {
  const db = new AtomicDatabase();
  for (let index = 0; index < 499; index++) db.putProject(project(`extra-${index}`));
  const response = await send(db); assert.equal(response.status, 503); assert.equal((await response.json() as { error: string }).error, 'directory_scope_too_large');
});

test('one canonical supplier agreement is split across orders and over-allocation is rejected', async () => {
  const db = new AtomicDatabase(); await seedAgreement(db);
  const first = localShare(db.getProject('one'), 20000000), firstBefore = db.getProject('one');
  assert.equal(await refs(db, first, firstBefore), '');
  assert.equal(validateOrderRelationsChanges(firstBefore, first, { role: 'management', name: 'Owner' }, '2026-11-04T12:00:00Z'), ''); db.putProject(first);
  const secondBefore = db.getProject('two'), second = localShare(structuredClone(secondBefore), 40000007);
  assert.equal(await refs(db, second, secondBefore), '');
  assert.equal(validateOrderRelationsChanges(secondBefore, second, { role: 'management', name: 'Owner' }, '2026-11-04T12:00:00Z'), ''); db.putProject(second);
  assert.equal(first.orderRelations.contracts[0].amountCents! + second.orderRelations.contracts[0].amountCents!, 60000007);
  const overflow = structuredClone(second); overflow.orderRelations.contracts[0].amountCents!++;
  assert.match(await refs(db, overflow, second), /превышает полную сумму/);
  assert.equal(db.getProject('two').orderRelations.contracts[0].amountCents, 40000007);
  assert.equal(db.records().filter(row => row.kind === 'agreement').length, 1);
  assert.deepEqual(first.financeEntries, firstBefore.financeEntries); assert.equal(first.project.contractValue, firstBefore.project.contractValue);
});

test('signed supplier master terms and origin evidence remain immutable including publication', async () => {
  const db = new AtomicDatabase(); await seedAgreement(db);
  const stored = db.records(), update = { ...agreementInput(), expectedRevision: 1, record: { ...agreementInput().record, data: { ...agreementInput().record.data, totalAmountCents: 70000000 } } };
  const result = await send(db, update); assert.equal(result.status, 422); assert.deepEqual(db.records(), stored);
  const before = db.getProject('one');
  for (const alter of [
    (state: ReturnType<typeof project>) => { state.documents = []; },
    (state: ReturnType<typeof project>) => { Object.assign(state.documents[0], { fileKey: 'one/contracts/new.pdf' }); },
    (state: ReturnType<typeof project>) => { Object.assign(state.documents[0], { clientVisible: true }); },
  ]) {
    const next = structuredClone(before); alter(next);
    assert.match(await refs(db, next, before), /подписанного общего договора защищён/);
  }
  const legacy = structuredClone(before) as ReturnType<typeof project> & { orderRelations?: OrderRelationsState }; delete legacy.orderRelations;
  const nextLegacy = structuredClone(legacy); nextLegacy.documents = [];
  assert.match(await refs(db, nextLegacy as ReturnType<typeof project>, legacy as ReturnType<typeof project>), /подписанного общего договора защищён/);
});

test('shared master is signed only from private signed evidence and cannot authorize a customer-price share', async () => {
  const db = new AtomicDatabase(); db.seedRecord('supplier', 'party', { name: 'Supplier', partyType: 'company' });
  const one = db.getProject('one'); one.documents = [{ id: 'signed-doc', category: 'contract', status: 'signed', fileKey: 'one/contracts/original.pdf', clientVisible: true } as { id: string }]; db.putProject(one);
  assert.equal((await send(db, agreementInput())).status, 422); assert.equal(db.records().filter(row => row.kind === 'agreement').length, 0);
  Object.assign(one.documents[0], { clientVisible: false }); db.putProject(one);
  assert.equal((await send(db, agreementInput())).status, 200);
  const badKind = localShare(db.getProject('one'), 100); badKind.orderRelations.contracts[0].kind = 'customer';
  assert.match(await refs(db, badKind, one), /подрядный договор/);
  const badTerms = localShare(db.getProject('one'), 100); badTerms.orderRelations.contracts[0].number = 'different-contract';
  assert.match(await refs(db, badTerms, one), /номер и договорные даты/);
});

test('partial managers see their supplier share but no total or private terms of orders outside their scope', async () => {
  const db = new AtomicDatabase(); await seedAgreement(db);
  for (const id of ['one', 'two']) { const state = localShare(db.getProject(id), 20000000); assert.equal(await refs(db, state, db.getProject(id)), ''); db.putProject(state); }
  const response = await send(db, undefined, headersFor('manager-one@example.test')), body = await response.json() as OrderDirectoryResponse;
  const master = body.records.find(row => row.kind === 'agreement'); assert.ok(master && master.kind === 'agreement');
  assert.equal(master.canEdit, false); assert.equal(master.limitedScope, true);
  assert.equal(master.data.totalAmountCents, undefined); assert.equal(master.data.source, undefined); assert.equal(master.data.notes, undefined); assert.equal(master.data.documentIds, undefined);
  const serialized = JSON.stringify(body);
  for (const value of ['60000007', 'Private master source', 'Private master allocation note', 'Project two', '987654321']) assert.equal(serialized.includes(value), false, value);
  const all = await (await send(db, undefined, headersFor('manager-all@example.test'))).json() as OrderDirectoryResponse;
  const complete = all.records.find(row => row.kind === 'agreement'); assert.ok(complete && complete.kind === 'agreement');
  assert.equal(complete.data.totalAmountCents, 60000007); assert.equal(complete.limitedScope, undefined); assert.equal(complete.canEdit, false);
});

test('local supplier signatures use the frozen master parties after canonical contact corrections', async () => {
  const db = new AtomicDatabase(); await seedAgreement(db);
  assert.equal((await send(db, { record: { id: 'supplier', kind: 'party', data: { name: 'Current supplier name', partyType: 'company', inn: '1234567890' } }, expectedRevision: 1, reason: 'Verified current legal name' })).status, 200);
  const next = localShare(db.getProject('two'), 100); assert.equal(await refs(db, next, db.getProject('two')), '');
  assert.equal(next.orderRelations.contracts[0].partySnapshots![0].name, 'Original supplier');
});

test('the same signed master original and file aliases cannot create another allocation ceiling under a new UUID', async () => {
  const db = new AtomicDatabase(); await seedAgreement(db);
  const retry = agreementInput(); retry.record.id = 'duplicate-master';
  const result = await send(db, retry); assert.equal(result.status, 422); assert.equal((await result.json() as { error: string }).error, 'duplicate_agreement_evidence');
  const other = db.getProject('two'); other.documents = [{ id: 'alias', category: 'contract', status: 'signed', fileKey: 'one/contracts/original.pdf', clientVisible: false } as { id: string }]; db.putProject(other);
  const alias = agreementInput(); alias.record.id = 'alias-master'; alias.record.data.documentIds = ['alias'];
  assert.equal((await send(db, alias, ownerHeaders, 'two')).status, 422);
  const first = db.getProject('one'); Object.assign(first.documents[0], { sourceSha256: 'a'.repeat(64) }); db.putProject(first);
  Object.assign(other.documents[0], { fileKey: 'two/contracts/copy.pdf', sourceSha256: 'a'.repeat(64) }); db.putProject(other);
  const sameBytes = await send(db, alias, ownerHeaders, 'two'); assert.equal(sameBytes.status, 422);
  assert.equal((await sameBytes.json() as { error: string }).error, 'duplicate_agreement_evidence');
  assert.equal(db.records().filter(row => row.kind === 'agreement').length, 1); assert.equal(db.audits().length, 1);
});
