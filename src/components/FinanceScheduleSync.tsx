import type { AppState, UserRole } from '../entities/index';
import { resolveTreasuryDateRuleDetails, treasuryProjection, treasuryTrancheBalance } from '../domain/treasury.js';
import { financeEntryTitle, financeToday } from '../presentation/finance-view';
import { formatDate, money } from '../presentation/formatting';
import './treasury-panel.css';

/** The summary reads the same dated remainder as the calendar and cash forecast. */
export function FinanceScheduleSync({ state, role, onEditPlan, onOpenSchedule, entryId }: {
  state: AppState; role: UserRole; onEditPlan: (entryId: string) => void;
  onOpenSchedule?: () => void; entryId?: string;
}) {
  if (role !== 'management') return null;
  const today = financeToday();
  const active = state.treasury?.enabled === true;
  const projection = treasuryProjection(state, { today });
  const plans = (state.treasury?.entryPlans ?? []).filter(plan => !entryId || plan.entryId === entryId);
  const linked = plans.flatMap(plan => plan.tranches.flatMap((tranche, index) => {
    if (!tranche.dateRule) return [];
    const entry = state.financeEntries.find(item => item.id === plan.entryId);
    if (!entry) return [];
    const matching = projection.events.filter(item => item.entryId === entry.id && item.trancheId === tranche.id);
    const event = matching.find(item => item.sourceType !== 'retention') ?? matching[0];
    const balance = treasuryTrancheBalance(projection, entry.id, tranche.id);
    const unresolvedAllocation = projection.events.some(item => item.entryId === entry.id && item.id.endsWith(':unallocated-settlement'));
    return [{ entry, tranche, index, event, balance, unresolvedAllocation, resolution: resolveTreasuryDateRuleDetails(state, tranche.dateRule, today) }];
  }));
  const unknownCount = linked.filter(item => !item.resolution.date || item.unresolvedAllocation).length;
  return <section className="finance-schedule-sync" aria-label="Связь ППР и оплат">
    <div className="finance-schedule-sync__heading"><div><h3>Связь ППР и оплат</h3><p>{linked.length ? active ? `Связано с ППР: ${linked.length}${unknownCount ? ` · нужно уточнить: ${unknownCount}` : ''}` : `Сохранённых связей: ${linked.length} · расчёт по правилам выключен` : 'Укажите, какое событие в работах определяет дату расчёта'}</p></div>
      <div className="treasury-toolbar__actions"><button type="button" className="button button--secondary" disabled={!state.financeEntries.length} onClick={() => onEditPlan(entryId ?? '')}>{entryId ? 'Настроить график расчётов' : 'Связать платёж с ППР'}</button>{onOpenSchedule && <button type="button" className="text-button" onClick={onOpenSchedule}>Открыть ППР</button>}</div>
    </div>
    <p className="finance-schedule-sync__explanation">Для каждого транша выберите фиксированную дату или правило: например, за 7 дней до начала этапа либо через 3 дня после приёмки. {active ? 'Сохранённое изменение ППР пересчитывает связанные даты в календаре и прогнозе денег.' : 'Связь станет активной после сохранения графика расчётов. Пока календарь использует отдельные сроки обязательств; сохранённые правила ППР в нём не применяются.'}</p>
    <p className="finance-schedule-sync__explanation">Договорный срок хранится отдельно: если работы сдвинулись, система покажет отклонение. Факт оплаты вносится по подтверждению, а завершение работы само по себе оплату не создаёт.</p>
    {linked.length > 0 && <details className="finance-schedule-sync__details" open={Boolean(entryId)}><summary>Показать связанные транши</summary><div className="finance-schedule-sync__rows">{linked.map(({ entry, tranche, index, event, balance, resolution, unresolvedAllocation }) => <article key={`${entry.id}:${tranche.id}`} className="finance-schedule-sync__row">
      <div><strong>{financeEntryTitle(entry)} · транш {index + 1}</strong><span>{resolution.label}</span><span>{resolution.reason ?? (resolution.basis === 'actual' ? 'Дата события подтверждена фактом' : resolution.basis === 'recorded_plan' ? 'По записанному плану; зависимости ППР не подтверждены' : 'По текущему прогнозу ППР')}</span></div>
      <dl><div><dt>{active ? 'По правилу' : 'Предварительно по правилу'}</dt><dd>{resolution.date ? formatDate(resolution.date, true) : 'Нет подтверждённой даты'}</dd></div><div><dt>По договору</dt><dd>{tranche.contractualDueDate ? formatDate(tranche.contractualDueDate, true) : 'Не указан'}</dd></div><div><dt>Осталось по траншу</dt><dd>{unresolvedAllocation ? 'Нужно распределить оплаты' : balance.remainingCents === null ? 'Требует сверки' : balance.remainingCents > 0 ? money(balance.remainingCents / 100) : 'Нет остатка в прогнозе'}</dd></div></dl>
      {(balance.heldCents ?? 0) > 0 && <p className="finance-schedule-sync__explanation">В остатке удержано {money(balance.heldCents! / 100)}. {balance.retentions.map(item => `${money(item.amountCents / 100)}: ${item.scheduledDate ? `освобождение ${formatDate(item.scheduledDate, true)}` : 'дата освобождения не определена'}`).join('; ')}.</p>}
      {event && event.scheduledDelayDays !== null && event.scheduledDelayDays > 0 && <p className="finance-schedule-sync__warning">Дата по правилу позже договора на {event.scheduledDelayDays} дн.</p>}
      {event?.contractOverdue && <p className="finance-schedule-sync__warning">Договорный срок прошёл; остаток не погашен.</p>}
      <button type="button" className="text-button" onClick={() => onEditPlan(entry.id)}>Изменить правило</button>
    </article>)}</div></details>}
  </section>;
}
