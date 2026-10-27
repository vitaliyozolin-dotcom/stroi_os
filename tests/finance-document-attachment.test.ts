import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { financeTotals } from '../src/domain/finance-totals.js';
import { validateFinanceChanges } from '../src/domain/finance/index.js';
import { attachFinanceDocument, type AttachFinanceDocumentCommand } from '../src/application/finance-context-facts.ts';
import { createFinanceUseCases } from '../src/application/finance.ts';
import { financeFactsSnapshot, applyFinanceFactsResult, createProjectFinanceRepository } from '../src/infrastructure/finance-project.ts';

const timestamp = '2026-10-28T12:00:00Z';
const context = () => { let id = 0; return { identity: { name: 'Управляющий', role: 'management' as const }, clock: { now: () => timestamp }, ids: { next: (prefix: string) => `${prefix}-${++id}` } }; };
const fixture = () => {
  const state = structuredClone(seedState);
  state.project.id = 'attachment-project'; state.documents = []; state.activity = [];
  state.financeEntries = [{ id: 'expense', kind: 'expense', status: 'committed', amount: 100.25, date: '2026-10-28', counterparty: 'Поставщик', description: 'Материалы', stageId: 'stage', counterpartyId: 'supplier' }];
  return state;
};
const file = { key: 'attachment-project/invoice.pdf', name: 'invoice.pdf', type: 'application/pdf', size: 1234, uploadedAt: timestamp };
const input: AttachFinanceDocumentCommand = { entryId: 'expense', category: 'invoice', document: 'Счёт №1', uploadedFile: file };

test('invoice attaches before approval without changing money, statuses, ledger or acceptance', () => {
  const state = fixture(), before = structuredClone(state), ctx = context();
  const result = attachFinanceDocument(financeFactsSnapshot(state), input, ctx);
  assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
  assert.deepEqual(result.change.patch, {});
  const applied = applyFinanceFactsResult(state, result);
  assert.ok(applied.ok && applied.change); if (!applied.ok || !applied.change) return;
  const next = applied.change.state;
  assert.equal(next.financeEntries, state.financeEntries);
  assert.deepEqual(financeTotals(next), financeTotals(before));
  assert.equal(next.financeEntries[0].approvedAt, undefined);
  assert.equal(next.financeEntries[0].acceptedAmount, undefined);
  assert.equal(next.financeEntries[0].paidAmount, undefined);
  assert.equal(next.financeEntries[0].payments, undefined);
  assert.deepEqual([next.documents[0].fileKey, next.documents[0].fileName, next.documents[0].mimeType, next.documents[0].sizeBytes, next.documents[0].uploadedAt], [file.key, file.name, file.type, file.size, file.uploadedAt]);
  assert.equal(next.documents[0].financeEntryId, 'expense'); assert.equal(next.documents[0].category, 'invoice');
  assert.equal(next.documents[0].clientVisible, false); assert.equal(next.documents[0].documentDate, undefined, 'upload date is not invented invoice date');
  assert.equal(validateFinanceChanges(state, structuredClone(next), ctx.identity, timestamp), '');
  assert.deepEqual(state, before);
});

test('same file and entry retry is no-op in command and adapter, with one repository write and audit', () => {
  let state = fixture(), writes = 0; const ctx = context();
  const pending = attachFinanceDocument(financeFactsSnapshot(state), input, ctx);
  const commands = createFinanceUseCases(createProjectFinanceRepository(() => state, next => { state = next; writes++; }), ctx);
  assert.equal(commands.attachDocument(input).ok, true);
  assert.deepEqual(commands.attachDocument(input), { ok: true, change: null });
  assert.deepEqual(applyFinanceFactsResult(state, pending), { ok: true, change: null });
  assert.equal(writes, 1); assert.equal(state.documents.length, 1); assert.equal(state.activity.length, 1);
  assert.equal(state.activity[0].text, 'Прикреплён счёт · Материалы');
  state.financeEntries.push({ ...state.financeEntries[0], id: 'second' });
  assert.equal(commands.attachDocument({ ...input, entryId: 'second' }).ok, true);
  assert.equal(state.documents.length, 2, 'same source can support another operation with its own private link');
});

test('existing original is linked privately without changing its previous relation or existing payment history', () => {
  const state = fixture(), ctx = context();
  Object.assign(state.financeEntries[0], { status: 'paid', acceptedAmount: 0, paidAmount: 100.25, payments: [{ id: 'p1', amount: 100.25, date: '2026-10-27', document: 'ПП', recordedAt: timestamp, recordedBy: 'Кассир' }] });
  state.documents = [{ id: 'original', name: 'Исходный счёт', category: 'invoice', type: 'Счёт', status: 'current', updatedAt: timestamp, clientVisible: false, financeEntryId: 'another-entry', fileKey: file.key, fileName: file.name, mimeType: file.type, sizeBytes: file.size, uploadedAt: file.uploadedAt, documentDate: '2026-10-25', number: '45' }];
  const before = structuredClone(state);
  const result = attachFinanceDocument(financeFactsSnapshot(state), { entryId: 'expense', category: 'invoice', documentId: 'original' }, ctx);
  const applied = applyFinanceFactsResult(state, result);
  assert.ok(applied.ok && applied.change); if (!applied.ok || !applied.change) return;
  const next = applied.change.state;
  assert.deepEqual(next.financeEntries, before.financeEntries);
  assert.deepEqual(next.documents[1], before.documents[0]);
  assert.equal(next.documents[0].fileKey, before.documents[0].fileKey);
  assert.equal(next.documents[0].documentDate, '2026-10-25'); assert.equal(next.documents[0].number, '45');
  assert.equal(next.documents[0].financeEntryId, 'expense'); assert.equal(next.documents[0].clientVisible, false);
  assert.equal(validateFinanceChanges(state, structuredClone(next), ctx.identity, timestamp), '');
  assert.deepEqual(attachFinanceDocument(financeFactsSnapshot(next), { entryId: 'expense', category: 'invoice', documentId: 'original' }, ctx), { ok: true, change: null });
});

test('attachments enforce management, actual current-project files and category without persistence on failure', () => {
  const state = fixture(), ctx = context();
  for (const role of ['foreman', 'client'] as const) {
    const commands = createFinanceUseCases(createProjectFinanceRepository(() => state, () => assert.fail('forbidden write')), { ...ctx, identity: { name: role, role } });
    assert.equal(commands.attachDocument(input).ok, false);
  }
  const commands = createFinanceUseCases(createProjectFinanceRepository(() => state, () => assert.fail('invalid evidence write')), ctx);
  for (const bad of [
    { ...input, uploadedFile: undefined },
    { ...input, uploadedFile: { ...file, key: 'foreign/invoice.pdf' } },
    { ...input, uploadedFile: { ...file, key: 'attachment-project/../invoice.pdf' } },
    { ...input, uploadedFile: { ...file, size: -1 } },
    { ...input, documentId: 'missing' },
    { ...input, uploadedFile: undefined, documentId: 'missing' },
    { ...input, entryId: 'missing' },
    { ...input, category: 'act' as 'invoice' },
  ]) assert.equal(commands.attachDocument(bad).ok, false);
  for (const source of [
    { id: 'source', fileKey: file.key, clientVisible: true },
    { id: 'source', fileKey: 'foreign/invoice.pdf', clientVisible: false },
    { id: 'source', fileKey: undefined, clientVisible: false },
  ]) {
    state.documents = [{ name: 'Счёт', type: 'Счёт', status: 'current', updatedAt: timestamp, ...source }];
    assert.equal(commands.attachDocument({ entryId: 'expense', category: 'invoice', documentId: 'source' }).ok, false);
  }
});

test('evaluated attachment rejects stale finance/project/evidence but preserves unrelated concurrent documents', () => {
  for (const mutate of [
    (state: ReturnType<typeof fixture>) => { state.financeEntries[0].amount = 200; },
    (state: ReturnType<typeof fixture>) => { state.financeEntries = []; },
    (state: ReturnType<typeof fixture>) => { state.project.id = 'another'; },
  ]) {
    const state = fixture(), pending = attachFinanceDocument(financeFactsSnapshot(state), input, context());
    mutate(state); const before = structuredClone(state);
    assert.equal(applyFinanceFactsResult(state, pending).ok, false); assert.deepEqual(state, before);
  }
  const state = fixture();
  state.documents = [{ id: 'source', name: 'Счёт', type: 'Счёт', status: 'current', updatedAt: timestamp, clientVisible: false, fileKey: file.key }];
  const pending = attachFinanceDocument(financeFactsSnapshot(state), { entryId: 'expense', category: 'invoice', documentId: 'source' }, context());
  const changed = structuredClone(state); changed.documents[0].fileKey = 'attachment-project/replaced.pdf';
  assert.equal(applyFinanceFactsResult(changed, pending).ok, false);
  state.documents.push({ ...state.documents[0], id: 'unrelated', fileKey: 'attachment-project/unrelated.pdf' });
  const applied = applyFinanceFactsResult(state, pending);
  assert.ok(applied.ok && applied.change); if (!applied.ok || !applied.change) return;
  assert.equal(applied.change.state.documents[2].id, 'unrelated');
});
