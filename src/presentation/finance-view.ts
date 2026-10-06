import type { AppState, FinanceEntry } from '../entities/index';
import { paymentMovements } from '../domain/finance';

/** Display-only label. Original descriptions and source documents are untouched. */
export function financeEntryTitle(entry: Pick<FinanceEntry, 'description' | 'counterparty'>) {
  let title = entry.description.trim().replace(/\s+/g, ' ');
  if (title.toLocaleLowerCase('ru').startsWith(`${entry.counterparty} · `.toLocaleLowerCase('ru'))) {
    title = title.slice(entry.counterparty.length + 3);
  }
  title = title.replace(/^Сч[её]т\s*№\s*[^·]+·\s*/i, '');
  title = title.split(/\.\s+(?=Наличными|Колонка|Лист\s*\d|Дата документа|Дата оплаты|Оплата работы|Вместе с|Отдельно от|Внесена сумма|Не является)/i)[0];
  title = title.split(/;\s*/)[0];
  if (title.length > 86) {
    const cut = title.slice(0, 83);
    title = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 60))}…`;
  }
  return title || 'Операция';
}

export function financeMovementRows(state: AppState) {
  return state.financeEntries.flatMap(entry => paymentMovements(entry)
    .filter(movement => movement.amount > 0)
    .map((movement, index) => ({ ...movement, entry, id: `${entry.id}:movement:${index}` })))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id));
}

export const financeToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
