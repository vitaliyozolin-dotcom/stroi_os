import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentEvidence, financeEntryEvidenceDocuments } from '../src/domain/payment-evidence.ts';
import type { FinanceEntry, ProjectDocument } from '../src/entities/index.ts';
import { emptyFinanceLedger } from '../src/domain/finance-ledger.js';

const entry = { id: 'expense', kind: 'expense', status: 'paid', amount: 100, paidAmount: 100, paymentDocument: 'Оплата подтверждена', historicalPayment: { sourceDocumentId: 'source' } } as FinanceEntry;
const doc = (values: Partial<ProjectDocument>) => ({ id: 'source', fileKey: 'project/source', fileName: 'estimate.xlsx', category: 'specification', ...values }) as ProjectDocument;

test('spreadsheet payment stays an assertion and inputs remain unchanged', () => {
  const documents = [doc({})], before = structuredClone({entry, documents});
  assert.deepEqual(paymentEvidence(entry, documents), {sourceLabel:'По таблице', documentLabel:'Счёт / чек / накладная не приложены', paymentLabel:'Документально не сверена'});
  assert.deepEqual({entry, documents}, before);
});
test('an attached invoice does not prove payment; missing file metadata is not an attachment', () => {
  assert.equal(paymentEvidence(entry, [doc({fileName:'invoice.pdf',category:'invoice'})]).documentLabel, 'Счёт · приложено');
  assert.equal(paymentEvidence(entry, [doc({fileName:'invoice.pdf',category:'invoice'})]).paymentLabel, 'Документально не сверена');
  assert.equal(paymentEvidence(entry, [doc({fileKey:undefined,category:'invoice'})]).documentLabel, 'Счёт / чек / накладная не приложены');
});
test('unclassified receipt image, free text and unrelated files never become verified payments', () => {
  assert.equal(paymentEvidence(entry, [doc({fileName:'receipt.jpg',category:'other'})]).documentLabel, 'Файл приложен · тип не проверен');
  assert.equal(paymentEvidence({...entry,historicalPayment:undefined}, [doc({id:'other',fileName:'invoice.pdf',category:'invoice'})]).documentLabel, 'Счёт / чек / накладная не приложены');
  assert.equal(paymentEvidence({...entry,status:'committed',paidAmount:0,historicalPayment:undefined}, []).paymentLabel, 'Оплата не записана');
});

test('explicit acceptance and payment references include existing files without relinking their registry records', () => {
  const documents = [doc({ id: 'existing-act', fileName: 'act.pdf', category: 'act' }), doc({ id: 'existing-invoice', fileName: 'invoice.pdf', category: 'invoice' })];
  const current = { ...entry, historicalPayment: undefined, acceptanceDocumentId: 'existing-act', paymentDocumentId: 'existing-invoice' };
  const before = structuredClone({ current, documents });
  assert.equal(paymentEvidence(current, documents).documentLabel, 'Акт, Счёт · приложено');
  assert.equal(paymentEvidence(current, documents).paymentLabel, 'Документально не сверена');
  assert.deepEqual({ current, documents }, before);
});

test('an earlier partial payment retains evidence after a later text-only payment; dangling references do not fabricate files', () => {
  const current = { ...entry, historicalPayment: undefined, paymentDocumentId: undefined,
    payments: [{ id: 'p1', amount: 40, date: '2026-10-01', document: 'ПП', documentId: 'first-payment', recordedAt: '2026-10-01T12:00:00Z', recordedBy: 'Управляющий' }] };
  const documents = [doc({ id: 'first-payment', fileName: 'pp.pdf', category: 'other' })];
  assert.equal(paymentEvidence(current, documents).documentLabel, 'Файл приложен · тип не проверен');
  assert.equal(paymentEvidence(current, []).documentLabel, 'Счёт / чек / накладная не приложены');
  assert.equal(paymentEvidence(current, [{ ...documents[0], fileKey: undefined }]).documentLabel, 'Счёт / чек / накладная не приложены');
});

test('ledger-only confirmed and reconciled payments show their actual evidence level', () => {
  const current = { ...entry, status: 'committed' as const, paidAmount: 0, historicalPayment: undefined };
  const state = { financeLedger: emptyFinanceLedger() };
  state.financeLedger.operations.push({ id: 'journal', kind: 'payment', amountCents: 10000, date: '2026-10-20', accountId: 'bank', counterparty: 'Vendor', description: 'Payment', source: 'Evidence', confirmation: 'confirmed', allocations: [{ entryId: current.id, amountCents: 10000 }] });
  assert.equal(paymentEvidence(current, [], state).sourceLabel, 'По журналу расчётов');
  assert.equal(paymentEvidence(current, [], state).paymentLabel, 'Записана в журнале; банковская сверка не завершена');
  state.financeLedger.confirmations.push({ id: 'bank-match', operationId: 'journal', confirmation: 'reconciled', source: 'Statement', sourceKey: 'bank-key', bankAccountId: 'bank' });
  assert.equal(paymentEvidence(current, [], state).paymentLabel, 'Сверена с банком');
});

test('claimed journal or legacy payments are never labeled as paid or bank verified', () => {
  const current = { ...entry, historicalPayment: undefined };
  const state = { financeLedger: emptyFinanceLedger(), treasury: { version: 1 as const, enabled: true, accounts: [], costEstimates: [], entryPlans: [{ entryId: current.id, source: 'Review', tranches: [], paymentFacts: [{ paymentId: 'legacy:expense', cashTreatment: 'account' as const, confirmation: 'claimed' as const, source: 'Unverified' }] }] } };
  assert.equal(paymentEvidence(current, [doc({ fileName: 'paid.pdf', category: 'invoice' })], state).paymentLabel, 'Заявлена, не подтверждена');
  state.financeLedger.operations.push({ id: 'journal', kind: 'payment', amountCents: 10000, date: '2026-10-20', accountId: 'bank', counterparty: 'Vendor', description: 'Payment', source: 'Evidence', confirmation: 'claimed', allocations: [{ entryId: current.id, amountCents: 10000 }] });
  assert.equal(paymentEvidence(current, [], state).paymentLabel, 'Заявлена, не подтверждена');
  state.financeLedger.operations = [{ ...state.financeLedger.operations[0], confirmation: 'reconciled', allocations: [], legacyPayment: { entryId: current.id, paymentId: 'legacy:expense' } }];
  assert.equal(paymentEvidence(current, [], state).paymentLabel, 'Сверена с банком', 'exact same legacy movement can be corroborated, never duplicated');
});

test('one reconciled partial payment does not imply all other payments or refunds were reconciled', () => {
  const current = { ...entry, status: 'committed' as const, paidAmount: 0, historicalPayment: undefined };
  const state = { financeLedger: emptyFinanceLedger() };
  state.financeLedger.operations = [
    { id: 'cash', kind: 'payment', amountCents: 10000, date: '2026-10-20', accountId: 'bank', counterparty: 'Vendor', description: 'Payment', source: 'Evidence', confirmation: 'reconciled', allocations: [{ entryId: current.id, amountCents: 10000 }] },
    { id: 'refund', kind: 'supplier_refund', amountCents: 3000, date: '2026-10-21', accountId: 'bank', counterparty: 'Vendor', description: 'Refund', source: 'Evidence', confirmation: 'confirmed', allocations: [{ entryId: current.id, amountCents: 3000 }], refundOfOperationId: 'cash' },
  ];
  assert.equal(paymentEvidence(current, [], state).paymentLabel, 'Часть движений сверена с банком');
});

test('split payment originals and later allocation events are visible from every affected obligation', () => {
  const current = { ...entry, status: 'committed' as const, paidAmount: 0, historicalPayment: undefined }, second = { ...current, id: 'second' };
  const state = { financeLedger: emptyFinanceLedger() };
  state.financeLedger.operations = [{ id: 'split', kind: 'payment', amountCents: 10000, date: '2026-10-20', accountId: 'bank', counterparty: 'Vendor', description: 'Payment', source: 'Evidence', confirmation: 'confirmed', documentId: 'pp', documentIds: ['invoice'], allocations: [{ entryId: current.id, amountCents: 5000 }] }];
  state.financeLedger.allocationEvents = [{ id: 'allocate-later', operationId: 'split', allocations: [{ entryId: second.id, amountCents: 5000 }], source: 'Review' }];
  const documents = [doc({ id: 'pp', fileName: 'pp.pdf', category: 'other' }), doc({ id: 'invoice', fileName: 'invoice.pdf', category: 'invoice' }), doc({ id: 'unrelated', fileName: 'other.pdf' })];
  for (const item of [current, second]) {
    assert.deepEqual(financeEntryEvidenceDocuments(item, documents, state).map(document => document.id), ['pp', 'invoice']);
    assert.equal(paymentEvidence(item, documents, state).documentLabel, 'Счёт · приложено');
  }
});
