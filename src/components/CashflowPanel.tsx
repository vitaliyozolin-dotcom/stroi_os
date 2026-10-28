import { ChevronDown } from 'lucide-react';
import type { AppState } from '../entities/index';
import { financeCashMovementRows } from '../domain/index';
import { money } from '../presentation/formatting';
import { financeCalendarToday } from '../domain/finance-calendar';
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
 const today = new Date(`${financeCalendarToday()}T12:00:00Z`);
 const movements = financeCashMovementRows(state);
 const undated = movements.filter(row => !row.date).reduce((total, row) => ({ expense: total.expense + row.outflowCents / 100, income: total.income + row.inflowCents / 100 }), { expense: 0, income: 0 });
  const currentWeek = startOfWeek(today);
  const cashflow = Array.from({ length: 6 }, (_, index) => {
    const start = shiftDays(currentWeek, (index - 5) * 7);
    const end = shiftDays(start, 6);
    return { start, end, label: weekLabel(start, end), expense: 0, income: 0 };
  });
  for (const movement of movements) {
    if (!movement.date) continue;
    const date = new Date(`${movement.date}T12:00:00Z`);
    const point = cashflow.find(item => date >= item.start && date <= item.end);
    if (!point) continue;
    point.income += movement.inflowCents / 100000;
    point.expense += movement.outflowCents / 100000;
  }
  const maxCash = Math.max(1, ...cashflow.flatMap((point) => [point.expense, point.income]));
  const hasCashflow = cashflow.some((point) => point.expense > 0 || point.income > 0);
 return <details className="finance-history"><summary><span>Движение денег по неделям</span><small>Последние 6 недель</small><ChevronDown size={16} aria-hidden="true" /></summary><div className="finance-history__body"><p className="finance-history__note">Денежные движения, включая займы, возвраты и обе стороны перевода между счетами. Прежние записи без привязки к счёту требуют сверки.</p>
          {hasCashflow ? <><div className="chart-legend"><span><i className="legend-dot legend-dot--income" /> Поступления</span><span><i className="legend-dot legend-dot--expense" /> Выплаты</span><small>тыс. ₽</small></div><div className="cash-chart">
            {cashflow.map((point) => (
              <div className="cash-chart__column" key={point.label}>
                <div className="cash-chart__bars">
                  <span className="cash-chart__bar cash-chart__bar--income" style={{ height: `${point.income > 0 ? Math.max(2, point.income / maxCash * 100) : 0}%` }} title={`Поступления ${point.income} тыс. ₽`} />
                  <span className="cash-chart__bar cash-chart__bar--expense" style={{ height: `${point.expense > 0 ? Math.max(2, point.expense / maxCash * 100) : 0}%` }} title={`Выплаты ${point.expense} тыс. ₽`} />
                </div>
                <small>{point.label}</small>
              </div>
            ))}
          </div></> : <p className="finance-history__empty">За последние 6 недель нет платежей с известной датой.</p>}
          {(undated.expense > 0 || undated.income > 0) && <p className="finance-history__note">Без даты: {[(undated.expense > 0 ? `выплаты ${money(undated.expense)}` : ''), (undated.income > 0 ? `поступления ${money(undated.income)}` : '')].filter(Boolean).join(' · ')}. Учтены в общих суммах, но не в графике.</p>}
          </div></details>;
}
