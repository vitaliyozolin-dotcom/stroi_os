import { restoreKnownPprBaseline, validPlanDate } from '../lib/plan-baseline.js';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const reason = (item) => typeof item.planChangeReason === 'string' ? item.planChangeReason.trim() : '';

export function validateBaselineChanges(previous, next, identity, now = new Date().toISOString()) {
  const beforeState = previous ? restoreKnownPprBaseline(previous) : null;
  const restored = restoreKnownPprBaseline(next);
  next.stages = restored.stages;
  const manager = identity.role === 'management';

  const check = (before, item, fields, kind) => {
    if (before?.baseline) {
      // Older clients do not know this field. Preserve it on the server.
      if (item.baseline === undefined) item.baseline = structuredClone(before.baseline);
      else if (!same(before.baseline, item.baseline)) return 'План 0 уже зафиксирован. Изменяйте действующие сроки, сохраняя первоначальные.';
    } else if (item.baseline) {
      const b = item.baseline;
      if (!manager && (before || kind !== 'task') || !validPlanDate(b.end) || b.start && (!validPlanDate(b.start) || b.start > b.end)
        || !['initial', 'document', 'snapshot'].includes(b.source) || typeof b.note !== 'string' || !b.note.trim()) return 'Для фиксации Плана 0 нужны корректные даты, источник и права управления.';
      b.recordedAt = now;
      b.recordedBy = identity.name;
    }
    if (kind === 'task') {
      if (before?.originalDueDate) {
        if (item.originalDueDate === undefined) item.originalDueDate = before.originalDueDate;
        if (item.originalDueDate !== before.originalDueDate || item.baseline && item.baseline.end !== before.originalDueDate) return 'Сохранённый исходный срок задачи нельзя изменить при переносе.';
      } else if (before && item.originalDueDate && !item.baseline) return 'Укажите источник восстановленного первоначального срока задачи.';
      if (item.baseline) item.originalDueDate = item.baseline.end;
      if (!before) {
        if (!validPlanDate(item.dueDate) || item.originalDueDate && item.originalDueDate !== item.dueDate
          || item.baseline && item.baseline.end !== item.dueDate) return 'Первоначальный срок новой задачи должен совпадать со сроком при постановке.';
        item.originalDueDate = item.dueDate;
        item.baseline = { start: item.plannedStart || undefined, end: item.dueDate, source: 'initial', note: 'Первоначальный срок при постановке задачи', recordedAt: now, recordedBy: identity.name };
      }
    }
    if (before?.plannedStart && item.plannedStart === undefined) item.plannedStart = before.plannedStart;
    const changed = fields.filter((key) => !same(before?.[key], item[key]));
    for (const key of changed) if (!(key === 'plannedStart' && !item[key]) && !validPlanDate(item[key])) return 'Укажите существующую календарную дату.';
    const start = item[fields[0]], end = item[fields[1]];
    if (start && end && start > end) return 'Плановое окончание не может быть раньше начала.';
    if (before && changed.length) {
      if (!manager) return 'Действующий план меняет управление.';
      if (!reason(item)) return 'Укажите причину изменения срока. План 0 останется прежним.';
    }
    const history = [...(before?.planHistory ?? []), ...(before ? changed.map((field) => ({
      at: now, actor: identity.name, field, before: before[field] || '', after: item[field] || '', reason: reason(item),
    })) : [])];
    if (history.length || before?.planHistory) item.planHistory = history;
    else delete item.planHistory;
    delete item.planChangeReason;
    return null;
  };
  const projectError = check(beforeState?.project, next.project, ['startDate', 'targetDate'], 'project');
  if (projectError) return projectError;
  for (const [collection, fields, kind] of [['stages', ['planStart', 'planEnd'], 'stage'], ['tasks', ['plannedStart', 'dueDate'], 'task']]) {
    const existing = new Map((beforeState?.[collection] ?? []).map((item) => [item.id, item]));
    for (const old of existing.values()) if ((old.baseline || kind === 'task' && old.originalDueDate)
      && !(next[collection] ?? []).some((item) => item.id === old.id)) return 'Нельзя удалить запись с Планом 0. Сохраните её историю.';
    for (const item of next[collection] ?? []) {
      const error = check(existing.get(item.id), item, fields, kind);
      if (error) return error;
    }
  }
  return null;
}
