import type { FinanceEntry } from '../entities/index';
import { paymentMovements } from '../domain/finance';
import { formatDate, money } from '../presentation/formatting';

export function PaymentHistory({ entry }: { entry: FinanceEntry }) {
  const legacy = paymentMovements(entry).filter(item => item.legacy && item.amount > 0);
  if (!entry.payments?.length && !legacy.length) return null;
  return <section className="entity-detail-card" aria-label="История платежей">
    <strong>История платежей</strong>
    {legacy.map((item, index) => <p key={`legacy-${index}`}>Ранее учтено: {money(item.amount)}. {item.date ? `Дата в старой записи: ${formatDate(item.date, true)}.` : 'Дата оплаты не установлена.'} Разбивка на отдельные платежи требует сверки.</p>)}
    {entry.legacyPayment && <p>Сохранённые сведения прежней записи: {entry.legacyPayment.lastRecordedDate ? formatDate(entry.legacyPayment.lastRecordedDate, true) : 'без даты'} · {entry.legacyPayment.document || 'без документа'}. Эта дата не назначается всей накопленной сумме.</p>}
    {entry.payments?.map(item => <div key={item.id}><strong>{money(item.amount)} · {formatDate(item.date, true)}</strong><p>{item.document} · записал {item.recordedBy}</p></div>)}
    <small>Номер документа — основание записи, а не автоматическое подтверждение банковской сверки.</small>
  </section>;
}
