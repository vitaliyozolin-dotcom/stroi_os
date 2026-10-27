import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import { acceptedAmountFor } from '../src/domain/finance-totals.js';
import { validateFinanceChanges } from '../src/domain/finance/index.js';
import { recordFinancePayment, acceptFinanceExpense, type FactCommand } from '../src/application/finance-context-facts.ts';
import { financeFactsSnapshot, applyFinanceFactsResult } from '../src/infrastructure/finance-project.ts';

const timestamp = '2026-10-28T12:00:00Z';
const identity = { name: 'Управляющий', role: 'management' as const };
const context = () => { let id = 0; return { identity, clock: { now: () => timestamp }, ids: { next: (prefix: string) => `${prefix}-${++id}` } }; };
const fixture = () => {
  const state = structuredClone(seedState);
  state.project.id = 'advance-project';
  state.documents = [];
  state.stages = [{ ...state.stages[0], id: 'stage', status: 'planned' }];
  state.financeEntries = [{ id: 'advance', kind: 'expense', status: 'committed', amount: 100.30, date: '2026-10-28', description: 'Аванс за материалы', counterparty: 'Поставщик', stageId: 'stage', approvedAt: timestamp, approvedBy: identity.name }];
  return state;
};
const fact = (amount: number): FactCommand => ({ entryId: 'advance', amount, date: '2026-10-28', document: 'ПП №1' });

test('financial facts reject money outside the exact integer-cent range', () => {
  const state = fixture();
  state.financeEntries[0].amount = 100_000_000_000_000;
  const input = recordFinancePayment(financeFactsSnapshot(state), fact(100_000_000_000_000), context());
  assert.equal(input.ok, false);
  const candidate = structuredClone(state);
  candidate.financeEntries[0].paidAmount = 1;
  candidate.financeEntries[0].paidAt = '2026-10-28';
  candidate.financeEntries[0].paymentDocument = 'ПП';
  assert.match(validateFinanceChanges(fixture(), candidate, identity, timestamp), /Суммы/);
});
const payment = (state: ReturnType<typeof fixture>, input: FactCommand, ctx = context()) => {
  const result = recordFinancePayment(financeFactsSnapshot(state), input, ctx);
  const applied = applyFinanceFactsResult(state, result);
  assert.ok(applied.ok && applied.change);
  if (!applied.ok || !applied.change) throw Error('Expected payment');
  const next = applied.change.state;
  assert.equal(validateFinanceChanges(state, next, identity, timestamp), '');
  return next;
};

test('approved partial and full advances do not accept work, and preserve the original ledger', () => {
  const initial = fixture(), original = structuredClone(initial), ctx = context();
  const first = payment(initial, fact(30.10), ctx);
  assert.equal(first.financeEntries[0].acceptedAmount, 0);
  assert.equal(first.financeEntries[0].acceptedAt, undefined);
  assert.equal(first.financeEntries[0].paidAmount, 30.10);
  const firstEvent = structuredClone(first.financeEntries[0].payments![0]);
  const final = payment(first, { ...fact(70.20), document: 'ПП №2' }, ctx);
  assert.equal(final.financeEntries[0].status, 'paid');
  assert.equal(final.financeEntries[0].acceptedAmount, 0);
  assert.equal(acceptedAmountFor(final.financeEntries[0]), 0);
  assert.deepEqual(final.financeEntries[0].payments?.map(item => item.amount), [30.10, 70.20]);
  assert.deepEqual(final.financeEntries[0].payments?.[0], firstEvent);
  assert.deepEqual(initial, original);
  assert.equal(recordFinancePayment(financeFactsSnapshot(final), fact(0.01), ctx).ok, false);
  assert.equal(acceptFinanceExpense(financeFactsSnapshot(final), { ...fact(10), source: 'stage:stage' }, ctx).ok, false, 'payment never bypasses work acceptance');
  final.stages[0].status = 'accepted';
  const result = applyFinanceFactsResult(final, acceptFinanceExpense(financeFactsSnapshot(final), { ...fact(10), source: 'stage:stage' }, ctx));
  assert.ok(result.ok && result.change);
  if (!result.ok || !result.change) return;
  assert.equal(validateFinanceChanges(final, result.change.state, identity, timestamp), '');
  assert.equal(result.change.state.financeEntries[0].status, 'paid');
  assert.equal(result.change.state.financeEntries[0].acceptedAmount, 10);
  assert.deepEqual(result.change.state.financeEntries[0].payments, final.financeEntries[0].payments);
});

test('advance requires approval and management, rejects overpayment and duplicate stale commands', () => {
  const state = fixture(), snapshot = financeFactsSnapshot(state), ctx = context();
  const pending = recordFinancePayment(snapshot, fact(20), ctx);
  const first = payment(state, fact(20));
  assert.equal(applyFinanceFactsResult(first, pending).ok, false, 'CAS prevents repeating a command after its payment is present');
  const unchanged = structuredClone(first);
  assert.equal(validateFinanceChanges(first, unchanged, identity, timestamp), '');
  assert.deepEqual(unchanged.financeEntries[0].payments, first.financeEntries[0].payments);
  for (const role of ['foreman', 'client'] as const) {
    assert.equal(recordFinancePayment(snapshot, fact(20), { ...ctx, identity: { name: role, role } }).ok, false);
    const forged = structuredClone(state);
    Object.assign(forged.financeEntries[0], { paidAmount: 20, paidAt: '2026-10-28', paymentDocument: 'ПП' });
    assert.match(validateFinanceChanges(state, forged, { name: role, role }, timestamp), /Управление/);
  }
  for (const amount of [100.31, 0.001, Infinity]) assert.equal(recordFinancePayment(snapshot, fact(amount), ctx).ok, false);
  delete state.financeEntries[0].approvedAt;
  assert.equal(recordFinancePayment(financeFactsSnapshot(state), fact(20), ctx).ok, false);
  const forged = structuredClone(state);
  Object.assign(forged.financeEntries[0], { paidAmount: 20, paidAt: '2026-10-28', paymentDocument: 'ПП' });
  assert.match(validateFinanceChanges(state, forged, identity, timestamp), /утвердите/);
});

test('trusted boundary sets explicit acceptance on a new paid status but never rewrites legacy history', () => {
  const state = fixture(), next = structuredClone(state);
  Object.assign(next.financeEntries[0], { status: 'paid', paidAmount: 100.30, paidAt: '2026-10-28', paymentDocument: 'ПП' });
  assert.equal(validateFinanceChanges(state, next, identity, timestamp), '');
  assert.equal(next.financeEntries[0].acceptedAmount, 0);
  const legacy = fixture();
  Object.assign(legacy.financeEntries[0], { status: 'paid' });
  delete legacy.financeEntries[0].approvedAt;
  const unchanged = structuredClone(legacy);
  assert.equal(validateFinanceChanges(legacy, unchanged, identity, timestamp), '');
  assert.deepEqual(unchanged, legacy);
  assert.equal(unchanged.financeEntries[0].acceptedAmount, undefined);
});

test('uploaded evidence retains the original and immutable payment link; plain text is never a file', () => {
  const state = fixture();
  const file = { key: 'advance-project/documents/pp-1.pdf', name: 'pp-1.pdf', type: 'application/pdf', size: 123, uploadedAt: timestamp };
  const first = payment(state, { ...fact(20), uploadedFile: file });
  const doc = first.documents[0];
  assert.deepEqual([doc.fileKey, doc.fileName, doc.mimeType, doc.sizeBytes, doc.uploadedAt], [file.key, file.name, file.type, file.size, file.uploadedAt]);
  assert.equal(doc.clientVisible, false);
  assert.equal(first.financeEntries[0].paymentDocumentId, doc.id);
  assert.equal(first.financeEntries[0].payments?.[0].documentId, doc.id);
  const ctx = context(); ctx.ids.next('reserved'); ctx.ids.next('reserved');
  const second = payment(first, { ...fact(10), document: 'Подтверждение по телефону' }, ctx);
  assert.equal(second.documents[0].fileKey, undefined);
  assert.match(second.documents[0].type, /без файла/);
  assert.equal(second.financeEntries[0].paymentDocumentId, undefined);
  assert.equal(second.financeEntries[0].payments?.[1].documentId, undefined);
  assert.equal(second.financeEntries[0].payments?.[0].documentId, doc.id);
  for (const mutate of [(value: typeof first) => { value.documents = []; }, (value: typeof first) => { value.documents[0].fileKey = 'advance-project/replacement.pdf'; }]) {
    const forged = structuredClone(first); mutate(forged);
    assert.match(validateFinanceChanges(first, forged, identity, timestamp), /Оригинал/);
  }
  const forged = structuredClone(first);
  forged.financeEntries[0].payments![0].documentId = 'forged';
  assert.match(validateFinanceChanges(first, forged, identity, timestamp), /История платежей/);
});

test('existing file is linked without duplication, checked for project visibility and reference conflicts', () => {
  const state = fixture();
  state.documents = [{ id: 'existing', name: 'ПП', type: 'Платёжный документ', updatedAt: timestamp, status: 'current', clientVisible: false, fileKey: 'advance-project/documents/original.pdf', fileName: 'original.pdf' }];
  const result = recordFinancePayment(financeFactsSnapshot(state), { ...fact(20), documentId: 'existing' }, context());
  assert.ok(result.ok && result.change);
  if (!result.ok || !result.change) return;
  assert.equal(result.change.appendDocument, undefined);
  const next = payment(state, { ...fact(20), documentId: 'existing' });
  assert.deepEqual(next.documents, state.documents);
  assert.equal(next.financeEntries[0].payments?.[0].documentId, 'existing');
  const changed = structuredClone(state); changed.documents[0].fileKey = 'advance-project/replaced.pdf';
  assert.equal(applyFinanceFactsResult(changed, result).ok, false);
  for (const change of [{ clientVisible: true }, { fileKey: 'another-project/source.pdf' }, { fileKey: undefined }, { fileKey: 'advance-project/../source.pdf' }]) {
    const snapshot = financeFactsSnapshot(state); snapshot.documents = [{ ...state.documents[0], ...change }];
    assert.equal(recordFinancePayment(snapshot, { ...fact(20), documentId: 'existing' }, context()).ok, false);
  }
  const file = { key: 'another-project/upload.pdf', name: 'upload.pdf', type: 'application/pdf', size: 10, uploadedAt: timestamp };
  assert.equal(recordFinancePayment(financeFactsSnapshot(state), { ...fact(20), uploadedFile: file }, context()).ok, false);
  assert.equal(recordFinancePayment(financeFactsSnapshot(state), { ...fact(20), documentId: 'existing', uploadedFile: { ...file, key: 'advance-project/upload.pdf' } }, context()).ok, false);
});
