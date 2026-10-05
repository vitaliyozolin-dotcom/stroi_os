import type { FinanceEntry, ProjectDocument } from '../entities/index';
import { paymentEvidence } from '../domain/payment-evidence';

export function PaymentEvidence({ entry, documents }: { entry: FinanceEntry; documents: ProjectDocument[] }) {
  const evidence = paymentEvidence(entry, documents);
  return <section className="entity-detail-card" aria-label="Основания расхода">
    <strong>Основания расхода</strong>
    <span>Источник записи: {evidence.sourceLabel}</span>
    <span>Документы: {evidence.documentLabel}</span>
    <span>Подтверждение оплаты: {evidence.paymentLabel}</span>
    <small>Счёт, накладная и отметка «Оплачено» не заменяют сверку чека или банковской выписки.</small>
  </section>;
}
