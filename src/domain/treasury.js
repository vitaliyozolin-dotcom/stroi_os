// Pure, shared Node/browser projections. This module never creates a payment.
import { forecastSchedule, confirmedSiteUpdate } from './construction/schedule-forecast.js';
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const text = value => typeof value === 'string' && value.trim().length > 0;
const integer = value => Number.isSafeInteger(value);
const nonnegative = value => integer(value) && value >= 0;
const sum = values => {
  let result = 0;
  for (const value of values) { if (!integer(value) || !integer(result + value)) return null; result += value; }
  return result;
};
const datePart = value => {
  if (validTreasuryDate(value)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(value));
};
const tomorrow = date => shift(date, 1);
const unique = values => [...new Set(values)];
const fields = ['version', 'enabled', 'accounts', 'entryPlans', 'costEstimates', 'reserveCents', 'scenarios', 'cashScopeReview'];
const stable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export const emptyTreasury = () => ({ version: 1, enabled: false, accounts: [], entryPlans: [], costEstimates: [] });
export function treasuryScopeFingerprint(state) {
  const input = stable({ projectId: state.project.id, financeEntries: state.financeEntries ?? [], budgetLines: state.budgetLines ?? [],
    costEstimates: state.treasury?.costEstimates ?? [], entryPlans: state.treasury?.entryPlans ?? [] });
  // FNV-1a 64-bit is sufficient for deterministic change detection, not cryptographic evidence.
  let hash = 14695981039346656037n;
  for (let index = 0; index < input.length; index++) hash = BigInt.asUintN(64, (hash ^ BigInt(input.charCodeAt(index))) * 1099511628211n);
  return `scope-v1:${hash.toString(16).padStart(16, '0')}:${input.length}`;
}
export const treasuryMoneyToCents = value => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return integer(cents) && Math.abs(value * 100 - cents) < 0.00001 ? cents : null;
};
export const validTreasuryDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
function shift(date, days, calendar = 'calendar') {
  if (!validTreasuryDate(date) || !integer(days) || Math.abs(days) > 3650) return null;
  const value = new Date(`${date}T12:00:00Z`), sign = Math.sign(days);
  for (let left = Math.abs(days); left > 0;) {
    value.setUTCDate(value.getUTCDate() + sign);
    if (calendar !== 'workdays' || ![0, 6].includes(value.getUTCDay())) left--;
  }
  return value.toISOString().slice(0, 10);
}
const ruleTitles = { stage_start: 'Начало этапа', stage_end: 'Окончание этапа', stage_acceptance: 'Приёмка этапа', task_start: 'Начало задачи', task_end: 'Окончание задачи' };
const dayDifference = (after, before) => validTreasuryDate(after) && validTreasuryDate(before)
  ? Math.round((Date.parse(`${after}T12:00:00Z`) - Date.parse(`${before}T12:00:00Z`)) / 86400000) : null;
function scheduleIssues(state, schedule, stageId) {
  const included = new Set();
  const visit = id => {
    if (included.has(id)) return;
    included.add(id);
    const value = (state.stages ?? []).find(stage => stage.id === id)?.schedule;
    for (const dependency of value?.dependencies ?? []) visit(dependency.stageId);
    for (const child of value?.summaryOf ?? []) visit(child);
  };
  visit(stageId);
  return (schedule?.issues ?? []).filter(issue => included.has(issue.stageId));
}
function resolveRuleDetails(state, rule, today, schedule) {
  const stage = (state.stages ?? []).find(item => item.id === rule.stageId);
  const task = (state.tasks ?? []).find(item => item.id === rule.taskId);
  const taskRule = ['task_start', 'task_end'].includes(rule.kind), target = taskRule ? task : stage;
  const name = taskRule ? task?.title : stage?.shortName || stage?.name;
  const suffix = rule.offsetDays ? ` ${rule.offsetDays > 0 ? '+' : '−'} ${Math.abs(rule.offsetDays)} ${rule.calendar === 'workdays' ? 'будн. дн.' : 'календ. дн.'}` : '';
  const detail = { date: null, anchorDate: null, basis: 'unknown', label: `${ruleTitles[rule.kind] ?? 'Неизвестное правило'}${name ? ` «${name}»` : ''}${suffix}`,
    reason: null, offsetDays: rule.offsetDays, calendar: rule.calendar,
    ...(taskRule ? { taskId: rule.taskId, ...(task?.stageId ? { linkedStageId: task.stageId } : {}) } : { stageId: rule.stageId }) };
  const unknown = reason => ({ ...detail, reason });
  const resolved = (anchorDate, basis, reason = null) => {
    const date = shift(anchorDate, rule.offsetDays, rule.calendar);
    return date ? { ...detail, date, anchorDate, basis, reason } : unknown('Дата или смещение платежа некорректны.');
  };
  if (!target) return unknown(taskRule ? 'Связанная задача не найдена.' : 'Связанный этап не найден.');
  if (!own(ruleTitles, rule.kind) || !integer(rule.offsetDays) || Math.abs(rule.offsetDays) > 3650 || !['calendar', 'workdays'].includes(rule.calendar)) return unknown('Правило даты некорректно.');
  const actual = value => { const day = datePart(value); return day && (!today || day <= today) ? day : null; };
  if (taskRule) {
    if (task.status === 'canceled') return unknown('Задача отменена; выберите действующее основание платежа.');
    if (rule.kind === 'task_end' && (!task.status || task.status === 'done')) {
      const completed = actual(task.completedAt);
      if (completed) return resolved(completed, 'actual');
      if (task.status === 'done' || task.completedAt) return unknown('Выполнение задачи отмечено, но подтверждённая фактическая дата неизвестна или указана в будущем.');
    }
    const anchor = datePart(rule.kind === 'task_start' ? task.plannedStart : task.dueDate);
    if (!anchor) return unknown(rule.kind === 'task_start' ? 'У задачи не задана плановая дата начала.' : 'У задачи не задан срок выполнения.');
    const reasons = [];
    if (today && anchor <= today) reasons.push('Записанный срок задачи уже наступил; фактическое событие не подтверждено, дату нужно уточнить.');
    if (task.stageId) {
      const linked = (state.stages ?? []).find(item => item.id === task.stageId);
      const linkedRow = schedule?.rows.find(row => row.id === task.stageId);
      if (!linked) reasons.push('Связанный с задачей этап не найден.');
      else if (linked.schedule && (!linkedRow || scheduleIssues(state, schedule, linked.id).length)) reasons.push('Прогноз связанного этапа требует сверки.');
      else if (linkedRow?.start && anchor < linkedRow.start) reasons.push('Срок задачи раньше прогнозного начала связанного этапа; согласуйте даты.');
      // A task's stageId is a grouping link, not an invented time dependency.
      detail.label += ' (срок задачи задан отдельно)';
    }
    return resolved(anchor, 'recorded_plan', reasons.join(' ') || null);
  }
  const closed = !stage.status || ['accepted', 'awaiting_inspection'].includes(stage.status);
  const factValue = rule.kind === 'stage_start' ? stage.actualStart
    : rule.kind === 'stage_end' && closed ? stage.completedOn || stage.actualEnd
      : rule.kind === 'stage_acceptance' && (!stage.status || stage.status === 'accepted') ? stage.acceptedAt : null;
  if (factValue) {
    const fact = actual(factValue);
    if (!fact) return unknown('Фактическая дата этапа некорректна или находится после даты среза.');
    if (rule.kind === 'stage_acceptance') {
      const end = actual(stage.completedOn || stage.actualEnd);
      if (end && fact < end) return unknown('Фактическая приёмка указана раньше выполнения этапа.');
    }
    return resolved(fact, 'actual');
  }
  if (rule.kind === 'stage_end' && ['accepted', 'awaiting_inspection'].includes(stage.status)) return unknown('Выполнение этапа отмечено, но его фактическая дата неизвестна.');
  if (rule.kind === 'stage_acceptance' && stage.status === 'accepted') return unknown('Приёмка этапа отмечена, но её фактическая дата неизвестна.');
  const derived = schedule?.rows.find(row => row.id === stage.id), issues = scheduleIssues(state, schedule, stage.id);
  if (today && stage.schedule && (!derived || issues.length)) return unknown(issues.map(issue => issue.message).join('. ') || 'Прогноз связанного этапа не рассчитан.');
  if (rule.kind === 'stage_acceptance') {
    const acceptance = datePart(stage.siteUpdate?.acceptanceOn);
    if (!today || !stage.schedule || !derived || !confirmedSiteUpdate(stage, today)) return unknown('Для прогнозной приёмки нужна актуальная подтверждённая сверка ППР.');
    if (!acceptance || acceptance < today || acceptance < derived.end) return unknown('Уточните ожидаемую приёмку: дата должна быть не раньше выполнения этапа и даты среза.');
    return resolved(acceptance, 'forecast');
  }
  if (today && stage.schedule) {
    if (rule.kind === 'stage_start' && derived.source === 'fact') return unknown('Этап выполнен, но фактическая дата начала неизвестна.');
    return resolved(rule.kind === 'stage_start' ? derived.start : derived.end, derived.source === 'fact' ? 'actual' : 'forecast');
  }
  const recorded = rule.kind === 'stage_start' ? datePart(stage.siteUpdate?.readyOn) ?? datePart(stage.planStart) : datePart(stage.forecastEnd);
  return recorded ? resolved(recorded, 'recorded_plan', 'Используется записанная дата этапа; зависимости и актуальность ППР не подтверждены.')
    : unknown(rule.kind === 'stage_start' ? 'У этапа не задана дата начала.' : 'У этапа не задана дата окончания.');
}
export function resolveTreasuryDateRuleDetails(state, rule, today) {
  const schedule = today && (state.stages ?? []).some(stage => stage.schedule) ? forecastSchedule(state, today) : null;
  return resolveRuleDetails(state, rule, today, schedule);
}
export function resolveTreasuryDateRule(state, rule, today) {
  return resolveTreasuryDateRuleDetails(state, rule, today).date;
}
const recordedPaid = entry => treasuryMoneyToCents(entry.paidAmount ?? (entry.status === 'paid' ? entry.amount : 0));
export function treasuryPaymentReferences(entry) {
  const payments = (entry.payments ?? []).flatMap(payment => {
    const amountCents = treasuryMoneyToCents(payment.amount);
    return amountCents !== null && amountCents > 0 ? [{ id: payment.id, amountCents, date: datePart(payment.date), legacy: false }] : [];
  });
  const aggregate = recordedPaid(entry), detailed = sum(payments.map(payment => payment.amountCents));
  if (aggregate === null || detailed === null || aggregate <= detailed) return payments;
  // The date of the last partial payment cannot be assigned to the previous aggregate.
  return [{ id: `legacy:${entry.id}`, amountCents: aggregate - detailed,
    date: payments.length ? null : datePart(entry.paidAt), legacy: true }, ...payments];
}
function percentAmount(cents, percent) {
  const basisPoints = Math.round(percent * 100);
  const result = (BigInt(cents) * BigInt(10000 + basisPoints) + 5000n) / 10000n;
  const number = Number(result);
  return integer(number) ? number : null;
}

export function treasuryCostSummary(state) {
  const rows = state.treasury?.costEstimates ?? [], warnings = [];
  const invalid = rows.some(row => ['recognizedCents', 'remainingWorkCents', 'stockToConsumeCents', 'otherRemainingCents', 'approvedBudgetCents'].some(key => !nonnegative(row[key])));
  const ids = rows.map(row => row.budgetLineId).filter(Boolean);
  const uncovered = (state.budgetLines ?? []).filter(line => !ids.includes(line.id));
  if (!rows.length) warnings.push('Оценка признанной и оставшейся себестоимости не заполнена.');
  if (uncovered.length) warnings.push(`Без оценки достройки: ${uncovered.length} статей бюджета.`);
  if (invalid) warnings.push('Некорректные суммы в оценке себестоимости.');
  const recognizedCents = invalid || !rows.length ? null : sum(rows.map(row => row.recognizedCents));
  const etcCents = invalid || !rows.length ? null : sum(rows.flatMap(row => [row.remainingWorkCents, row.stockToConsumeCents, row.otherRemainingCents]));
  const budgetCents = invalid || !rows.length ? null : sum(rows.map(row => row.approvedBudgetCents));
  const eacCents = recognizedCents === null || etcCents === null ? null : sum([recognizedCents, etcCents]);
  if (rows.length && [recognizedCents, etcCents, budgetCents, eacCents].includes(null)) warnings.push('Итог себестоимости отсутствует или выходит за точный диапазон расчёта.');
  return { recognizedCents, etcCents, eacCents, budgetCents, varianceCents: eacCents === null || budgetCents === null ? null : eacCents - budgetCents,
    complete: rows.length > 0 && !warnings.length, warnings };
}

/** today is an end-of-day cutoff. Forecast days begin on the following day. */
export function treasuryProjection(state, { today, horizonDays = 91, scenario = 'base', accountId } = {}) {
  if (!validTreasuryDate(today)) throw new Error('Укажите корректную дату среза.');
  if (!integer(horizonDays) || horizonDays < 1 || horizonDays > 1095) throw new Error('Горизонт: от 1 до 1095 дней.');
  if (!['base', 'cautious', 'stress'].includes(scenario)) throw new Error('Неизвестный сценарий.');
  const treasury = state.treasury ?? emptyTreasury(), warnings = [], events = [];
  const accounts = treasury.accounts.filter(account => !accountId || account.id === accountId);
  const accountMap = new Map(treasury.accounts.map(account => [account.id, account]));
  const plans = new Map(treasury.entryPlans.map(plan => [plan.entryId, plan]));
  const schedule = (state.stages ?? []).some(stage => stage.schedule) ? forecastSchedule(state, today) : null;
  const facts = [];
  let unallocatedSettlementCents = 0, openingKnown = accounts.length > 0 && treasury.enabled === true;
  const accountBalances = new Map();
  if (!treasury.enabled) warnings.push('Финансовое планирование для проекта не включено.');
  if (!accounts.length) warnings.push('Не заданы счета с начальным остатком.');
  for (const account of accounts) {
    const opening = account.opening;
    if (!opening?.confirmed || !validTreasuryDate(opening.asOf) || opening.asOf > today || !integer(opening.amountCents)) {
      openingKnown = false; warnings.push(`${account.name}: нет подтверждённого остатка на дату среза.`); continue;
    }
    if (own(account, 'restrictedCents') && !nonnegative(account.restrictedCents)) {
      openingKnown = false; warnings.push(`${account.name}: ограниченная сумма не определена.`); continue;
    }
    const restricted = account.restrictedCents ?? 0;
    const balance = account.isProjectDedicated ? opening.amountCents - restricted : account.projectAllocationCents;
    if (!integer(balance)) { openingKnown = false; warnings.push(`${account.name}: средства общего счёта не распределены на проект.`); }
    else accountBalances.set(account.id, balance);
  }
  const configuration = treasury.scenarios;
  if (scenario !== 'base' && !configuration) warnings.push('Параметры сценария не заданы; изменения поступлений и цен не применены.');
  const delay = scenario === 'cautious' ? configuration?.cautiousDelayDays ?? 0 : scenario === 'stress' ? configuration?.stressDelayDays ?? 0 : 0;
  const costIncrease = scenario === 'stress' ? configuration?.stressCostIncreasePct ?? 0 : 0;
  const review = treasury.cashScopeReview;
  const reviewAge = validTreasuryDate(review?.asOf) ? (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${review.asOf}T12:00:00Z`)) / 86400000 : null;
  if (!review || !text(review.source) || review.fingerprint !== treasuryScopeFingerprint(state) || reviewAge === null || reviewAge < 0 || reviewAge > 7) {
    warnings.push('Полнота будущих поступлений и расходов не подтверждена для текущих данных; требуется сверка состава денежных событий.');
  }
  if (!treasuryCostSummary(state).complete) warnings.push('Не завершена оценка всей оставшейся себестоимости; календарь не доказывает достаточность денег на достройку.');
  // Uncontracted forecast costs need their own documented expected cash events.
  // Never add ETC to payable cash automatically: that would repay stocked goods/advances.
  for (const line of state.budgetLines ?? []) {
    const estimate = treasury.costEstimates.find(row => row.budgetLineId === line.id);
    const estimated = estimate ? sum([estimate.recognizedCents, estimate.remainingWorkCents, estimate.stockToConsumeCents, estimate.otherRemainingCents])
      : treasuryMoneyToCents(line.forecast === undefined ? line.plan : line.forecast);
    const committed = sum((state.financeEntries ?? []).filter(entry => entry.kind === 'expense' && entry.budgetLineId === line.id).map(entry => treasuryMoneyToCents(entry.amount)));
    if (estimated === null || committed === null) warnings.push(`${line.name ?? line.id}: покрытие оценки затрат денежным планом не установлено.`);
    else if (estimated > committed) warnings.push(`${line.name ?? line.id}: ${((estimated - committed) / 100).toLocaleString('ru-RU')} ₽ оценки затрат не связаны с денежными событиями; прогноз достройки неполон.`);
  }
  const addEvent = (entry, plan, tranche, amountCents, suffix) => {
    if (amountCents <= 0) return;
    const contractualDueDate = validTreasuryDate(tranche?.contractualDueDate) ? tranche.contractualDueDate : null;
    const fixedDate = validTreasuryDate(tranche?.forecastDate) ? tranche.forecastDate
      : contractualDueDate ?? (validTreasuryDate(entry.dueDate) ? entry.dueDate : null);
    const dateResolution = tranche?.dateRule ? resolveRuleDetails(state, tranche.dateRule, today, schedule) : {
      date: fixedDate, anchorDate: fixedDate, basis: fixedDate ? 'fixed' : 'unknown',
      label: validTreasuryDate(tranche?.forecastDate) ? 'Фиксированная дата прогноза' : contractualDueDate ? 'Договорный срок' : 'Плановая дата обязательства',
      reason: fixedDate ? null : 'Дата денежного события не задана.', offsetDays: 0, calendar: 'calendar' };
    let date = dateResolution.date;
    // Keep the original planned/derived date even when cash projection rolls overdue debt forward.
    const scheduledDate = date;
    const certainty = tranche?.certainty ?? 'expected';
    if (dateResolution.reason) warnings.push(`${entry.description}: ${dateResolution.reason}`);
    const sourceAccountId = plan?.cashTreatment === 'unassigned' ? null : tranche?.sourceAccountId ?? plan?.sourceAccountId ?? null;
    const outside = plan?.cashTreatment === 'participant_direct';
    if (accountId && sourceAccountId && accountId !== sourceAccountId) return;
    const overdue = Boolean(contractualDueDate && contractualDueDate <= today || !contractualDueDate && date && date <= today);
    const contractOverdue = Boolean(contractualDueDate && contractualDueDate <= today);
    const contractDifference = dayDifference(scheduledDate, contractualDueDate);
    const scheduledDelayDays = contractDifference === null ? null : Math.max(0, contractDifference);
    if (date && date <= today) date = tomorrow(today); // Preserve original deadline; overdue remains explicit.
    if (date && entry.kind === 'income' && delay) date = shift(date, delay);
    const forecastDifference = dayDifference(date, contractualDueDate);
    const forecastDelayDays = forecastDifference === null ? null : Math.max(0, forecastDifference);
    const excluded = outside || entry.kind === 'income' && certainty === 'tentative' && scenario !== 'base';
    // Contracted obligations do not increase in value just because a scenario changed.
    const amount = entry.kind === 'expense' && certainty === 'tentative' && costIncrease ? percentAmount(amountCents, costIncrease) : amountCents;
    if (amount === null) { warnings.push(`${entry.description}: сумма сценария выходит за точный диапазон.`); return; }
    events.push({ id: `${entry.id}:${suffix}`, entryId: entry.id, description: entry.description, kind: entry.kind,
      amountCents: amount, date, scheduledDate, contractualDueDate, accountId: sourceAccountId, trancheId: tranche?.id,
      certainty, overdue, contractOverdue, forecastDelayDays, scheduledDelayDays, dateResolution,
      source: tranche?.source ?? plan?.source ?? 'Существующее обязательство', ...(excluded ? { excluded: true } : {}) });
    if (outside) warnings.push(`${entry.description}: будущая прямая оплата участником показана отдельно от счетов компании.`);
  };
  for (const entry of state.financeEntries ?? []) {
    const amount = treasuryMoneyToCents(entry.amount), paid = recordedPaid(entry), plan = plans.get(entry.id);
    if (amount === null || paid === null || amount < 0 || paid < 0) { warnings.push(`${entry.description}: некорректная исходная сумма.`); openingKnown = false; continue; }
    const references = treasuryPaymentReferences(entry), refMap = new Map(references.map(payment => [payment.id, payment]));
    const factMap = new Map((plan?.paymentFacts ?? []).map(fact => [fact.paymentId, fact]));
    const claimed = sum(references.filter(payment => factMap.get(payment.id)?.confirmation === 'claimed').map(payment => payment.amountCents)) ?? 0;
    for (const reference of references) {
      facts.push({ entry, reference, fact: factMap.get(reference.id) });
      if (reference.date && reference.date > today) warnings.push(`${entry.description}: записанный факт датирован после среза; прогноз требует сверки.`);
    }
    if (sum(references.map(reference => reference.amountCents)) !== paid) warnings.push(`${entry.description}: накопленная оплата и события платежей не сходятся.`);
    const settled = Math.max(0, paid - claimed), remaining = Math.max(0, amount - settled);
    if (paid > amount) warnings.push(`${entry.description}: есть переплата; она не потеряна и не считается отрицательным расходом.`);
    if (!remaining) continue;
    if (!plan?.tranches?.length) { addEvent(entry, plan, null, remaining, 'remaining'); continue; }
    let allocated = 0;
    const pending = [];
    for (const tranche of plan.tranches) {
      const applied = sum((tranche.paymentAllocations ?? []).map(allocation => factMap.get(allocation.paymentId)?.confirmation === 'claimed' || !refMap.has(allocation.paymentId) ? 0 : allocation.amountCents)) ?? 0;
      allocated += applied;
      pending.push({ tranche, amount: Math.max(0, tranche.amountCents - applied) });
    }
    if (settled !== allocated) {
      // Never guess which dated tranche a historical aggregate settled (no implicit FIFO).
      unallocatedSettlementCents += Math.abs(settled - allocated);
      warnings.push(`${entry.description}: распределите ${Math.abs(settled - allocated) / 100} ₽ записанных оплат по траншам.`);
      addEvent(entry, { ...plan, source: 'Остаток обязательства; распределение прошлых оплат не завершено' }, { certainty: 'expected', source: 'Нужна привязка оплат к траншам' }, remaining, 'unallocated-settlement');
      const last = events.at(-1); if (last?.entryId === entry.id) {
        last.date = null; last.scheduledDate = null; last.forecastDelayDays = null; last.scheduledDelayDays = null;
        last.dateResolution = { ...last.dateResolution, date: null, anchorDate: null, basis: 'unknown', reason: 'Распределите записанные оплаты по траншам; дата оставшейся суммы пока неизвестна.' };
      }
      continue;
    }
    for (const item of pending) addEvent(entry, plan, item.tranche, item.amount, item.tranche.id);
  }
  // Only confirmed, mapped existing payments move an account after its snapshot.
  for (const { entry, reference, fact } of facts) {
    if (fact?.cashTreatment === 'participant_direct') continue;
    const relevant = fact?.accountId ? accounts.filter(account => account.id === fact.accountId) : accounts;
    if (!relevant.length) continue;
    const potential = relevant.some(account => account.opening && account.opening.asOf < today
      && (!reference.date || reference.date > account.opening.asOf) && (!reference.date || reference.date <= today));
    if (!potential) continue;
    if (!fact?.accountId || fact.confirmation === 'claimed' || !reference.date) {
      openingKnown = false; warnings.push(`${entry.description}: движение после начального остатка не сверено по счёту или дате.`); continue;
    }
    const account = accountMap.get(fact.accountId);
    if (!account || !integer(accountBalances.get(account.id)) || reference.date <= account.opening.asOf || reference.date > today) continue;
    const nextBalance = sum([accountBalances.get(account.id), entry.kind === 'income' ? reference.amountCents : -reference.amountCents]);
    accountBalances.set(account.id, nextBalance);
    if (nextBalance === null) { openingKnown = false; warnings.push(`${account.name}: движение выводит остаток за точный диапазон расчёта.`); }
  }
  const calculatedOpening = sum([...accountBalances.values()]);
  if (calculatedOpening === null) { openingKnown = false; warnings.push('Остаток выходит за точный диапазон расчёта.'); }
  const openingCents = openingKnown ? calculatedOpening : null;
  const unallocatedCents = { income: 0, expense: 0 };
  let completeness = openingKnown && !warnings.length;
  for (const event of events) {
    if (event.excluded) continue;
    if (!event.date || !event.accountId || !accountMap.has(event.accountId)) {
      completeness = false;
      unallocatedCents[event.kind] += event.amountCents;
      if (!event.date) warnings.push(`${event.description}: срок не определён; сумма вне календаря.`);
      if (!event.accountId) warnings.push(`${event.description}: не выбран счёт; финансовый прогноз неполон.`);
    }
  }
  if (unallocatedSettlementCents) completeness = false;
  if (scenario !== 'base' && !configuration) completeness = false;
  const reserveKnown = !own(treasury, 'reserveCents') || nonnegative(treasury.reserveCents);
  if (!reserveKnown) { completeness = false; warnings.push('Размер резерва не определён.'); }
  const days = [], reserve = nonnegative(treasury.reserveCents) ? treasury.reserveCents : 0;
  let balance = openingCents, minimum = balance;
  let firstDeficitDate = balance !== null && balance < 0 ? today : null;
  for (let index = 1; index <= horizonDays; index++) {
    const date = shift(today, index);
    const daily = events.filter(event => !event.excluded && event.date === date && (!accountId || event.accountId === accountId));
    const inflowCents = sum(daily.filter(event => event.kind === 'income').map(event => event.amountCents));
    const outflowCents = sum(daily.filter(event => event.kind === 'expense').map(event => event.amountCents));
    if (inflowCents === null || outflowCents === null) throw new Error('Суммы дня выходят за точный диапазон.');
    if (balance !== null) {
      balance = sum([balance, inflowCents, -outflowCents]);
      if (balance === null) { completeness = false; warnings.push('Расчёт остатка выходит за точный диапазон.'); }
      else { minimum = Math.min(minimum, balance); if (balance < 0 && !firstDeficitDate) firstDeficitDate = date; }
    }
    days.push({ date, inflowCents, outflowCents, balanceCents: balance, deficitCents: balance === null ? null : Math.max(0, -balance),
      reserveShortfallCents: balance === null || !reserveKnown ? null : Math.max(0, reserve - balance), events: daily });
  }
  // The total can hide a deficit on an individual account/legal entity. Make that explicit.
  if (!accountId && accounts.length > 1) {
    for (const account of accounts) {
      let amount = accountBalances.get(account.id);
      if (!integer(amount)) continue;
      for (const day of days) {
        const delta = sum(day.events.filter(event => event.accountId === account.id).map(event => event.kind === 'income' ? event.amountCents : -event.amountCents));
        if (delta === null) break;
        amount = sum([amount, delta]);
        if (amount === null) { warnings.push(`${account.name}: отдельный прогноз выходит за точный диапазон расчёта.`); completeness = false; break; }
        if (amount < 0) { warnings.push(`${account.name} (${account.legalEntityId}): отдельный дефицит ${day.date}; сводный плюс его не закрывает.`); completeness = false; break; }
      }
    }
  }
  return { today, scenario, days, events, openingKnown, openingCents, minBalanceCents: minimum, firstDeficitDate,
    peakFundingCents: minimum === null ? null : Math.max(0, -minimum), peakReserveFundingCents: minimum === null || !reserveKnown ? null : Math.max(0, reserve -minimum),
    unallocatedCents, unallocatedSettlementCents, warnings: unique(warnings), completeness };
}

/** Pure preview: a PPR change recalculates expected cash, never edits deadlines or payment facts. */
export function treasuryScheduleImpact(previous, next, { today, horizonDays = 91, accountId } = {}) {
  if (previous.project.id !== next.project.id) throw new Error('Сравнивать изменения ППР можно только внутри одного проекта.');
  const options = { today, horizonDays, accountId, scenario: 'base' };
  const before = treasuryProjection(previous, options), after = treasuryProjection(next, options);
  const oldEvents = new Map(before.events.map(event => [event.id, event]));
  const nextEvents = new Map(after.events.map(event => [event.id, event]));
  const changes = [];
  for (const id of unique([...oldEvents.keys(), ...nextEvents.keys()])) {
    const old = oldEvents.get(id), current = nextEvents.get(id), event = current ?? old;
    // Include changed explanations (e.g. unknown -> fact), even when the date itself is equal.
    if (old && current && old.scheduledDate === current.scheduledDate && old.amountCents === current.amountCents
      && stable(old.dateResolution) === stable(current.dateResolution) && Boolean(old.excluded) === Boolean(current.excluded)) continue;
    const beforeDate = old?.scheduledDate ?? null, afterDate = current?.scheduledDate ?? null;
    const fallback = { date: null, anchorDate: null, basis: 'unknown', label: 'Событие отсутствует', reason: 'Остаток обязательства отсутствует.', offsetDays: 0, calendar: 'calendar' };
    const beforeResolution = old?.dateResolution ?? fallback, afterResolution = current?.dateResolution ?? fallback;
    changes.push({ id, entryId: event.entryId, trancheId: event.trancheId, description: event.description, kind: event.kind,
      amountCents: event.amountCents, beforeDate, afterDate, shiftDays: dayDifference(afterDate, beforeDate),
      contractualDueDate: event.contractualDueDate, beforeResolution, afterResolution,
      reason: afterResolution.reason || afterResolution.label, affectsCash: !event.excluded });
  }
  const dated = projection => projection.openingKnown && projection.unallocatedSettlementCents === 0
    && projection.unallocatedCents.income === 0 && projection.unallocatedCents.expense === 0;
  const comparable = previous.treasury?.enabled === true && next.treasury?.enabled === true && dated(before) && dated(after);
  return { before, after, changes,
    shiftedIncomeCents: sum(changes.filter(change => change.kind === 'income' && change.beforeDate !== change.afterDate).map(change => change.amountCents)),
    shiftedExpenseCents: sum(changes.filter(change => change.kind === 'expense' && change.beforeDate !== change.afterDate).map(change => change.amountCents)),
    peakFundingDeltaCents: comparable && before.peakFundingCents !== null && after.peakFundingCents !== null ? after.peakFundingCents - before.peakFundingCents : null,
    comparable, complete: comparable && before.completeness && after.completeness };
}

export function validateTreasuryChanges(previous, next, identity, now) {
  const old = previous?.treasury, treasury = next?.treasury;
  const treasuryChanged = stable(old) !== stable(treasury);
  const referencesChanged = ['financeEntries', 'budgetLines', 'stages', 'tasks'].some(key => stable(previous?.[key]) !== stable(next?.[key]));
  if (!treasuryChanged && !referencesChanged) return '';
  if (treasuryChanged && identity?.role !== 'management') return 'Финансовое планирование меняет только роль «Управление».';
  if (!treasury) return old ? 'Нельзя удалить финансовый план и его историю.' : '';
  if (treasury.version !== 1 || typeof treasury.enabled !== 'boolean' || !Array.isArray(treasury.accounts) || !Array.isArray(treasury.entryPlans) || !Array.isArray(treasury.costEstimates)) return 'Некорректная структура финансового плана.';
  if ([treasury.accounts, treasury.entryPlans, treasury.costEstimates].some(rows => rows.length > 5000)) return 'Слишком много записей финансового плана.';
  if (stable(treasury.history ?? []) !== stable(old?.history ?? [])) return 'История финансового плана защищена; обновите данные.';
  if (old && treasuryChanged && !text(treasury.changeReason)) return 'Укажите причину изменения финансового плана.';
  if (own(treasury, 'reserveCents') && !nonnegative(treasury.reserveCents)) return 'Резерв должен быть неотрицательной суммой в копейках.';
  const today = now && Number.isFinite(Date.parse(now)) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(now)) : null;
  if (now && !today) return 'Некорректное серверное время.';
  const accountIds = new Set();
  for (const account of treasury.accounts) {
    if (!text(account?.id) || accountIds.has(account.id) || !text(account.name) || !text(account.legalEntityId) || account.currency !== 'RUB') return 'У счёта нужны уникальный ID, название, юрлицо и валюта RUB.';
    accountIds.add(account.id);
    if (own(account, 'restrictedCents') && !nonnegative(account.restrictedCents) || own(account, 'projectAllocationCents') && !nonnegative(account.projectAllocationCents)) return 'Ограниченные и распределённые средства должны быть неотрицательными копейками.';
    if (account.opening) {
      const opening = account.opening;
      if (!validTreasuryDate(opening.asOf) || !integer(opening.amountCents) || typeof opening.confirmed !== 'boolean' || !text(opening.source)) return 'Для начального остатка нужны сумма в копейках, дата конца дня, источник и статус подтверждения.';
      if (today && opening.asOf > today) return 'Начальный остаток не может быть датирован будущим днём.';
      if ((account.restrictedCents ?? 0) > Math.max(0, opening.amountCents)) return 'Ограниченная сумма превышает положительный остаток счёта.';
      if (own(account, 'projectAllocationCents') && account.projectAllocationCents > Math.max(0, opening.amountCents - (account.restrictedCents ?? 0))) return 'Проекту распределено больше доступных средств счёта.';
    } else if (own(account, 'projectAllocationCents')) return 'Для распределения средств сначала задайте начальный остаток.';
  }
  const entries = new Map((next.financeEntries ?? []).map(entry => [entry.id, entry])), entryIds = new Set();
  for (const plan of treasury.entryPlans) {
    const entry = entries.get(plan?.entryId);
    if (!entry || entryIds.has(plan.entryId) || !text(plan.source) || !Array.isArray(plan.tranches)) return 'Финансовый план должен ссылаться на одну существующую операцию и иметь источник.';
    entryIds.add(plan.entryId);
    if (plan.sourceAccountId && !accountIds.has(plan.sourceAccountId)) return 'Счёт финансового плана не найден.';
    if (plan.cashTreatment && !['account', 'participant_direct', 'unassigned'].includes(plan.cashTreatment)) return 'Неизвестный способ финансирования.';
    const references = new Map(treasuryPaymentReferences(entry).map(payment => [payment.id, payment])), factIds = new Set(), allocated = new Map(), trancheIds = new Set();
    if (plan.paymentFacts !== undefined && !Array.isArray(plan.paymentFacts)) return 'Некорректные сведения о платежах.';
    for (const fact of plan.paymentFacts ?? []) {
      if (!references.has(fact.paymentId) || factIds.has(fact.paymentId) || !text(fact.source) || !['account', 'participant_direct'].includes(fact.cashTreatment) || !['claimed', 'confirmed', 'reconciled'].includes(fact.confirmation)) return 'Сверка должна ссылаться на уникальный существующий платёж и источник.';
      if (fact.cashTreatment === 'account' && !accountIds.has(fact.accountId) || fact.cashTreatment === 'participant_direct' && fact.accountId) return 'Для банковского платежа укажите счёт; прямая оплата участником счёт компании не меняет.';
      factIds.add(fact.paymentId);
    }
    for (const tranche of plan.tranches) {
      if (!text(tranche?.id) || trancheIds.has(tranche.id) || !integer(tranche.amountCents) || tranche.amountCents <= 0 || !text(tranche.source) || !['confirmed', 'expected', 'tentative'].includes(tranche.certainty)) return 'Траншу нужны уникальный ID, положительная сумма в копейках, достоверность и источник.';
      trancheIds.add(tranche.id);
      if (tranche.sourceAccountId && !accountIds.has(tranche.sourceAccountId)) return 'Счёт транша не найден.';
      for (const key of ['contractualDueDate', 'forecastDate']) if (own(tranche, key) && tranche[key] !== undefined && !validTreasuryDate(tranche[key])) return 'Укажите корректную дату транша.';
      if (tranche.dateRule) {
        const rule = tranche.dateRule, stageRule = ['stage_start', 'stage_end', 'stage_acceptance'].includes(rule.kind), taskRule = ['task_start', 'task_end'].includes(rule.kind);
        if ((!stageRule && !taskRule) || !integer(rule.offsetDays) || Math.abs(rule.offsetDays) > 3650 || !['calendar', 'workdays'].includes(rule.calendar)
          || stageRule && !(next.stages ?? []).some(stage => stage.id === rule.stageId) || taskRule && !(next.tasks ?? []).some(task => task.id === rule.taskId)) return 'Правило даты должно ссылаться на существующую работу/этап и корректный календарь.';
      }
      if (tranche.paymentAllocations !== undefined && !Array.isArray(tranche.paymentAllocations)) return 'Некорректное распределение платежей.';
      let tranchePaid = 0;
      const localIds = new Set();
      for (const allocation of tranche.paymentAllocations ?? []) {
        const reference = references.get(allocation.paymentId), fact = (plan.paymentFacts ?? []).find(item => item.paymentId === allocation.paymentId);
        if (!reference || localIds.has(allocation.paymentId) || !integer(allocation.amountCents) || allocation.amountCents <= 0 || fact?.confirmation === 'claimed') return 'Распределить можно подтверждённую записанную оплату; дубли и нулевые суммы запрещены.';
        localIds.add(allocation.paymentId); tranchePaid += allocation.amountCents;
        allocated.set(allocation.paymentId, (allocated.get(allocation.paymentId) ?? 0) + allocation.amountCents);
        if (allocated.get(allocation.paymentId) > reference.amountCents) return 'Распределение превышает сумму существующего платежа.';
      }
      if (tranchePaid > tranche.amountCents) return 'На транш распределено больше его суммы.';
    }
    if (plan.tranches.length && sum(plan.tranches.map(tranche => tranche.amountCents)) !== treasuryMoneyToCents(entry.amount)) return 'Сумма траншей должна совпадать с суммой обязательства, включая уже оплаченные части.';
  }
  const costIds = new Set(), lineIds = new Set();
  for (const row of treasury.costEstimates) {
    if (!text(row?.id) || costIds.has(row.id) || !text(row.name) || !text(row.source)) return 'Оценке себестоимости нужны уникальный ID, название и источник.';
    costIds.add(row.id);
    if (['recognizedCents', 'remainingWorkCents', 'stockToConsumeCents', 'otherRemainingCents', 'approvedBudgetCents'].some(key => !nonnegative(row[key]))) return 'Все части себестоимости должны быть неотрицательными суммами в копейках.';
    if (row.budgetLineId && (lineIds.has(row.budgetLineId) || !(next.budgetLines ?? []).some(line => line.id === row.budgetLineId))) return 'Одна статья бюджета может иметь только одну текущую оценку достройки.';
    if (row.budgetLineId) lineIds.add(row.budgetLineId);
  }
  if (own(treasury, 'scenarios') && treasury.scenarios !== undefined && (!treasury.scenarios || typeof treasury.scenarios !== 'object')) return 'Некорректные параметры сценариев.';
  if (treasury.scenarios) {
    const s = treasury.scenarios;
    if (!nonnegative(s.cautiousDelayDays) || !nonnegative(s.stressDelayDays) || s.cautiousDelayDays > 365 || s.stressDelayDays > 365 || s.stressDelayDays < s.cautiousDelayDays
      || typeof s.stressCostIncreasePct !== 'number' || !Number.isFinite(s.stressCostIncreasePct) || s.stressCostIncreasePct < 0 || s.stressCostIncreasePct > 1000 || treasuryMoneyToCents(s.stressCostIncreasePct) === null) return 'Задайте согласованные задержки 0–365 дней и рост затрат 0–1000% с точностью до сотых.';
  }
  if (own(treasury, 'cashScopeReview') && treasury.cashScopeReview !== undefined) {
    const review = treasury.cashScopeReview;
    if (!review || !validTreasuryDate(review.asOf) || !text(review.source) || !text(review.fingerprint)) return 'Для сверки полноты нужны дата, основание и отпечаток состава данных.';
    if (stable(review) !== stable(old?.cashScopeReview)) {
      if (review.fingerprint !== treasuryScopeFingerprint(next)) return 'Состав денежных событий изменился. Повторите сверку полноты.';
      if (today && review.asOf > today) return 'Сверка полноты не может быть датирована будущим днём.';
      if (!treasuryCostSummary(next).complete) return 'Сначала заполните оценку достройки по всем статьям бюджета.';
    }
  }
  const changed = fields.filter(field => stable(old?.[field]) !== stable(treasury[field]));
  if (now && changed.length) {
    treasury.history = [...(old?.history ?? []), { id: `treasury:${next.project.id}:${now}:${(old?.history?.length ?? 0) + 1}`, at: now,
      by: identity.name || identity.id || 'Управление', reason: treasury.changeReason?.trim() || 'Создан финансовый план проекта',
      changes: changed.map(field => ({ field, before: old?.[field] === undefined ? null : structuredClone(old[field]), after: treasury[field] === undefined ? null : structuredClone(treasury[field]) })) }];
  }
  return '';
}
