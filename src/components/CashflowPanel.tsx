import { Banknote } from 'lucide-react';
import type { AppState } from '../entities/index';
import { paidAmountFor, paymentMovements, undatedPayments } from '../domain/index';
import { money } from '../presentation/formatting';
const startOfWeek = (date: Date) => {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value;
};

const shiftDays = (date: Date, days: number) => {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
};

const weekLabel = (start: Date, end: Date) => {
  const formatter = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${formatter.format(start)}–${formatter.format(end)}`;
};

export function CashflowPanel({ state }: { state: AppState }) {
 const today = new Date();
 const undated = undatedPayments(state);
  const currentWeek = startOfWeek(today);
  const cashflow = Array.from({ length: 6 }, (_, index) => {
    const start = shiftDays(currentWeek, (index - 5) * 7);
    const end = shiftDays(start, 6);
    return { start, end, label: weekLabel(start, end), expense: 0, income: 0 };
  });
  for (const entry of state.financeEntries) {
    for (const movement of paymentMovements(entry)) {
      const amount = movement.amount;
      if (amount <= 0) continue;
      const paidAt = movement.date;
      if (!paidAt) continue;
      const date = new Date(`${paidAt.slice(0, 10)}T12:00:00Z`);
      const point = cashflow.find((item) => date >= item.start && date <= item.end);
      if (!point) continue;
      if (entry.kind === 'income') point.income += amount / 1000;
      else point.expense += amount / 1000;
    }
  }
  const maxCash = Math.max(1, ...cashflow.flatMap((point) => [point.expense, point.income]));
  const hasCashflow = cashflow.some((point) => point.expense > 0 || point.income > 0);
 return <details className="panel finance-cashflow"><summary>Денежный поток · 6 недель</summary>          <div className="chart-legend"><span><i className="legend-dot legend-dot--income" /> Поступления</span><span><i className="legend-dot legend-dot--expense" /> Выплаты</span><small>тыс. ₽</small></div>
          {hasCashflow ? <div className="cash-chart">
            {cashflow.map((point) => (
              <div className="cash-chart__column" key={point.label}>
                <div className="cash-chart__bars">
                  <span className="cash-chart__bar cash-chart__bar--income" style={{ height: `${Math.max(2, point.income / maxCash * 100)}%` }} title={`Поступления ${point.income} тыс. ₽`} />
                  <span className="cash-chart__bar cash-chart__bar--expense" style={{ height: `${Math.max(2, point.expense / maxCash * 100)}%` }} title={`Выплаты ${point.expense} тыс. ₽`} />
                </div>
                <small>{point.label}</small>
              </div>
            ))}
          </div> : <div className="task-empty"><Banknote size={28} /><strong>Нет датированных движений за эти недели</strong><p>Оплаты без установленной даты учитываются в общих итогах, но не распределяются по неделям.</p></div>}
          {(undated.expense > 0 || undated.income > 0) && <p role="note">Дата не установлена: выплаты {money(undated.expense)}, поступления {money(undated.income)}. Эти суммы не включены в график.</p>}
          {state.financeEntries.some(entry => !entry.payments?.length && paidAmountFor(entry) > 0) && <p role="note">Старые записи показаны по указанной в них дате оплаты. Их разбивка на отдельные платежи ещё не сверена.</p>}</details>;
}
