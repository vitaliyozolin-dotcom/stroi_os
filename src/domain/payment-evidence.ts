import type { FinanceEntry, ProjectDocument, LedgerConfirmation } from '../entities/index';
import type { FinanceSettlementContext } from './finance/context';
import { effectiveLedgerConfirmation, ledgerLegacyPaymentReferences, ledgerOperationAllocations } from './finance-ledger.js';

const linkedOperations = (entry: FinanceEntry, state?: FinanceSettlementContext) => (state?.financeLedger?.operations ?? [])
  .filter(operation => operation.legacyPayment?.entryId === entry.id || ledgerOperationAllocations(state!.financeLedger!, operation).some(row => row.entryId === entry.id));

/** One split payment can supply the same original document to several obligations. */
export function financeEntryEvidenceDocuments(entry: FinanceEntry, documents: ProjectDocument[], state?: FinanceSettlementContext) {
  const references = new Set([entry.historicalPayment?.sourceDocumentId, entry.acceptanceDocumentId, entry.paymentDocumentId,
    ...(entry.payments ?? []).map(payment => payment.documentId),
    ...linkedOperations(entry, state).flatMap(operation => [operation.documentId, ...(operation.documentIds ?? [])])].filter(Boolean));
  return documents.filter(document => Boolean(document.fileKey) && (references.has(document.id) || document.financeEntryId === entry.id));
}

/** Read-only evidence labels. A filename or payment note is not a verified payment. */
export function paymentEvidence(entry: FinanceEntry, documents: ProjectDocument[], state?: FinanceSettlementContext) {
  const source = documents.find(doc => doc.id === entry.historicalPayment?.sourceDocumentId);
  const attached = financeEntryEvidenceDocuments(entry, documents, state);
  const spreadsheet = /\.(xlsx?|csv|ods)$/i.test(source?.fileName || entry.document || '');
  let sourceLabel = entry.historicalPayment ? spreadsheet ? 'По таблице' : 'Со слов владельца' : 'Отметка в системе';
  const typed = attached.filter(doc => !/\.(xlsx?|csv|ods)$/i.test(doc.fileName || '') && ['invoice', 'act', 'upd', 'waybill'].includes(doc.category || ''));
  const names: Record<string, string> = { invoice: 'Счёт', act: 'Акт', upd: 'УПД', waybill: 'Накладная' };
  const documentLabel = typed.length ? [...new Set(typed.map(doc => names[doc.category!]))].join(', ') + ' · приложено'
    : attached.some(doc => !/\.(xlsx?|csv|ods)$/i.test(doc.fileName || '')) ? 'Файл приложен · тип не проверен'
    : 'Счёт / чек / накладная не приложены';
  const recordedPaid = (entry.paidAmount ?? (entry.status === 'paid' ? entry.amount : 0)) > 0;
  let paymentLabel = recordedPaid ? 'Документально не сверена' : 'Оплата не записана';
  if (state) {
    const ledger = state.financeLedger, operations = linkedOperations(entry, state);
    const legacyLevels = new Map(state.treasury?.entryPlans.find(plan => plan.entryId === entry.id)?.paymentFacts?.map(fact => [fact.paymentId, fact.confirmation]) ?? []);
    for (const operation of operations) if (operation.legacyPayment && effectiveLedgerConfirmation(ledger, operation) !== 'claimed') legacyLevels.set(operation.legacyPayment.paymentId, effectiveLedgerConfirmation(ledger, operation));
    const levels: (LedgerConfirmation | undefined)[] = ledgerLegacyPaymentReferences(entry).map(payment => legacyLevels.get(payment.id));
    const monetary = operations.filter(operation => !operation.legacyPayment && operation.kind !== 'offset');
    levels.push(...monetary.map(operation => effectiveLedgerConfirmation(ledger, operation)));
    const confirmed = levels.filter(level => level !== 'claimed');
    if (!confirmed.length) paymentLabel = levels.includes('claimed') ? 'Заявлена, не подтверждена' : 'Оплата не записана';
    else if (confirmed.every(level => level === 'reconciled')) paymentLabel = 'Сверена с банком';
    else if (confirmed.some(level => level === 'reconciled')) paymentLabel = 'Часть движений сверена с банком';
    else if (monetary.some(operation => effectiveLedgerConfirmation(ledger, operation) !== 'claimed')) paymentLabel = 'Записана в журнале; банковская сверка не завершена';
    if (operations.some(operation => effectiveLedgerConfirmation(ledger, operation) !== 'claimed')) sourceLabel = 'По журналу расчётов';
  }
  return { sourceLabel, documentLabel, paymentLabel };
}
