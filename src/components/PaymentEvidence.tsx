import type { FinanceEntry, ProjectDocument } from '../entities/index';
import type { FinanceSettlementContext } from '../domain/finance/context';
import { paymentEvidence } from '../domain/payment-evidence';

export function PaymentEvidence({ entry, documents, state }: { entry: FinanceEntry; documents: ProjectDocument[]; state?: FinanceSettlementContext }) {
  const evidence = paymentEvidence(entry, documents, state);
  return <section className="entity-detail-card" aria-label="Основания расхода">
    <strong>Основания расхода</strong>
    <span>Источник записи: {evidence.sourceLabel}</span>
    <span>Документы: {evidence.documentLabel}</span>
    <span>Подтверждение оплаты: {evidence.paymentLabel}</span>
    <small>Счёт, накладная и отметка «Оплачено» не заменяют сверку чека или банковской выписки.</small>
  </section>;
}
