// Deterministic planning, inventory and budget policies shared by browser and server.
const integer = Number.isSafeInteger;
const nonnegative = value => integer(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
const stable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const cents = value => typeof value === 'number' && Number.isFinite(value) && integer(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < .00001 ? Math.round(value * 100) : null;
const total = values => { let result = 0; for (const value of values) { if (!integer(value) || !integer(result + value)) return null; result += value; } return result; };

export function treasuryInventorySummary(treasury = {}) {
  const lots = treasury.inventoryLots ?? [], movements = treasury.inventoryMovements ?? [], reversed = new Set(movements.filter(row => row.kind === 'reverse').map(row => row.reversesId));
  const rows = lots.map(lot => {
    const consumedQuantityMillis = total(movements.filter(row => row.lotId === lot.id && row.kind === 'consume' && !reversed.has(row.id)).map(row => row.quantityMillis));
    const valid = integer(lot.quantityMillis) && lot.quantityMillis > 0 && nonnegative(lot.totalCostCents) && nonnegative(consumedQuantityMillis) && consumedQuantityMillis <= lot.quantityMillis;
    const consumedCents = valid ? Number(BigInt(lot.totalCostCents) * BigInt(consumedQuantityMillis) / BigInt(lot.quantityMillis)) : null;
    return { id: lot.id, name: lot.name, costEstimateId: lot.costEstimateId, unit: lot.unit, quantityMillis: lot.quantityMillis,
      consumedQuantityMillis: valid ? consumedQuantityMillis : null, remainingQuantityMillis: valid ? lot.quantityMillis - consumedQuantityMillis : null,
      receivedCents: valid ? lot.totalCostCents : null, consumedCents, stockCents: valid ? lot.totalCostCents - consumedCents : null };
  });
  return { rows, receivedCents: total(rows.map(row => row.receivedCents)), consumedCents: total(rows.map(row => row.consumedCents)), stockCents: total(rows.map(row => row.stockCents)), valid: rows.every(row => row.stockCents !== null) };
}

export function treasuryBudgetComparison(state, versionId) {
  const treasury = state.treasury ?? {}, versions = treasury.budgetVersions ?? [];
  const selected = versions.find(row => row.id === (versionId ?? treasury.activeBudgetVersionId)) ?? null, original = versions[0] ?? null;
  const comparable = Boolean(selected && original && selected.taxBasis === original.taxBasis);
  const current = selected?.lines ?? (state.budgetLines ?? []).map(row => ({ id: row.id, name: row.name, amountCents: cents(row.plan) }));
  const ids = [...new Set([...(original?.lines ?? []).map(row => row.id), ...current.map(row => row.id)])];
  const rows = ids.map(id => { const baseline = original?.lines.find(row => row.id === id), approved = current.find(row => row.id === id); return { id, name: approved?.name ?? baseline?.name ?? id,
    originalCents: original ? baseline?.amountCents ?? 0 : null, approvedCents: approved?.amountCents ?? 0,
    changeCents: comparable ? (approved?.amountCents ?? 0) - (baseline?.amountCents ?? 0) : null }; });
  const originalCents = original ? total(original.lines.map(row => row.amountCents)) : null;
  const approvedCents = total(current.map(row => row.amountCents));
  return { selected, original, comparable, rows, originalCents, approvedCents, changeCents: !comparable || originalCents === null || approvedCents === null ? null : approvedCents - originalCents };
}

export function treasuryRateDays(baselineEnd, endDate, calendar) {
  if (!date(baselineEnd) || !date(endDate) || !['calendar', 'workdays'].includes(calendar)) return null;
  const days = Math.round((Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${baselineEnd}T12:00:00Z`)) / 86400000);
  if (days <= 0) return 0;
  if (days > 3650) return null;
  if (calendar === 'calendar') return days;
  let count = 0;
  for (let i = 1; i <= days; i++) { const weekday = new Date(Date.parse(`${baselineEnd}T12:00:00Z`) + i * 86400000).getUTCDay(); if (weekday !== 0 && weekday !== 6) count++; }
  return count;
}

export function validateTreasuryPlanning(previous, next, identity, now) {
  const old = previous?.treasury ?? {}, treasury = next.treasury;
  const arrays = ['cashPlans', 'delayRates', 'inventoryLots', 'inventoryMovements', 'budgetVersions', 'savedScenarios'];
  for (const key of arrays) if (treasury[key] !== undefined && (!Array.isArray(treasury[key]) || treasury[key].length > 5000)) return 'Некорректный или слишком большой реестр планирования.';
  const today = now ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(now)) : null;
  const accounts = new Set(treasury.accounts.map(row => row.id)), entries = new Map((next.financeEntries ?? []).map(row => [row.id, row]));
  const budgetLines = new Set([...(next.budgetLines ?? []).map(row => row.id), ...(treasury.budgetVersions ?? []).find(row => row.id === treasury.activeBudgetVersionId)?.lines.map(row => row.id) ?? []]), costs = new Map(treasury.costEstimates.map(row => [row.id, row]));
  const ruleValid = rule => rule && integer(rule.offsetDays) && Math.abs(rule.offsetDays) <= 3650 && ['calendar', 'workdays'].includes(rule.calendar)
    && (['stage_start', 'stage_end', 'stage_acceptance'].includes(rule.kind) && (next.stages ?? []).some(row => row.id === rule.stageId)
      || ['task_start', 'task_end'].includes(rule.kind) && (next.tasks ?? []).some(row => row.id === rule.taskId));
  const uniqueRows = rows => rows.every(row => text(row?.id)) && new Set(rows.map(row => row.id)).size === rows.length;
  for (const key of arrays) if (!uniqueRows(treasury[key] ?? [])) return 'У записей планирования должны быть уникальные ID.';
  const covered = new Map();
  const validateCoverage = (row, maximum) => {
    if (row.coverage !== undefined && !Array.isArray(row.coverage)) return 'Некорректные связи плановых сумм с обязательствами.';
    const seen = new Set(); let allocated = 0;
    for (const part of row.coverage ?? []) {
      const entry = entries.get(part.entryId);
      if (!entry || seen.has(part.entryId) || !integer(part.amountCents) || part.amountCents <= 0 || entry.kind !== (row.kind ?? 'expense')) return 'Покрытие должно ссылаться на существующее обязательство того же направления и положительную сумму.';
      if (row.budgetLineId && entry.budgetLineId && row.budgetLineId !== entry.budgetLineId) return 'План и покрывающее обязательство относятся к разным статьям сметы.';
      seen.add(part.entryId); allocated += part.amountCents;
      covered.set(part.entryId, (covered.get(part.entryId) ?? 0) + part.amountCents);
      if (!integer(allocated) || !integer(covered.get(part.entryId)) || (cents(entry.amount) === null || covered.get(part.entryId) > cents(entry.amount))) return 'Обязательство покрывает больше плановых затрат, чем его полная сумма.';
    }
    return maximum !== null && allocated > maximum ? 'Покрытие обязательствами превышает исходную плановую сумму.' : '';
  };
  const validateCashPlan = (row, scenario = false) => {
    if (!text(row.name) || !text(row.source) || !integer(row.amountCents) || row.amountCents <= 0 || !['expense', 'income'].includes(row.kind)
      || !['uncontracted_work', 'overhead', 'payroll', 'tax', 'other'].includes(row.category) || !['confirmed', 'expected', 'tentative'].includes(row.certainty)) return 'Плановой сумме нужны название, категория, направление, сумма и основание.';
    if (row.accountId && !accounts.has(row.accountId) || row.budgetLineId && !budgetLines.has(row.budgetLineId)) return 'Связанный счёт или статья плановой суммы не найдены.';
    if (row.date && !date(row.date) || row.dateRule && !ruleValid(row.dateRule)) return 'Проверьте дату или правило плановой суммы.';
    if (scenario && row.coverage?.length) return 'Дополнительные суммы сценария не должны повторно распределять действующие обязательства.';
    return scenario ? '' : validateCoverage(row, row.amountCents);
  };
  for (const row of treasury.cashPlans ?? []) { const error = validateCashPlan(row); if (error) return error; }
  for (const row of treasury.delayRates ?? []) {
    if (!text(row.name) || !text(row.source) || !['overhead', 'interest', 'other'].includes(row.category) || !date(row.baselineEnd) || !nonnegative(row.dailyCents)
      || !['calendar', 'workdays'].includes(row.calendar) || !integer(row.paymentOffsetDays) || row.paymentOffsetDays < 0 || row.paymentOffsetDays > 3650) return 'Для стоимости задержки нужны основание, исходный срок, ставка, календарь и срок расчёта.';
    if (!['additional', 'included_in_estimate'].includes(row.costTreatment) || !nonnegative(row.recognizedCents)) return 'Укажите, включена ли стоимость задержки в оценку, и признанную часть затрат.';
    if (row.endDate && !date(row.endDate) || row.endRule && !ruleValid(row.endRule) || row.accountId && !accounts.has(row.accountId)) return 'Проверьте окончание и счёт стоимости задержки.';
    const error = validateCoverage(row, null); if (error) return error;
  }
  const immutable = ['inventoryLots', 'inventoryMovements', 'budgetVersions', 'savedScenarios'];
  for (const key of immutable) for (const [index, row] of (old[key] ?? []).entries()) if (stable((treasury[key] ?? [])[index]) !== stable(row)) return 'Учтённые материалы, движения и сохранённые версии не переписываются. Добавьте новую запись или сторно.';
  const lots = new Map();
  for (const row of treasury.inventoryLots ?? []) {
    const estimate = costs.get(row.costEstimateId);
    if (!text(row.name) || !text(row.unit) || !text(row.source) || !estimate || !integer(row.quantityMillis) || row.quantityMillis <= 0 || !nonnegative(row.totalCostCents) || !date(row.receivedOn) || today && row.receivedOn > today) return 'Приходу материалов нужны оценка затрат, количество, стоимость, фактическая дата и основание.';
    if (estimate.stockToConsumeCents !== 0) return 'Для материала из реестра обнулите ручной запас в этой оценке: запас будет рассчитан по партиям.';
    lots.set(row.id, row);
  }
  const movements = new Map(), reversals = new Set(), used = new Map();
  for (const row of treasury.inventoryMovements ?? []) {
    const lot = lots.get(row.lotId);
    if (!lot || !date(row.date) || row.date < lot.receivedOn || today && row.date > today || !text(row.source) || !['consume', 'reverse'].includes(row.kind)) return 'Движение материала требует существующей партии, фактической даты и основания.';
    let quantity = row.quantityMillis;
    if (row.kind === 'reverse') {
      const original = movements.get(row.reversesId);
      if (!original || original.kind !== 'consume' || original.lotId !== row.lotId || reversals.has(original.id) || row.date < original.date || row.quantityMillis !== undefined) return 'Сторно должно ссылаться на ещё не отменённое списание той же партии.';
      reversals.add(original.id); quantity = -original.quantityMillis;
    } else if (!integer(quantity) || quantity <= 0 || row.reversesId !== undefined) return 'Количество списания должно быть положительным, с точностью до тысячной единицы.';
    const nextUsed = (used.get(row.lotId) ?? 0) + quantity;
    if (!nonnegative(nextUsed) || nextUsed > lot.quantityMillis) return 'Количество списанного материала превышает остаток партии.';
    used.set(row.lotId, nextUsed); movements.set(row.id, row);
  }
  const stock = treasuryInventorySummary(treasury); if (!stock.valid || [stock.stockCents, stock.consumedCents].includes(null)) return 'Сумма материалов выходит за точный диапазон расчёта.';
  for (const row of treasury.budgetVersions ?? []) {
    if (!text(row.name) || !text(row.source) || !['gross', 'net', 'not_applicable'].includes(row.taxBasis) || !text(row.taxNote) || !Array.isArray(row.lines) || !row.lines.length || row.lines.length > 5000 || !uniqueRows(row.lines)
      || row.lines.some(line => !text(line.name) || !nonnegative(line.amountCents)) || total(row.lines.map(line => line.amountCents)) === null) return 'Версии бюджета нужны название, источник, база сумм и строки с точными суммами.';
  }
  if (treasury.activeBudgetVersionId && !(treasury.budgetVersions ?? []).some(row => row.id === treasury.activeBudgetVersionId)) return 'Действующая утверждённая версия бюджета не найдена.';
  for (const row of treasury.savedScenarios ?? []) {
    if (!text(row.name) || !text(row.source) || !date(row.asOf) || today && row.asOf > today || !text(row.basisFingerprint) || !nonnegative(row.incomeDelayDays) || row.incomeDelayDays > 365 || !nonnegative(row.workDelayDays) || row.workDelayDays > 365
      || cents(row.tentativeCostIncreasePct) === null || row.tentativeCostIncreasePct < 0 || row.tentativeCostIncreasePct > 1000 || !Array.isArray(row.extraCashPlans) || row.extraCashPlans.length > 5000 || !uniqueRows(row.extraCashPlans)) return 'Сценарию нужны название, дата, основание и корректные допущения.';
    for (const plan of row.extraCashPlans) { const error = validateCashPlan(plan, true); if (error) return error; }
  }
  if (now) for (const key of immutable) for (const row of treasury[key] ?? []) if (!(old[key] ?? []).some(item => item.id === row.id)) {
    if (key === 'budgetVersions') { row.approvedAt = now; row.approvedBy = identity.name || identity.id || 'Управление'; }
    else { row.recordedAt = now; row.recordedBy = identity.name || identity.id || 'Управление'; }
  }
  return '';
}
