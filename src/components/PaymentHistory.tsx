import type { FinanceSettlementContext } from '../domain/finance/context';
import { effectiveLedgerConfirmation, ledgerOperationAllocations } from '../domain/finance-ledger.js';
import type { FinanceEntry } from '../entities/index';
import { paymentMovements } from '../domain/finance';
import { formatDate, money } from '../presentation/formatting';

export function PaymentHistory({ entry, state }: { entry: FinanceEntry; state?: FinanceSettlementContext }) {
  const legacy = paymentMovements(entry).filter(item => item.legacy && item.amount > 0);
  const ledger = state?.financeLedger;
  const settlements = (ledger?.operations ?? []).flatMap(operation => {
    if (operation.legacyPayment || effectiveLedgerConfirmation(ledger, operation) === 'claimed') return [];
    const amountCents = ledgerOperationAllocations(ledger!, operation).filter(row => row.entryId === entry.id).reduce((sum, row) => sum + row.amountCents, 0);
    return amountCents ? [{ operation, amountCents }] : [];
  });
  if (!entry.payments?.length && !legacy.length && !settlements.length) return null;
  return <section className="entity-detail-card" aria-label="История платежей">
    <strong>История платежей</strong>
    {legacy.map((item, index) => <p key={`legacy-${index}`}>Ранее учтено: {money(item.amount)}. {item.date ? `Дата в старой записи: ${formatDate(item.date, true)}.` : 'Дата оплаты не установлена.'} Разбивка на отдельные платежи требует сверки.</p>)}
    {entry.legacyPayment && <p>Сохранённые сведения прежней записи: {entry.legacyPayment.lastRecordedDate ? formatDate(entry.legacyPayment.lastRecordedDate, true) : 'без даты'} · {entry.legacyPayment.document || 'без документа'}. Эта дата не назначается всей накопленной сумме.</p>}
    {entry.payments?.map(item => <div key={item.id}><strong>{money(item.amount)} · {formatDate(item.date, true)}</strong><p>{item.document} · записал {item.recordedBy}</p></div>)}
    {settlements.map(({ operation, amountCents }) => <div key={operation.id}><strong>{operation.kind === 'offset' ? 'Зачёт' : ['supplier_refund', 'customer_refund'].includes(operation.kind) ? 'Возврат' : entry.kind === 'income' ? 'Поступление' : 'Оплата'}: {money(amountCents / 100)} · {formatDate(operation.date, true)}</strong><p>{operation.description} · {operation.source}{effectiveLedgerConfirmation(ledger, operation) === 'reconciled' ? ' · сверено с банком' : ''}</p></div>)}
    <small>Номер документа — основание записи, а не автоматическое подтверждение банковской сверки.</small>
  </section>;
}
