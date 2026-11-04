/** Explicit object attribution of existing financial sources. Never creates money or obligations. */
import { effectiveBudgetLines } from './finance-totals.js';
import { effectiveLedgerConfirmation, ledgerConfirmedLegacyPaidCents } from './finance-ledger.js';

const list = value => Array.isArray(value) ? value : [];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const positive = value => Number.isSafeInteger(value) && value > 0;
const cents = value => typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < .00001 ? Math.round(value * 100) : null;
const stable = value => JSON.stringify(value, (_, row) => record(row) ? Object.fromEntries(Object.keys(row).sort().filter(key => row[key] !== undefined).map(key => [key, row[key]])) : row);
const same = (a, b) => stable(a) === stable(b);
const sum = values => { let result = 0; for (const value of values) { if (!Number.isSafeInteger(value) || !Number.isSafeInteger(result + value)) return null; result += value; } return result; };
const without = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const sourceKey = (type, id) => JSON.stringify([type, id]);
export const orderObjectCostSourceKey = source => sourceKey(source.sourceType, source.sourceId);
const rowKey = row => sourceKey(row.sourceType, row.sourceId);

/** Three independent measures: plan, contractual commitment, actual outgoing payment net of refunds. */
export function orderObjectCostSources(state) {
  const sources = [];
  const add = row => { if (Number.isSafeInteger(row.amountCents) && row.amountCents >= 0) sources.push(row); };
  for (const line of effectiveBudgetLines(state)) add({ sourceType: 'budget', sourceId: line.id, label: line.name, amountCents: cents(line.plan), sign: 1,
    navigateTo: 'budget', entityId: line.id, source: state.budgetMeta?.source ?? '' });
  for (const entry of list(state.financeEntries).filter(row => row.kind === 'expense')) {
    add({ sourceType: 'commitment', sourceId: entry.id, label: entry.description, counterparty: entry.counterparty, amountCents: cents(entry.amount), sign: 1,
      navigateTo: 'finance', entityId: entry.id, source: entry.document ?? '', date: entry.date });
    const legacy = ledgerConfirmedLegacyPaidCents(state, entry);
    if (positive(legacy)) add({ sourceType: 'payment', sourceId: `legacy:${entry.id}`, label: `Ранее оплачено: ${entry.description}`, counterparty: entry.counterparty,
      amountCents: legacy, sign: 1, navigateTo: 'finance', entityId: entry.id, source: entry.paymentDocument ?? entry.legacyPayment?.document ?? '', date: entry.paidAt?.slice(0, 10) ?? entry.date });
  }
  const ledger = state.financeLedger;
  for (const operation of list(ledger?.operations)) {
    if (operation.legacyPayment || effectiveLedgerConfirmation(ledger, operation) === 'claimed') continue;
    const interest = operation.kind === 'interest' && list(ledger?.loans).some(loan => loan.id === operation.loanId && loan.direction === 'borrowed');
    if (!['payment', 'supplier_refund'].includes(operation.kind) && !interest) continue;
    const parentSourceId = operation.kind === 'supplier_refund' ? operation.refundOfOperationId ? `ledger:${operation.refundOfOperationId}`
      : operation.refundOfLegacyPayment ? `legacy:${operation.refundOfLegacyPayment.entryId}` : null : null;
    add({ sourceType: 'payment', sourceId: `ledger:${operation.id}`, label: operation.description, counterparty: operation.counterparty, amountCents: operation.amountCents,
      sign: operation.kind === 'supplier_refund' ? -1 : 1, ...(parentSourceId ? { parentSourceId } : {}), navigateTo: 'ledger', entityId: operation.id,
      source: operation.source, date: operation.date, ...(operation.sharedPaymentId ? { sharedPaymentId: operation.sharedPaymentId } : {}),
      ...(operation.cashTreatment === 'participant_direct' ? { participantDirect: true } : {}) });
  }
  return sources;
}

/** Returns an error; server stamps occur only after all allocation checks succeed. */
export function validateOrderObjectCostAllocations(previous, next, identity, now) {
  try {
    const old = previous?.orderRelations?.costAllocations ?? [], rows = next?.orderRelations?.costAllocations ?? [];
    if (!Array.isArray(rows) || rows.length > 500 || rows.some(row => !record(row))) return 'Некорректное распределение затрат между объектами.';
    if (same(old, rows) && !rows.length) return '';
    const changed = !same(old, rows);
    if (changed && identity?.role !== 'management') return 'Распределение затрат по объектам меняет только управление.';
    const sources = new Map(orderObjectCostSources(next).map(source => [orderObjectCostSourceKey(source), source]));
    const objects = new Set(list(next.orderRelations?.objects).map(row => row.id));
    const oldRows = new Map(list(old).map(row => [row.id, row]));
    const ids = new Set(), totals = new Map();
    const cancellationKeys = ['status', 'canceledReason', 'canceledAt', 'canceledBy'];
    for (const row of rows) {
      if (!Object.keys(row).every(key => ['id', 'objectId', 'sourceType', 'sourceId', 'amountCents', 'source', 'status', 'recordedAt', 'recordedBy', ...cancellationKeys].includes(key))
        || !text(row.id, 120) || !/^[a-zA-Z0-9._:-]+$/.test(row.id) || ids.has(row.id) || !objects.has(row.objectId)
        || !['budget', 'commitment', 'payment'].includes(row.sourceType) || !text(row.sourceId, 500) || !positive(row.amountCents)
        || !text(row.source, 2000) || !['active', 'canceled'].includes(row.status)) return 'У доли нужны уникальный ID, существующий объект, финансовый источник, точная положительная сумма и основание.';
      ids.add(row.id);
      const before = oldRows.get(row.id);
      if (!same(before?.recordedAt, row.recordedAt) || !same(before?.recordedBy, row.recordedBy) || !same(before?.canceledAt, row.canceledAt) || !same(before?.canceledBy, row.canceledBy)) return 'Автора и время распределения затрат записывает сервер.';
      if (before && !same(without(before, cancellationKeys), without(row, cancellationKeys))) return 'Записанную долю нельзя переписать. Отмените её с основанием и добавьте новое распределение.';
      if (before?.status === 'canceled' && !same(before, row)) return 'Отменённое распределение сохраняется неизменным в истории.';
      if (!before && row.status !== 'active') return 'Новое распределение должно быть действующим.';
      if (row.status === 'canceled') {
        if (!text(row.canceledReason, 2000)) return 'Укажите причину отмены распределения.';
      } else {
        if (row.canceledReason !== undefined || row.canceledAt !== undefined || row.canceledBy !== undefined) return 'Основание отмены допустимо только у отменённой доли.';
        const source = sources.get(rowKey(row));
        if (!source) return 'Источник распределения не найден среди текущего бюджета, расходных обязательств или подтверждённых оплат поставщикам.';
        const total = sum([totals.get(rowKey(row)) ?? 0, row.amountCents]);
        if (total === null || total > source.amountCents) return 'Доли объектов превышают исходную сумму. Сначала отмените лишнее распределение или исправьте источник.';
        totals.set(rowKey(row), total);
      }
    }
    if (list(old).some(row => !ids.has(row.id))) return 'Распределение затрат нельзя удалить; отмените его с сохранением истории.';
    // A refund may reduce only objects explicitly charged by its original payment.
    const refundTotals = new Map();
    for (const row of rows.filter(row => row.status === 'active')) {
      const source = sources.get(rowKey(row));
      if (source.sign !== -1) continue;
      if (!source.parentSourceId) return 'Для возврата нужен исходный платёж.';
      const key = JSON.stringify([source.parentSourceId, row.objectId]);
      const allocated = sum(rows.filter(original => original.status === 'active' && original.sourceType === 'payment' && original.sourceId === source.parentSourceId && original.objectId === row.objectId).map(original => original.amountCents));
      const refunded = sum([refundTotals.get(key) ?? 0, row.amountCents]);
      if (allocated === null || refunded === null || refunded > allocated) return 'Возврат по объекту превышает долю исходной оплаты этого объекта. Сначала распределите исходный платёж.';
      refundTotals.set(key, refunded);
    }
    if (changed && now) for (const row of rows) {
      const before = oldRows.get(row.id), by = identity.name || identity.id || 'Управление';
      if (!before) { row.recordedAt = now; row.recordedBy = by; }
      if (row.status === 'canceled' && before?.status !== 'canceled') { row.canceledAt = now; row.canceledBy = by; }
    }
    return '';
  } catch { return 'Не удалось проверить распределение затрат по объектам. Проверьте суммы и ссылки на исходные записи.'; }
}

export function orderObjectCostSummary(state) {
  const rows = list(state.orderRelations?.costAllocations).filter(row => row.status === 'active');
  const sources = orderObjectCostSources(state), lookup = new Map(sources.map(source => [orderObjectCostSourceKey(source), source]));
  const warnings = [];
  const sourceRows = sources.map(source => {
    const allocatedCents = sum(rows.filter(row => rowKey(row) === orderObjectCostSourceKey(source)).map(row => row.amountCents));
    const remainingCents = allocatedCents === null ? null : source.amountCents - allocatedCents;
    if (remainingCents === null || remainingCents < 0) warnings.push(`Распределение «${source.label}» требует сверки с исходной суммой.`);
    return { ...source, allocatedCents, remainingCents };
  });
  const totalsFor = values => Object.fromEntries(['budget', 'commitment', 'payment'].map(type => [type, sum(values.filter(row => row.sourceType === type).map(row => Number.isSafeInteger(row.amountCents) ? row.amountCents * row.sign : null))]));
  const objectRows = list(state.orderRelations?.objects).map(object => {
    const allocations = rows.filter(row => row.objectId === object.id);
    const values = allocations.flatMap(row => { const source = lookup.get(rowKey(row)); return source ? [{ sourceType: row.sourceType, amountCents: row.amountCents, sign: source.sign }] : []; });
    const unresolvedCount = allocations.filter(row => !lookup.has(rowKey(row))).length;
    if (unresolvedCount) warnings.push(`${object.title}: источник ${unresolvedCount} распределений не найден.`);
    const totals = totalsFor(values);
    for (const type of ['budget', 'commitment', 'payment']) if (!values.some(row => row.sourceType === type) || allocations.some(row => row.sourceType === type && !lookup.has(rowKey(row)))) totals[type] = null;
    return { objectId: object.id, title: object.title, ...totals, unresolvedCount };
  });
  const unallocated = totalsFor(sourceRows.map(row => ({ sourceType: row.sourceType, amountCents: row.remainingCents, sign: row.sign })));
  const totals = totalsFor(sources);
  if (!sources.some(row => row.sourceType === 'budget')) { totals.budget = null; unallocated.budget = null; }
  return { objects: objectRows, sources: sourceRows, totals, unallocated, warnings: [...new Set(warnings)] };
}
