import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { stateForRole, mergeStateForRole } from '../sites/access-control.js';
import { createFileHandlers } from '../sites/files/routes.js';
import { createProjectWriteHandler } from '../sites/projects/write.js';
import { toPostgresSql } from '../server/postgres.js';
import { seedState } from '../src/seed.ts';
import { emptyTreasury, validateTreasuryChanges } from '../src/domain/treasury.js';
import { createTreasuryUseCases, treasurySnapshot } from '../src/application/treasury.ts';
import { createProjectTreasuryRepository, treasuryReadModel } from '../src/infrastructure/treasury-project.ts';
import { applyLocalChange, createSyncModel, reconcileRemoteSnapshot, reconcileSavedSnapshot } from '../src/application/project-sync.ts';
import { approveExpenseEntry, acceptExpenseEntry, recordPaymentEntry, validateFinanceChanges } from '../src/domain/finance/index.js';

const manager = { role: 'management' as const, name: 'Управление', id: 'manager' };
const privacyFixture = () => ({
  ...structuredClone(seedState),
  project: { ...seedState.project, id: 'project-1' },
  settings: { ...seedState.settings, users: [
    { id: 'foreman', email: 'foreman@example.test', name: 'Прораб', role: 'foreman', status: 'active' },
    { id: 'client', email: 'client@example.test', name: 'Клиент', role: 'client', status: 'active' },
  ] },
  treasury: { ...emptyTreasury(), enabled: true },
  financeEntries: [
    { id: 'expense', kind: 'expense', paymentDocumentId: 'payment', payments: [{ documentId: 'old-payment' }] },
    { id: 'income', kind: 'income' },
  ],
  documents: [
    { id: 'technical', name: 'Рабочий чертёж', clientVisible: true, fileKey: 'project-1/drawing.pdf' },
    { id: 'payment', name: 'ПП 100000', clientVisible: false, fileKey: 'project-1/payment.pdf' },
    { id: 'old-payment', name: 'ПП 80000', clientVisible: false, fileKey: 'project-1/old-payment.pdf' },
    { id: 'invoice', name: 'Счёт поставщика', financeEntryId: 'expense', clientVisible: true, fileKey: 'project-1/invoice.pdf' },
    { id: 'alias', name: 'Публичный псевдоним', clientVisible: true, fileKey: 'project-1/payment.pdf' },
    { id: 'client-invoice', name: 'Счёт клиенту', financeEntryId: 'income', clientVisible: true, fileKey: 'project-1/client-invoice.pdf' },
  ],
  activity: [{ id: 'private-event', text: 'Оплачено 100 000 ₽', timestamp: '2026-10-01', actor: 'Управление', tone: 'positive' }],
});

test('restricted project snapshots omit balances, financial evidence aliases and unclassified payment activity', () => {
  const state = privacyFixture();
  const foreman = stateForRole(state, { role: 'foreman', id: 'foreman' });
  const client = stateForRole(state, { role: 'client', id: 'client' });
  assert.equal('treasury' in foreman, false);
  assert.equal('treasury' in client, false);
  assert.deepEqual(foreman.documents.map((document: { id: string }) => document.id), ['technical']);
  assert.deepEqual(client.documents.map((document: { id: string }) => document.id), ['technical', 'client-invoice']);
  assert.deepEqual(foreman.activity, []);
  assert.deepEqual(foreman.financeEntries, []);
  assert.equal(state.documents.length, 6);
  assert.equal(state.activity.length, 1);
});

test('restricted saves preserve unseen financial documents and history, rejecting aliases and spoofed prior IDs', () => {
  const previous = privacyFixture();
  const incoming = stateForRole(previous, { role: 'foreman', id: 'foreman' });
  incoming.documents.push({ id: 'payment', name: 'Подмена', fileKey: 'project-1/replacement.pdf', clientVisible: true });
  incoming.documents.push({ id: 'new-alias', name: 'Подмена ссылки', fileKey: 'project-1/payment.pdf', clientVisible: true });
  incoming.activity = [{ id: 'private-event', text: 'Подмена' }, { id: 'new-work-event', text: 'Этап обновлён' }];
  const merged = mergeStateForRole(previous, incoming, { role: 'foreman', id: 'foreman' });
  assert.deepEqual(merged.documents.find((document: { id: string }) => document.id === 'payment'), previous.documents[1]);
  assert.equal(merged.documents.some((document: { id: string }) => document.id === 'new-alias'), false);
  assert.equal(merged.documents.length, previous.documents.length);
  assert.deepEqual(merged.activity.find((event: { id: string }) => event.id === 'private-event'), previous.activity[0]);
  assert.equal(merged.activity[0].id, 'new-work-event');
  assert.deepEqual(merged.treasury, previous.treasury);
});

test('private financial file downloads fail closed before bucket reads for foreman and client', async () => {
  const state = privacyFixture();
  const handlers = createFileHandlers({ ensureSchema: async () => undefined, readSnapshot: async () => ({ state }) });
  let reads = 0;
  const env = { DB: {}, BUCKET: { get: async () => { reads++; return { body: 'file' }; } } };
  for (const email of ['foreman@example.test', 'client@example.test']) {
    const response = await handlers.documentFile(new Request('https://app.test/api/documents/file?projectId=project-1&key=project-1%2Fpayment.pdf', {
      headers: { 'oai-authenticated-user-email': email },
    }), env);
    assert.equal(response.status, 404);
  }
  assert.equal(reads, 0);
  const clientInvoice = await handlers.documentFile(new Request('https://app.test/api/documents/file?projectId=project-1&key=project-1%2Fclient-invoice.pdf', {
    headers: { 'oai-authenticated-user-email': 'client@example.test' },
  }), env);
  assert.equal(clientInvoice.status, 200);
  assert.equal(reads, 1);
});

test('a report or quality photo alias cannot expose the bytes of private financial evidence', async () => {
  const state = privacyFixture();
  state.documents[1].fileKey = 'project-1/quality/checkpoint/private.png';
  state.fieldReports = [{ id: 'report', clientVisible: true, attachments: [{ key: state.documents[1].fileKey }] }] as typeof state.fieldReports;
  state.checkpoints = [{ id: 'checkpoint', clientVisible: true, photos: [{ fileKey: state.documents[1].fileKey }] }] as typeof state.checkpoints;
  const handlers = createFileHandlers({ ensureSchema: async () => undefined, readSnapshot: async () => ({ state }) });
  let reads = 0;
  for (const route of [handlers.qualityPhotoFile, handlers.fieldReportFile]) {
    for (const email of ['foreman@example.test', 'client@example.test']) {
      const response = await route(new Request(`https://app.test/api/files?projectId=project-1&key=${encodeURIComponent(state.documents[1].fileKey!)}`, {
        headers: { 'oai-authenticated-user-email': email },
      }), { DB: {}, BUCKET: { get: async () => { reads++; return { body: 'private bytes' }; } } });
      assert.equal(response.status, 404);
    }
  }
  assert.equal(reads, 0);
});

test('treasury repository rejects stale financial and task references, preserves unrelated updates and project isolation', () => {
  let state = structuredClone(seedState);
  let writes = 0;
  const repository = createProjectTreasuryRepository(() => state, next => { state = next; writes++; });
  const commands = createTreasuryUseCases(repository, manager);
  const next = { ...emptyTreasury(), enabled: true };
  const firstSnapshot = treasurySnapshot(treasuryReadModel(state));
  state.tasks = [...state.tasks, { id: 'new-task' } as typeof state.tasks[number]];
  assert.equal(commands.save(next, firstSnapshot).ok, false);
  const taskSnapshot = treasurySnapshot(treasuryReadModel(state));
  state.financeEntries = [...state.financeEntries, { id: 'new-entry' } as typeof state.financeEntries[number]];
  assert.equal(commands.save(next, taskSnapshot).ok, false);
  const freshSnapshot = treasurySnapshot(treasuryReadModel(state));
  state.project.name = 'Свежая правка имени';
  assert.equal(commands.save(next, freshSnapshot).ok, true);
  assert.equal(state.project.name, 'Свежая правка имени');
  assert.equal(writes, 1);
  assert.equal(createTreasuryUseCases(repository, { ...manager, role: 'foreman' }).save(next, treasurySnapshot(treasuryReadModel(state))).ok, false);
  state.project.id = 'another-project';
  assert.equal(commands.save(next, treasurySnapshot(treasuryReadModel(state))).ok, false);
  assert.equal(writes, 1);
});

test('older management payloads retain additive planning data while explicit deletion remains visible to validation', () => {
  const previous = privacyFixture();
  const incoming = { ...previous };
  delete (incoming as { treasury?: unknown }).treasury;
  assert.deepEqual(mergeStateForRole(previous, incoming, { ...manager, isOwner: true }).treasury, previous.treasury);
  assert.equal(mergeStateForRole(previous, { ...incoming, treasury: null }, { ...manager, isOwner: true }).treasury, null);
});

test('sync retains a local treasury plan across unrelated remote changes and stops concurrent plan edits', () => {
  const initial = structuredClone(seedState);
  initial.treasury = { ...emptyTreasury(), enabled: true, reserveCents: 0 };
  const model = createSyncModel({ state: initial, revision: 1 });
  const local = structuredClone(initial);
  local.treasury!.reserveCents = 100;
  local.treasury!.changeReason = 'Создан резерв';
  const remote = structuredClone(initial);
  remote.project.name = 'Название уточнено';
  const dirty = applyLocalChange(model, local);
  const merged = reconcileRemoteSnapshot(dirty, { state: remote, revision: 2 });
  assert.equal(merged.kind, 'save');
  assert.equal(merged.model.state.treasury?.reserveCents, 100);
  assert.equal(merged.model.state.project.name, remote.project.name);
  remote.treasury!.reserveCents = 200;
  remote.treasury!.changeReason = 'Резерв другого пользователя';
  const conflict = reconcileRemoteSnapshot(dirty, { state: remote, revision: 2 });
  assert.equal(conflict.kind, 'conflict');
  if (conflict.kind === 'conflict') assert.deepEqual(conflict.conflicts, ['treasury']);
  assert.equal(conflict.model.state.treasury?.reserveCents, 100);
});

test('acknowledgement retains a later treasury edit while accepting server-owned audit history', () => {
  const initial = structuredClone(seedState);
  initial.treasury = { ...emptyTreasury(), enabled: true, reserveCents: 0 };
  const sent = structuredClone(initial);
  sent.treasury!.reserveCents = 100;
  sent.treasury!.changeReason = 'Первое изменение';
  const server = structuredClone(sent);
  assert.equal(validateTreasuryChanges(initial, server, manager, '2026-10-28T09:00:00Z'), '');
  const later = structuredClone(sent);
  later.treasury!.reserveCents = 200;
  later.treasury!.changeReason = 'Следующее изменение';
  const dirty = applyLocalChange(createSyncModel({ state: initial, revision: 1 }), later);
  const acknowledged = reconcileSavedSnapshot(dirty, sent, { state: server, revision: 2 });
  assert.equal(acknowledged.state.treasury?.reserveCents, 200);
  assert.equal(acknowledged.state.treasury?.changeReason, 'Следующее изменение');
  assert.deepEqual(acknowledged.state.treasury?.history, server.treasury?.history);
  assert.equal(validateTreasuryChanges(server, structuredClone(acknowledged.state), manager, '2026-10-28T09:01:00Z'), '');
});

test('two partial payments submitted while a write is in flight retain the first immutable receipt and distinct second payment', () => {
  const initial = structuredClone(seedState);
  initial.financeEntries = [{ id: 'expense', kind: 'expense', status: 'committed', amount: 100.30, date: '2026-10-28',
    description: 'Материалы', counterparty: 'Поставщик', approvedAt: '2026-10-28T08:00:00Z', approvedBy: manager.name }];
  const first = recordPaymentEntry(initial, initial.financeEntries[0], { amount: 30.10, date: '2026-10-28', document: 'ПП 1' }, manager);
  assert.ok(first.ok); if (!first.ok) return;
  const sent = { ...structuredClone(initial), financeEntries: [first.entry] };
  const second = recordPaymentEntry(sent, sent.financeEntries[0], { amount: 70.20, date: '2026-10-29', document: 'ПП 2' }, manager);
  assert.ok(second.ok); if (!second.ok) return;
  const later = { ...structuredClone(sent), financeEntries: [second.entry] };
  const server = structuredClone(sent);
  assert.equal(validateFinanceChanges(initial, server, manager, '2026-10-28T09:00:00Z'), '');
  const dirty = applyLocalChange(createSyncModel({ state: initial, revision: 1 }), later);
  const acknowledged = reconcileSavedSnapshot(dirty, sent, { state: server, revision: 2 });
  assert.equal(acknowledged.state.financeEntries[0].paidAmount, 100.30);
  assert.deepEqual(acknowledged.state.financeEntries[0].payments, server.financeEntries[0].payments);
  const final = structuredClone(acknowledged.state);
  assert.equal(validateFinanceChanges(server, final, manager, '2026-10-29T09:00:00Z'), '');
  assert.deepEqual(final.financeEntries[0].payments?.map(payment => [payment.amount, payment.document, payment.date]), [
    [30.10, 'ПП 1', '2026-10-28'], [70.20, 'ПП 2', '2026-10-29'],
  ]);
  assert.equal(final.financeEntries[0].acceptedAmount, 0);
});

test('acknowledging an unrelated write preserves unsent approval, payment and acceptance actions', () => {
  for (const action of ['approve', 'pay', 'accept']) {
    const initial = structuredClone(seedState);
    initial.stages = [{ ...initial.stages[0], id: 'stage', status: 'accepted' }];
    initial.financeEntries = [{ id: 'expense', kind: 'expense', status: 'committed', amount: 100, date: '2026-10-28',
      description: 'Работы', counterparty: 'Подрядчик', stageId: 'stage',
      ...(action === 'approve' ? {} : { approvedAt: '2026-10-28T08:00:00Z', approvedBy: manager.name }) }];
    const sent = structuredClone(initial);
    sent.project.name = 'Имя из уже отправленного запроса';
    const fact = { amount: 20, date: '2026-10-28', document: 'Основание', source: 'stage:stage' };
    const result = action === 'approve' ? approveExpenseEntry(sent.financeEntries[0], manager, '2026-10-28T10:00:00Z')
      : action === 'pay' ? recordPaymentEntry(sent, sent.financeEntries[0], fact, manager)
        : acceptExpenseEntry(sent, sent.financeEntries[0], fact, manager);
    assert.ok(result.ok, action); if (!result.ok) continue;
    const later = { ...structuredClone(sent), financeEntries: [result.entry] };
    const server = structuredClone(sent);
    assert.equal(validateFinanceChanges(initial, server, manager, '2026-10-28T09:00:00Z'), '');
    const dirty = applyLocalChange(createSyncModel({ state: initial, revision: 1 }), later);
    const acknowledged = reconcileSavedSnapshot(dirty, sent, { state: server, revision: 2 });
    assert.deepEqual(acknowledged.state.financeEntries[0], result.entry, `${action}: unsent fact and actor must survive`);
    assert.equal(validateFinanceChanges(server, structuredClone(acknowledged.state), manager, '2026-10-28T10:01:00Z'), '');
  }
});

// Execute the actual generated SQL against SQLite, the original D1 dialect.
// The Postgres adapter's placeholder conversion is checked on the same statements.
class TestDatabase {
  readonly raw = new DatabaseSync(':memory:');
  statements: { sql: string; values: unknown[] }[] = [];
  constructor() {
    this.raw.exec(`CREATE TABLE project_state (project_id TEXT PRIMARY KEY, state_json TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT, updated_at TEXT, updated_by TEXT, updated_role TEXT);
      CREATE TABLE audit_log (id TEXT PRIMARY KEY, project_id TEXT, revision INTEGER, created_at TEXT, actor TEXT, role TEXT, action TEXT CHECK(action <> 'force_audit_failure'), summary TEXT, state_bytes INTEGER);`);
  }
  prepare(sql: string) {
    return { bind: (...values: unknown[]) => ({ sql, values }) };
  }
  async batch(statements: { sql: string; values: unknown[] }[]) {
    this.statements.push(...statements);
    this.raw.exec('BEGIN');
    try {
      const results = statements.map(statement => ({ meta: { changes: Number(this.raw.prepare(statement.sql).run(...statement.values as never[]).changes) } }));
      this.raw.exec('COMMIT');
      return results;
    } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
  }
  read() {
    const row = this.raw.prepare('SELECT * FROM project_state WHERE project_id = ?').get('project-1');
    return row ? { state: JSON.parse(String(row.state_json)), revision: row.revision } : null;
  }
  auditCount() { return Number(this.raw.prepare('SELECT COUNT(*) AS count FROM audit_log').get()?.count); }
}
const writeRequest = (action: string, expectedRevision = 0) => new Request('https://app.test/api/state?projectId=project-1', {
  method: 'PUT', headers: { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@example.test' },
  body: JSON.stringify({ projectId: 'project-1', expectedRevision, action, state: { version: 1, project: { id: 'project-1' }, settings: { users: [] } } }),
});
const testWriteHandler = (db: TestDatabase) => createProjectWriteHandler({
  ensureSchema: async () => undefined, readSnapshot: async () => db.read(),
  changes: (result: { meta: { changes: number } }) => result.meta.changes,
  applyAutomations: (_previous: unknown, state: unknown) => state,
  buildNotificationPlan: async () => ({ deliveries: [] }), dispatchNotifications: async () => undefined,
});

test('state and audit commit together, retry does not duplicate facts, and SQL converts for PostgreSQL', async () => {
  const db = new TestDatabase();
  try {
    const write = testWriteHandler(db), env = { DB: db, OWNER_EMAIL: 'owner@example.test' }, context = { waitUntil() {} };
    assert.equal((await write(writeRequest('project_create'), env, context)).status, 200);
    assert.equal(db.read()?.revision, 1);
    assert.equal(db.auditCount(), 1);
    assert.equal((await write(writeRequest('project_create'), env, context)).status, 409);
    assert.equal(db.read()?.revision, 1);
    assert.equal(db.auditCount(), 1);
    for (const statement of db.statements) {
      const converted = toPostgresSql(statement.sql);
      assert.doesNotMatch(converted, /\?|INSERT OR IGNORE/);
      assert.equal((converted.match(/\$\d+/g) ?? []).length, statement.values.length);
    }
  } finally { db.raw.close(); }
});

test('audit failure rolls back the monetary state rather than acknowledging an unaudited save', async () => {
  const db = new TestDatabase();
  try {
    const response = await testWriteHandler(db)(writeRequest('force_audit_failure'), { DB: db, OWNER_EMAIL: 'owner@example.test' }, { waitUntil() {} });
    assert.equal(response.status, 500);
    assert.equal(db.read(), null);
    assert.equal(db.auditCount(), 0);
  } finally { db.raw.close(); }
});
