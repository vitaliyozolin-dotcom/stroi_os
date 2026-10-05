import type { FinanceEntry, ProjectDocument } from '../entities/index';

/** Read-only evidence labels. A filename or payment note is not a verified payment. */
export function paymentEvidence(entry: FinanceEntry, documents: ProjectDocument[]) {
  const source = documents.find(doc => doc.id === entry.historicalPayment?.sourceDocumentId);
  const attached = documents.filter(doc => Boolean(doc.fileKey) && (doc.id === source?.id || doc.financeEntryId === entry.id));
  const spreadsheet = /\.(xlsx?|csv|ods)$/i.test(source?.fileName || entry.document || '');
  const sourceLabel = entry.historicalPayment ? spreadsheet ? 'По таблице' : 'Со слов владельца' : 'Отметка в системе';
  const typed = attached.filter(doc => !/\.(xlsx?|csv|ods)$/i.test(doc.fileName || '') && ['invoice', 'act', 'upd', 'waybill'].includes(doc.category || ''));
  const names: Record<string, string> = { invoice: 'Счёт', act: 'Акт', upd: 'УПД', waybill: 'Накладная' };
  const documentLabel = typed.length ? [...new Set(typed.map(doc => names[doc.category!]))].join(', ') + ' · приложено'
    : attached.some(doc => !/\.(xlsx?|csv|ods)$/i.test(doc.fileName || '')) ? 'Файл приложен · тип не проверен'
    : 'Счёт / чек / накладная не приложены';
  const recordedPaid = (entry.paidAmount ?? (entry.status === 'paid' ? entry.amount : 0)) > 0;
  return { sourceLabel, documentLabel, paymentLabel: recordedPaid ? 'Документально не сверена' : 'Оплата не записана' };
}
