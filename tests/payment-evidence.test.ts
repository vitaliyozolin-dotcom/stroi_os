import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentEvidence } from '../src/domain/payment-evidence.ts';
import type { FinanceEntry, ProjectDocument } from '../src/entities/index.ts';

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
