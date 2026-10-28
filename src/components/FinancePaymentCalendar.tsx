import type { FinanceDueDateInput, FinanceCommandResult } from '../application';
import { useState, type FormEvent } from 'react';
import { ArrowUpRight, CalendarDays } from 'lucide-react';
import type { AppState, FinanceEntry } from '../entities/index';
import { financeCalendarItems, financeCalendarToday, financeCalendarTotal, type FinanceCalendarGroup } from '../domain/finance-calendar';
import { needsExpenseApproval } from '../domain/expense-workflow';
import { formatDate, money } from '../presentation/formatting';
import { financeEntryTitle } from '../presentation/finance-view';
import './finance-payment-calendar.css';

const groups: { id: FinanceCalendarGroup; title: string }[] = [
  { id: 'overdue', title: 'Срок прошёл' },
  { id: 'next7', title: 'Ближайшие 7 дней' },
  { id: 'later', title: 'Позже' },
  { id: 'undated', title: 'Без даты' },
];

export function FinancePaymentCalendar({ state, onSetDueDate, onOpenEntry, onAddEntry, onEditPlan, onOpenForecast, onOpenLedger }: {
  state: AppState; onSetDueDate: (input: FinanceDueDateInput) => FinanceCommandResult; onOpenEntry: (id: string) => void;
  onAddEntry: (kind: 'expense' | 'income') => void; onEditPlan?: (entryId: string) => void; onOpenForecast?: () => void; onOpenLedger?: () => void;
}) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [editing, setEditing] = useState<{ id: string; snapshot: string; value: string } | null>(null);
  const [error, setError] = useState('');
  const today = financeCalendarToday();
  const synced = state.treasury?.enabled === true;
  const items = financeCalendarItems(state, today).filter(item => item.kind === kind);
  const total = financeCalendarTotal(items);
  const directTotal = financeCalendarTotal(items.filter(item => item.projectionEvent?.excluded));
  const openDate = (entry: FinanceEntry) => {
    setError('');
    setEditing({ id: entry.id, snapshot: JSON.stringify(entry), value: entry.dueDate ?? '' });
  };
  const saveDate = (event: FormEvent) => {
    event.preventDefault();
    if (!editing || synced) return;
    const result = onSetDueDate({ entryId: editing.id, date: editing.value, expected: editing.snapshot });
    if (!result.ok) { setError(result.error); return; }
    setEditing(null);
  };
  return <section className="finance-calendar" aria-label="Платёжный календарь">
    <div className="finance-calendar__head">
      <div className="finance-calendar__switch" role="group" aria-label="Выплаты или поступления">
        <button type="button" aria-pressed={kind === 'expense'} onClick={() => { setKind('expense'); setEditing(null); }}>Нужно оплатить</button>
        <button type="button" aria-pressed={kind === 'income'} onClick={() => { setKind('income'); setEditing(null); }}>Ожидаем поступления</button>
      </div>
      {items.length > 0 && <div className="finance-calendar__total"><small>{kind === 'expense' ? 'Будущие выплаты' : 'Осталось получить'}</small><strong>{money(total)}</strong>{directTotal > 0 && <small>Из них вне счетов компании: {money(directTotal)}</small>}</div>}
    </div>
    {items.length > 0 && <p className="finance-calendar__note">{synced ? `Обязательства, планы и финансирование на конец ${formatDate(today, true)}. Даты из ППР пересчитываются вместе с графиком работ; договорный срок хранится отдельно. В прогнозе просроченные суммы переносятся на следующий день с сохранением исходной даты.` : 'Остатки по внесённым обязательствам. Сроки задаются отдельно.'}</p>}
    {!items.length && <div className="finance-calendar__empty"><CalendarDays size={22} aria-hidden="true" /><div><strong>{kind === 'expense' ? 'Нет неоплаченного остатка' : 'Нет неполученного остатка'}</strong><p>{kind === 'expense' ? 'Все внесённые обязательства погашены либо будущие расходы ещё не добавлены.' : 'Все внесённые поступления получены либо будущие поступления ещё не добавлены.'}</p></div><button type="button" className="button button--secondary" onClick={() => onAddEntry(kind)}>{kind === 'expense' ? 'Добавить расход' : 'Добавить поступление'}</button></div>}
    {groups.map(group => {
      const rows = items.filter(item => item.group === group.id);
      if (!rows.length) return null;
      return <section className={`finance-calendar__group finance-calendar__group--${group.id}`} key={group.id} aria-label={group.title}>
        <header><h3>{group.title} <span>{rows.length}</span></h3><strong>{money(financeCalendarTotal(rows))}</strong></header>
        {rows.map(({ id, entry, title, counterparty, dueDate, remaining, projectionEvent: event }) => {
          const trancheIndex = entry && event?.trancheId ? state.treasury?.entryPlans.find(plan => plan.entryId === entry.id)?.tranches.findIndex(tranche => tranche.id === event.trancheId) : undefined;
          const standaloneLabel = event?.sourceType === 'loan' ? 'Финансирование по займу' : event?.sourceType === 'transfer' ? 'Перевод между счетами' : event?.sourceType === 'delay' ? 'Стоимость задержки' : event?.sourceType === 'cash_plan' ? 'План без договора' : event?.sourceType === 'scenario' ? 'Сценарий' : 'Плановое движение';
          const openSource = () => { setEditing(null); if (entry) onOpenEntry(entry.id); else if (event?.sourceType === 'loan' || event?.sourceType === 'transfer') onOpenLedger?.(); else onOpenForecast?.(); };
          return <article className={`finance-calendar__row${event ? ' finance-calendar__row--synced' : ''}`} key={id}>
            <button className="finance-calendar__entry" type="button" onClick={openSource}>
              <span><strong title={title}>{entry ? financeEntryTitle(entry) : title}{trancheIndex !== undefined && trancheIndex >= 0 ? ` · транш ${trancheIndex + 1}` : ''}</strong><small>{entry ? counterparty || 'Контрагент не указан' : standaloneLabel}{entry?.kind === 'expense' && needsExpenseApproval(entry) && <span className="finance-calendar__approval"> · Не утверждено</span>}</small></span><ArrowUpRight size={16} aria-hidden="true" />
            </button>
            <strong className="finance-calendar__amount">{money(remaining)}</strong>
            {event ? <div className="finance-calendar__dates">
              <span>По графику: <strong>{dueDate ? formatDate(dueDate, true) : 'Дата не определена'}</strong></span>
              {event.contractualDueDate && <span className={event.contractOverdue ? 'finance-calendar__risk' : undefined}>По договору: {formatDate(event.contractualDueDate, true)}{event.contractOverdue ? ' · срок прошёл' : ''}</span>}
              {event.forecastDelayDays !== null && event.forecastDelayDays > 0 && <span className="finance-calendar__risk">Прогноз позже договора на {event.forecastDelayDays} дн.</span>}
              {event.date !== dueDate && event.date && <span>В кассовом прогнозе: {formatDate(event.date, true)}</span>}
              <button className="finance-calendar__date" type="button" onClick={() => { if (entry) { setEditing(null); (onEditPlan ?? onOpenEntry)(entry.id); } else openSource(); }} aria-label={`Настроить график платежей: ${title}`}><CalendarDays size={14} aria-hidden="true" />{entry ? 'Настроить график' : 'Открыть источник плана'}</button>
            </div> : entry ? <button className="finance-calendar__date" type="button" onClick={() => openDate(entry)} aria-label={`${dueDate ? 'Изменить' : 'Задать'} срок: ${entry.description}`}><CalendarDays size={14} aria-hidden="true" />{dueDate ? formatDate(dueDate, true) : 'Задать срок'}</button> : null}
            {event && <div className="finance-calendar__source"><span>{event.dateResolution.label}</span>{event.dateResolution.reason && <span className="finance-calendar__risk">{event.dateResolution.reason}</span>}{event.excluded && <span>Прямая оплата участником — вне движения по счетам компании.</span>}{!event.excluded && !event.accountId && <span className="finance-calendar__risk">Счёт не назначен: сводный прогноз неполон, распределение по счетам неизвестно.</span>}</div>}
            {entry && !synced && editing?.id === entry.id && <form className="finance-calendar__editor" onSubmit={saveDate}>
              <label>Плановая дата {entry.kind === 'expense' ? 'выплаты' : 'поступления'}<input autoFocus type="date" value={editing.value} onChange={event => setEditing({ ...editing, value: event.target.value })} /></label>
              <div><button type="button" className="button button--ghost" onClick={() => setEditing(null)}>Отмена</button><button type="submit" className="button button--primary">Сохранить</button></div>
              {entry.dueDate && <button className="finance-calendar__clear" type="button" onClick={() => setEditing({ ...editing, value: '' })}>Убрать дату</button>}
              {error && <p role="alert">{error}</p>}
            </form>}
          </article>;
        })}
      </section>;
    })}
  </section>;
}
