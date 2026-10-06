import { useState, type FormEvent } from 'react';
import { ArrowUpRight, CalendarDays } from 'lucide-react';
import type { AppState, FinanceEntry } from '../entities/index';
import { financeCalendarItems, financeCalendarTotal, validFinanceDueDate, type FinanceCalendarGroup } from '../domain/finance-calendar';
import { needsExpenseApproval } from '../domain/expense-workflow';
import { formatDate, money } from '../presentation/formatting';
import { financeEntryTitle } from '../presentation/finance-view';
import { uid } from '../infrastructure/runtime';
import './finance-payment-calendar.css';

const groups: { id: FinanceCalendarGroup; title: string }[] = [
  { id: 'overdue', title: 'Срок прошёл' },
  { id: 'next7', title: 'Ближайшие 7 дней' },
  { id: 'later', title: 'Позже' },
  { id: 'undated', title: 'Без даты' },
];

export function FinancePaymentCalendar({ state, actor, onChange, onOpenEntry, onAddEntry }: {
  state: AppState; actor: string; onChange: (next: AppState) => void; onOpenEntry: (id: string) => void;
  onAddEntry: (kind: 'expense' | 'income') => void;
}) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [editing, setEditing] = useState<{ id: string; snapshot: string; value: string } | null>(null);
  const [error, setError] = useState('');
  const items = financeCalendarItems(state).filter(item => item.entry.kind === kind);
  const total = financeCalendarTotal(items);
  const openDate = (entry: FinanceEntry) => {
    setError('');
    setEditing({ id: entry.id, snapshot: JSON.stringify(entry), value: entry.dueDate ?? '' });
  };
  const saveDate = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const entry = state.financeEntries.find(item => item.id === editing.id);
    if (!entry || JSON.stringify(entry) !== editing.snapshot) { setError('Запись обновилась. Закройте выбор даты и откройте заново.'); return; }
    if (editing.value && !validFinanceDueDate(editing.value)) { setError('Укажите корректную дату.'); return; }
    const dueDate = editing.value || undefined;
    if (dueDate === entry.dueDate) { setEditing(null); return; }
    const now = new Date().toISOString();
    onChange({ ...state,
      financeEntries: state.financeEntries.map(item => item.id === entry.id ? { ...item, dueDate } : item),
      activity: [{ id: uid('activity'), timestamp: now, actor, text: `${dueDate ? `Плановая дата ${kind === 'expense' ? 'выплаты' : 'поступления'}: ${formatDate(dueDate, true)}` : 'Плановая дата платежа снята'} · ${entry.description}`, tone: 'neutral' }, ...state.activity],
    });
    setEditing(null);
  };
  return <section className="finance-calendar" aria-label="Платёжный календарь">
    <div className="finance-calendar__head">
      <div className="finance-calendar__switch" role="group" aria-label="Выплаты или поступления">
        <button type="button" aria-pressed={kind === 'expense'} onClick={() => { setKind('expense'); setEditing(null); }}>Нужно оплатить</button>
        <button type="button" aria-pressed={kind === 'income'} onClick={() => { setKind('income'); setEditing(null); }}>Ожидаем поступления</button>
      </div>
      {items.length > 0 && <div className="finance-calendar__total"><small>{kind === 'expense' ? 'Осталось по обязательствам' : 'Осталось получить'}</small><strong>{money(total)}</strong></div>}
    </div>
    {items.length > 0 && <p className="finance-calendar__note">Остатки по внесённым обязательствам. Сроки задаются отдельно.</p>}
    {!items.length && <div className="finance-calendar__empty"><CalendarDays size={22} aria-hidden="true" /><div><strong>{kind === 'expense' ? 'Будущие выплаты ещё не внесены' : 'Будущие поступления ещё не внесены'}</strong><p>{kind === 'expense' ? 'Добавьте предстоящий расход и назначьте дату оплаты.' : 'Добавьте ожидаемое поступление и назначьте дату.'}</p></div><button type="button" className="button button--secondary" onClick={() => onAddEntry(kind)}>{kind === 'expense' ? 'Добавить расход' : 'Добавить поступление'}</button></div>}
    {groups.map(group => {
      const rows = items.filter(item => item.group === group.id);
      if (!rows.length) return null;
      return <section className={`finance-calendar__group finance-calendar__group--${group.id}`} key={group.id} aria-label={group.title}>
        <header><h3>{group.title} <span>{rows.length}</span></h3><strong>{money(financeCalendarTotal(rows))}</strong></header>
        {rows.map(({ entry, dueDate, remaining }) => <article className="finance-calendar__row" key={entry.id}>
          <button className="finance-calendar__entry" type="button" onClick={() => { setEditing(null); onOpenEntry(entry.id); }}>
            <span><strong title={entry.description}>{financeEntryTitle(entry)}</strong><small>{entry.counterparty || 'Контрагент не указан'}{entry.kind === 'expense' && needsExpenseApproval(entry) && <span className="finance-calendar__approval"> · Не утверждено</span>}</small></span><ArrowUpRight size={16} aria-hidden="true" />
          </button>
          <strong className="finance-calendar__amount">{money(remaining)}</strong>
          <button className="finance-calendar__date" type="button" onClick={() => openDate(entry)} aria-label={`${dueDate ? 'Изменить' : 'Задать'} срок: ${entry.description}`}><CalendarDays size={14} aria-hidden="true" />{dueDate ? formatDate(dueDate, true) : 'Задать срок'}</button>
          {editing?.id === entry.id && <form className="finance-calendar__editor" onSubmit={saveDate}>
            <label>Плановая дата {entry.kind === 'expense' ? 'выплаты' : 'поступления'}<input autoFocus type="date" value={editing.value} onChange={event => setEditing({ ...editing, value: event.target.value })} /></label>
            <div><button type="button" className="button button--ghost" onClick={() => setEditing(null)}>Отмена</button><button type="submit" className="button button--primary">Сохранить</button></div>
            {entry.dueDate && <button className="finance-calendar__clear" type="button" onClick={() => setEditing({ ...editing, value: '' })}>Убрать дату</button>}
            {error && <p role="alert">{error}</p>}
          </form>}
        </article>)}
      </section>;
    })}
  </section>;
}
