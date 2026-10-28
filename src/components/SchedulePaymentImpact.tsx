import type { AppState, UserRole } from '../entities/index';
import type { SchedulePaymentPreview } from '../application/schedule-payment-preview';
import { treasuryScheduleImpact } from '../domain/treasury.js';
import { planToday } from '../domain/construction/index.js';
import { formatDate, money } from '../presentation/formatting';
import './schedule-payment-impact.css';

const dateLabel = (date: string | null) => date ? formatDate(date, true) : 'Дата неизвестна';
const sumLabel = (cents: number | null) => cents === null ? 'Нет данных' : money(cents / 100);

export function SchedulePaymentImpact({ before, preview, role, today = planToday(), scenario = false }: {
  before: AppState; preview: SchedulePaymentPreview<AppState> | null; role: UserRole; today?: string; scenario?: boolean;
}) {
  // Guard before reading any financial fields, even when handed an unfiltered state.
  if (role !== 'management' || !before.treasury?.enabled || !before.treasury.entryPlans.some(plan => plan.tranches.some(tranche => tranche.dateRule))) return null;
  if (!preview?.ok) return <aside className="schedule-payment-impact" aria-label="Влияние на оплаты"><strong>Влияние на оплаты</strong><p>Заполните сведения для предварительного расчёта.{preview && ` ${preview.error}`}</p><p className="schedule-payment-impact__note">Договорные сроки и записанные оплаты сохраняются. Меняется прогноз неоплаченных траншей, связанных с ППР.</p></aside>;
  const impact = treasuryScheduleImpact(before, preview.state, { today, horizonDays: 91 });
  return <aside className="schedule-payment-impact" aria-label="Влияние на оплаты">
    <strong>{scenario ? 'Оплаты в этом сценарии' : 'Как изменится график оплат'}</strong>
    <p className="schedule-payment-impact__note">Предварительно, до сохранения. Расчёт включает связанные последующие этапы. Договорные сроки, суммы и факты оплаты сохраняются.</p>
    {!impact.changes.length ? <p>Даты и основания оставшихся связанных траншей не изменятся.</p> : <>
      <p>Изменения по траншам: {impact.changes.length}. Перенос выплат: {sumLabel(impact.shiftedExpenseCents)} · поступлений: {sumLabel(impact.shiftedIncomeCents)}.{impact.changes.some(change => !change.affectsCash) && ' Включая расчёты участников вне счетов компании.'}</p>
      <ul className="schedule-payment-impact__list">{impact.changes.map(change => <li key={change.id}>
        <div><strong>{change.description}</strong><span>{change.kind === 'income' ? 'Поступление' : 'Выплата'} · остаток {sumLabel(change.amountCents)}</span></div>
        <p><span>{dateLabel(change.beforeDate)}</span><span aria-label="изменится на"> → </span><strong>{dateLabel(change.afterDate)}</strong>{change.shiftDays !== null && change.shiftDays !== 0 && <span> · {change.shiftDays > 0 ? '+' : ''}{change.shiftDays} календ. дн.</span>}</p>
        <small>{change.reason}{!change.affectsCash && ' · оплата участником, вне счетов компании'}</small>
        {change.contractualDueDate && <p className={change.afterDate && change.afterDate > change.contractualDueDate ? 'schedule-payment-impact__risk' : ''}>Договорный срок: {dateLabel(change.contractualDueDate)}{change.afterDate && change.afterDate > change.contractualDueDate ? ' · прогноз позже договора' : ''}</p>}
      </li>)}</ul>
      {impact.comparable ? <div className="schedule-payment-impact__metrics"><div><span>Минимальный остаток · 13 недель</span><strong>{sumLabel(impact.before.minBalanceCents)} → {sumLabel(impact.after.minBalanceCents)}</strong></div><div><span>Потребность в финансировании</span><strong>{sumLabel(impact.before.peakFundingCents)} → {sumLabel(impact.after.peakFundingCents)}</strong></div><div><span>Первый день дефицита · 13 недель</span><strong>{impact.before.firstDeficitDate ? dateLabel(impact.before.firstDeficitDate) : 'Не выявлен'} → {impact.after.firstDeficitDate ? dateLabel(impact.after.firstDeficitDate) : 'Не выявлен'}</strong></div></div> : <p className="schedule-payment-impact__note">Влияние на кассовый разрыв пока не рассчитано: нужны подтверждённый остаток и распределённые по датам денежные события.</p>}
      {!impact.complete && <p className="schedule-payment-impact__note">Денежный прогноз неполон: показаны только внесённые события. Неизвестный остаток или дата требуют сверки; отсутствие разрыва пока не подтверждено.</p>}
    </>}
    {scenario && <p className="schedule-payment-impact__note">Дополнительная стоимость меры не включена в денежный прогноз: сначала нужны сумма, счёт и дата отдельного платежа.</p>}
  </aside>;
}
