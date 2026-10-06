import { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Search } from 'lucide-react';
import type { AppState } from '../entities/index';
import { paymentEvidence } from '../domain/payment-evidence';
import { financeEntryTitle, financeMovementRows, financeToday } from '../presentation/finance-view';
import { formatDate, money } from '../presentation/formatting';

export function FinanceOperations({ state, onOpenEntry }: { state: AppState; onOpenEntry: (id: string) => void }) {
  const [kind, setKind] = useState<'all' | 'expense' | 'income'>('all');
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState('all');
  const [limit, setLimit] = useState(20);
  const movements = useMemo(() => financeMovementRows(state), [state.financeEntries]);
  const today = financeToday();
  const cutoff = new Date(`${today}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 29);
  const from = cutoff.toISOString().slice(0, 10);
  const rows = movements.filter(row => {
    if (kind !== 'all' && row.entry.kind !== kind) return false;
    if (query && !`${row.entry.description} ${row.entry.counterparty} ${row.entry.document ?? ''} ${row.amount}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))) return false;
    if (period === 'undated') return !row.date;
    if (period === 'month') return Boolean(row.date && row.date.slice(0, 7) === today.slice(0, 7) && row.date <= today);
    if (period === '30') return Boolean(row.date && row.date >= from && row.date <= today);
    return true;
  });
  const income = rows.filter(row => row.entry.kind === 'income').reduce((sum, row) => sum + row.amount, 0);
  const expense = rows.filter(row => row.entry.kind === 'expense').reduce((sum, row) => sum + row.amount, 0);
  const undated = movements.filter(row => !row.date && (kind === 'all' || row.entry.kind === kind)).length;
  const reset = () => setLimit(20);
  return <section className="finance-operations" aria-label="Записанные денежные операции" data-tour="finance-flow">
    <div className="finance-operations__toolbar">
      <div className="finance-segments" role="group" aria-label="Вид операций">{([['all', 'Все'], ['expense', 'Расходы'], ['income', 'Поступления']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => { setKind(value); reset(); }}>{label}</button>)}</div>
      <div className="finance-operations__filters"><label className="finance-search"><Search size={17} /><input aria-label="Поиск операций" placeholder="Найти операцию" value={query} onChange={event => { setQuery(event.target.value); reset(); }} /></label><select aria-label="Период операций" value={period} onChange={event => { setPeriod(event.target.value); reset(); }}><option value="all">За всё время</option><option value="month">Этот месяц</option><option value="30">Последние 30 дней</option><option value="undated">Без даты оплаты</option></select></div>
    </div>
    <div className="finance-operations__caption"><span>{rows.length} записей</span><span>{kind !== 'expense' && `Поступило ${money(income)}`}{kind === 'all' && ' · '}{kind !== 'income' && `Оплачено ${money(expense)}`}</span></div>
    {period !== 'all' && period !== 'undated' && undated > 0 && <p className="finance-inline-note">В этот период не включены оплаты без даты. <button type="button" onClick={() => { setPeriod('undated'); reset(); }}>Посмотреть {undated}</button></p>}
    <div className="finance-operation-list">{rows.slice(0, limit).map(row => {
      const evidence = paymentEvidence(row.entry, state.documents);
      return <button className="finance-operation" type="button" key={row.id} onClick={() => onOpenEntry(row.entry.id)}>
        <span className={`finance-operation__icon finance-operation__icon--${row.entry.kind}`}>{row.entry.kind === 'income' ? <ArrowDownLeft size={19} /> : <ArrowUpRight size={19} />}</span>
        <span className="finance-operation__description"><strong>{financeEntryTitle(row.entry)}</strong><span>{row.entry.counterparty.startsWith('Не указан в смете') ? 'Контрагент не уточнён' : row.entry.counterparty}{row.legacy && <small> · из прежнего учёта</small>}</span></span>
        <span className="finance-operation__date">{row.date ? formatDate(row.date, true) : 'Дата оплаты неизвестна'}</span>
        <span className="finance-operation__amount"><strong>{row.entry.kind === 'income' ? '+' : '−'}{money(row.amount)}</strong><small>{row.entry.kind === 'income' ? 'Получено' : evidence.sourceLabel}</small></span>
      </button>;
    })}</div>
    {!rows.length && <div className="finance-empty"><strong>{movements.length ? 'Ничего не найдено' : 'Записанных оплат пока нет'}</strong><p>{movements.length ? 'Измените поиск или период.' : 'Будущие расходы и поступления находятся в платёжном календаре.'}</p></div>}
    {rows.length > limit && <button className="finance-load-more" type="button" onClick={() => setLimit(value => value + 20)}>Показать ещё · {rows.length - limit}</button>}
  </section>;
}
