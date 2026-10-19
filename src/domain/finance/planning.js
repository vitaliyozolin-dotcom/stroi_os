import { financeMoney, text, validDate } from './policy.js';

const groups = ['construction', 'overhead', 'reserve', 'unallocated'];
const deny = () => ({ ok: false, error: 'Финансовое планирование доступно только роли «Управление».' });
const amountValid = value => Number.isFinite(value) && value >= 0 && Math.abs(value - financeMoney(value)) <= 0.000001;
export const budgetLineSnapshot = (state, lineId) => {
  const line = state.budgetLines.find(item => item.id === lineId);
  return JSON.stringify([line?.id, line?.plan, line?.forecast, state.budgetMeta.version, state.budgetMeta.source]);
};
export const classificationSnapshot = state => JSON.stringify([state.budgetLines, state.financeEntries]);

export const updateBudgetLine = (state, input, identity, timestamp) => {
  if (identity.role !== 'management') return deny();
  const line = state.budgetLines.find(item => item.id === input.lineId);
  if (!line) return { ok: false, error: 'Статья сметы не найдена. Обновите список.' };
  if (input.expected !== budgetLineSnapshot(state, input.lineId)) return { ok: false, error: 'Статья сметы обновилась. Откройте её заново.' };
  if (!amountValid(input.plan) || !amountValid(input.forecast)) return { ok: false, error: 'План и прогноз должны быть неотрицательными суммами с точностью до копеек.' };
  if (!text(input.source)) return { ok: false, error: 'Укажите источник плана.' };
  const source = input.source.trim(), version = input.version.trim() || state.budgetMeta.version;
  if (line.plan === input.plan && line.forecast === input.forecast && state.budgetMeta.source === source && state.budgetMeta.version === version) return { ok: true, changed: false, patch: {} };
  return { ok: true, changed: true, patch: {
    budgetLines: state.budgetLines.map(item => item.id === line.id ? { ...item, plan: input.plan, forecast: input.forecast } : item),
    budgetMeta: { ...state.budgetMeta, source, version, importedAt: timestamp },
  } };
};

export const classifyFinanceCosts = (state, input, identity) => {
  if (identity.role !== 'management') return deny();
  if (input.expected !== classificationSnapshot(state)) return { ok: false, error: 'Данные обновились. Откройте распределение заново.' };
  for (const [id, group] of Object.entries(input.lines)) {
    if (!state.budgetLines.some(line => line.id === id) || !groups.includes(group)) return { ok: false, error: 'Выберите существующую статью и допустимую категорию сметы.' };
  }
  for (const [id, group] of Object.entries(input.entries)) {
    if (!state.financeEntries.some(entry => entry.id === id && entry.kind === 'expense') || group !== '' && (!groups.includes(group) || group === 'reserve')) return { ok: false, error: 'Резерв не является расходом. Выберите допустимую категорию расхода.' };
  }
  const budgetLines = state.budgetLines.map(line => Object.hasOwn(input.lines, line.id) ? { ...line, costGroup: input.lines[line.id] } : line);
  const financeEntries = state.financeEntries.map(entry => Object.hasOwn(input.entries, entry.id) ? { ...entry, costGroup: input.entries[entry.id] || undefined } : entry);
  const changed = budgetLines.some((line, index) => line.costGroup !== state.budgetLines[index].costGroup)
    || financeEntries.some((entry, index) => entry.costGroup !== state.financeEntries[index].costGroup);
  return { ok: true, changed, patch: changed ? { budgetLines, financeEntries } : {} };
};

export const setFinanceDueDate = (state, input, identity) => {
  if (identity.role !== 'management') return deny();
  const entry = state.financeEntries.find(item => item.id === input.entryId);
  if (!entry || input.expected !== JSON.stringify(entry)) return { ok: false, error: 'Запись обновилась. Закройте выбор даты и откройте заново.' };
  const dueDate = input.date || undefined;
  if (dueDate !== undefined && !validDate(dueDate)) return { ok: false, error: 'Укажите корректную дату.' };
  if (dueDate === entry.dueDate) return { ok: true, changed: false, patch: {} };
  return { ok: true, changed: true, patch: { financeEntries: state.financeEntries.map(item => item.id === entry.id ? { ...item, dueDate } : item) } };
};

// Called on trusted writes in both runtimes. Legacy unchanged values remain readable.
export const validateBudgetPlanningChanges = (previous, state, identity) => {
  const before = new Map((previous?.budgetLines ?? []).map(line => [line.id, line]));
  if (JSON.stringify(previous?.budgetMeta) !== JSON.stringify(state.budgetMeta) && identity.role !== 'management') return 'Смету меняет только роль «Управление».';
  for (const line of state.budgetLines ?? []) {
    const old = before.get(line.id);
    for (const field of ['plan', 'forecast']) {
      if (line[field] === old?.[field]) continue;
      if (identity.role !== 'management') return 'Смету меняет только роль «Управление».';
      if (!amountValid(line[field])) return 'План и прогноз должны быть неотрицательными суммами с точностью до копеек.';
    }
  }
  return '';
};
