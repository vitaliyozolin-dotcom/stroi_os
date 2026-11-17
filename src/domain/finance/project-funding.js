import { text, validDate } from './policy.js';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = funding => funding ? structuredClone(Object.fromEntries(Object.entries(funding).filter(([key]) => !['history', 'recordedAt', 'recordedBy', 'changeReason'].includes(key)))) : undefined;
const amount = value => Number.isSafeInteger(value) && value >= 0;

/** Validates and stamps the candidate only; evidence never creates cash movements. */
export function validateProjectFundingChanges(previous, state, identity, now) {
  const old = previous?.project?.funding, next = state.project?.funding;
  if (equal(old, next)) return '';
  if (identity.role !== 'management') return 'Источники финансирования подтверждает управление.';
  if (!next || typeof next !== 'object' || Array.isArray(next)) return 'Запись финансирования нельзя удалить. Исправьте её с основанием.';
  if (!equal(old?.history ?? [], next.history ?? [])) return 'История финансирования защищена от изменений.';
  if (!text(next.changeReason)) return 'Укажите основание изменения финансирования.';
  if (!['unknown', 'direct', 'escrow'].includes(next.route)) return 'Выберите схему оплаты заказчика.';
  if (next.bank !== undefined && typeof next.bank !== 'string' || next.escrowAccountReference !== undefined && typeof next.escrowAccountReference !== 'string') return 'Укажите текстовое название банка и идентификатор счёта.';
  if (next.escrowAccountId && !state.treasury?.accounts?.some(account => account.id === next.escrowAccountId)) return 'Счёт эскроу не найден.';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const documentValid = value => !value || state.documents?.some(document => document.id === value);
  const events = next.escrow ?? {};
  if (!events || typeof events !== 'object' || Array.isArray(events) || Object.keys(events).some(key => !['planned', 'deposited', 'released', 'received'].includes(key))) return 'Проверьте события эскроу.';
  for (const [key, event] of Object.entries(events)) {
    if (!event || !amount(event.amountCents) || !validDate(event.date) || !text(event.source) || !documentValid(event.documentId)) return 'Для события эскроу нужны точная сумма, дата и основание из этого проекта.';
    if (key !== 'planned' && event.date > today) return 'Фактическое событие эскроу не может быть в будущем.';
  }
  for (const [earlier, later] of [['deposited', 'released'], ['released', 'received']]) {
    if (events[earlier] && events[later] && (events[later].date < events[earlier].date || events[later].amountCents > events[earlier].amountCents)) return 'Проверьте порядок дат и накопленные суммы наполнения, раскрытия и получения эскроу.';
  }
  const contractor = next.contractor;
  if (contractor) {
    if (!['unknown', 'own', 'loan', 'partner', 'customer_direct', 'mixed'].includes(contractor.kind) || typeof contractor.confirmed !== 'boolean' || contractor.amountCents !== undefined && !amount(contractor.amountCents) || contractor.date && !validDate(contractor.date) || !documentValid(contractor.documentId)) return 'Проверьте источник денег подрядчика.';
    if (contractor.confirmed && (contractor.kind === 'unknown' || !amount(contractor.amountCents) || !validDate(contractor.date) || contractor.date > today || !text(contractor.source))) return 'Для подтверждённого источника нужны сумма, фактическая дата и основание.';
  }
  if (equal(record(old), record(next))) { state.project.funding = structuredClone(old); return ''; }
  next.recordedAt = now; next.recordedBy = identity.name;
  next.history = [...(old?.history ?? []), ...(old && !old.history?.length ? [{ at: old.recordedAt ?? now, by: old.recordedBy ?? identity.name, reason: 'Исходная запись', record: record(old) }] : []), { at: now, by: identity.name, reason: next.changeReason.trim(), record: record(next) }];
  return '';
}
