// Pure journal and settlement arithmetic shared by Node and the browser.
// No imports: finance totals and treasury can both use this module without cycles.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const text = value => typeof value === 'string' && value.trim().length > 0;
const safe = Number.isSafeInteger;
const positive = value => safe(value) && value > 0;
const nonnegative = value => safe(value) && value >= 0;
const stable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a, b) => stable(a) === stable(b);
const cents = value => typeof value === 'number' && Number.isFinite(value) && safe(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < .00001 ? Math.round(value * 100) : null;
const add = (a, b) => safe(a) && safe(b) && safe(a + b) ? a + b : null;
const sum = values => values.reduce((total, value) => add(total, value), 0);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const datePart = value => validDate(value) ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(value)) : null;
const confirmationRank = { claimed: 0, confirmed: 1, reconciled: 2 };
const operationKinds = ['payment', 'receipt', 'supplier_refund', 'customer_refund', 'offset', 'loan_drawdown', 'loan_repayment', 'interest', 'transfer'];
const refundKind = kind => ['supplier_refund', 'customer_refund'].includes(kind);
const paidLegacy = entry => cents(entry.paidAmount ?? (entry.status === 'paid' ? entry.amount : 0));
const operationAllocations = (ledger, operation) => [...(operation.allocations ?? []), ...(ledger.allocationEvents ?? []).filter(event => event.operationId === operation.id).flatMap(event => event.allocations ?? [])];
const allocationKey = allocation => `${allocation.entryId}\0${allocation.trancheId ?? ''}\0${allocation.retentionId ?? ''}`;
const countMap = rows => { const result = new Map(); for (const row of rows) result.set(allocationKey(row), add(result.get(allocationKey(row)) ?? 0, row.amountCents)); return result; };
const mapAdd = (map, key, value) => map.set(key, add(map.get(key) ?? 0, value));
export const emptyFinanceLedger = () => ({ version: 1, operations: [], confirmations: [], allocationEvents: [], requests: [], retentions: [], loans: [] });
export function effectiveLedgerConfirmation(ledger, operation) {
  let result = operation.confirmation;
  for (const event of ledger?.confirmations ?? []) if (event.operationId === operation.id && confirmationRank[event.confirmation] > confirmationRank[result]) result = event.confirmation;
  return result;
}
export function ledgerOperationAllocations(ledger, operation) { return operationAllocations(ledger, operation); }
export function ledgerLegacyPaymentReferences(entry) {
  const references = (entry.payments ?? []).flatMap(payment => { const amountCents = cents(payment.amount); return positive(amountCents) ? [{ id: payment.id, amountCents, date: datePart(payment.date) }] : []; });
  const aggregate = paidLegacy(entry), detailed = sum(references.map(reference => reference.amountCents));
  if (aggregate !== null && detailed !== null && aggregate > detailed) references.unshift({ id: `legacy:${entry.id}`, amountCents: aggregate - detailed, date: cents(entry.legacyPayment?.amount) === aggregate - detailed ? datePart(entry.legacyPayment.lastRecordedDate) : references.length ? null : datePart(entry.paidAt) });
  return references;
}
/** Existing legacy totals remain historical gross facts; an explicit unconfirmed assertion does not settle debt. */
export function ledgerConfirmedLegacyPaidCents(state, entry) {
  const facts = new Map(((state.treasury?.entryPlans ?? []).find(plan => plan.entryId === entry.id)?.paymentFacts ?? []).map(fact => [fact.paymentId, fact.confirmation]));
  const ledger = state.financeLedger;
  for (const operation of ledger?.operations ?? []) if (operation.legacyPayment?.entryId === entry.id) {
    const confirmation = effectiveLedgerConfirmation(ledger, operation);
    if (confirmation !== 'claimed') facts.set(operation.legacyPayment.paymentId, confirmation);
  }
  const claimed = sum(ledgerLegacyPaymentReferences(entry).filter(reference => facts.get(reference.id) === 'claimed').map(reference => reference.amountCents));
  return add(paidLegacy(entry), claimed === null ? null : -claimed);
}
const legacyReference = (state, link) => {
  const entry = (state.financeEntries ?? []).find(row => row.id === link?.entryId);
  return entry ? { entry, reference: ledgerLegacyPaymentReferences(entry).find(row => row.id === link.paymentId) } : null;
};
const confirmedOperations = state => {
  const ledger = state.financeLedger ?? emptyFinanceLedger();
  return ledger.operations.filter(operation => confirmationRank[effectiveLedgerConfirmation(ledger, operation)] > 0);
};
function settlementRows(state, { cashOnly = false, today } = {}) {
  const ledger = state.financeLedger ?? emptyFinanceLedger(), rows = [];
  for (const operation of confirmedOperations(state)) {
    if (operation.legacyPayment || today && operation.date > today || cashOnly && operation.kind === 'offset') continue;
    const sign = refundKind(operation.kind) ? -1 : 1;
    for (const allocation of operationAllocations(ledger, operation)) rows.push({ ...allocation, amountCents: sign * allocation.amountCents, operationId: operation.id, kind: operation.kind });
  }
  return rows;
}
export function ledgerSettledCentsFor(state, entryId) { return sum(settlementRows(state).filter(row => row.entryId === entryId).map(row => row.amountCents)); }
export function ledgerCashSettledCentsFor(state, entryId) { return sum(settlementRows(state, { cashOnly: true }).filter(row => row.entryId === entryId).map(row => row.amountCents)); }
export function ledgerEntryPaidCents(state, entryId) {
  const entry = (state.financeEntries ?? []).find(row => row.id === entryId);
  return entry ? add(ledgerConfirmedLegacyPaidCents(state, entry), ledgerCashSettledCentsFor(state, entryId)) : null;
}
export function ledgerEntryBalance(state, entryId) {
  const entry = (state.financeEntries ?? []).find(row => row.id === entryId);
  if (!entry) return null;
  const committedCents = cents(entry.amount), legacyPaidCents = ledgerConfirmedLegacyPaidCents(state, entry), ledgerSettledCents = ledgerSettledCentsFor(state, entryId);
  const cashSettledCents = add(legacyPaidCents, ledgerCashSettledCentsFor(state, entryId)), settledCents = add(legacyPaidCents, ledgerSettledCents);
  const nonCashSettledCents = sum(settlementRows(state).filter(row => row.entryId === entryId && row.kind === 'offset').map(row => row.amountCents));
  const remainingCents = committedCents === null || settledCents === null ? null : Math.max(0, committedCents - settledCents);
  const heldCents = sum(retentionEffects(state).filter(row => row.entryId === entryId && row.status === 'held').map(row => row.amountCents));
  return { committedCents, legacyPaidCents, ledgerSettledCents, cashSettledCents, nonCashSettledCents, settledCents, remainingCents, heldCents,
    payableCents: remainingCents === null || heldCents === null ? null : Math.max(0, remainingCents - heldCents),
    overpaidCents: committedCents === null || settledCents === null ? null : Math.max(0, settledCents - committedCents) };
}
function retentionEffects(state, today) {
  const settlements = settlementRows(state, { today });
  return (state.financeLedger?.retentions ?? []).filter(retention => retention.status !== 'canceled').map(retention => ({
    id: retention.id, entryId: retention.entryId, ...(retention.trancheId ? { trancheId: retention.trancheId } : {}),
    amountCents: Math.max(0, retention.amountCents - sum(settlements.filter(row => row.retentionId === retention.id).map(row => row.amountCents))),
    releaseDate: retention.releaseDate ?? null, status: retention.status, source: retention.source,
  }));
}
/** Events are explicit classifications: financing and transfers are never operating revenue/cost. */
export function ledgerEffect(state, { today } = {}) {
  if (today !== undefined && !validDate(today)) throw new Error('Некорректная дата среза журнала.');
  const ledger = state.financeLedger ?? emptyFinanceLedger(), settlements = settlementRows(state, { today });
  const entryMap = new Map(), trancheMap = new Map(), cashMovements = [], futureEvents = [], legacyFacts = [], warnings = [];
  for (const row of settlements) {
    mapAdd(entryMap, row.entryId, row.amountCents);
    if (row.trancheId) { const key = `${row.entryId}\0${row.trancheId}`; mapAdd(trancheMap, key, row.amountCents); }
  }
  for (const operation of ledger.operations) {
    const confirmation = effectiveLedgerConfirmation(ledger, operation);
    if (confirmation === 'claimed') { warnings.push(`Операция «${operation.description}» заявлена, но не подтверждена.`); continue; }
    if (operation.legacyPayment) {
      legacyFacts.push({ ...operation.legacyPayment, accountId: operation.accountId ?? null, cashTreatment: operation.cashTreatment ?? 'account', confirmation, source: operation.source });
      continue;
    }
    const allocations = operationAllocations(ledger, operation);
    const allocated = sum(allocations.filter(row => operation.kind !== 'offset' || (state.financeEntries ?? []).find(entry => entry.id === row.entryId)?.kind === 'expense').map(row => row.amountCents));
    if (['payment', 'receipt', 'supplier_refund', 'customer_refund'].includes(operation.kind) && allocated < operation.amountCents) warnings.push(`Операция «${operation.description}»: ${((operation.amountCents - allocated) / 100).toLocaleString('ru-RU')} ₽ не распределено по обязательствам.`);
    if (operation.kind === 'offset' || operation.cashTreatment === 'participant_direct') continue;
    let direction = ['receipt', 'supplier_refund'].includes(operation.kind) ? 'in' : 'out';
    const loan = ledger.loans.find(item => item.id === operation.loanId);
    if (operation.kind === 'loan_drawdown') direction = loan?.direction === 'lent' ? 'out' : 'in';
    if (operation.kind === 'loan_repayment' || operation.kind === 'interest') direction = loan?.direction === 'lent' ? 'in' : 'out';
    cashMovements.push({ id: `ledger:${operation.id}`, date: operation.date, accountId: operation.accountId ?? null,
      inflowCents: direction === 'in' ? operation.amountCents : 0, outflowCents: direction === 'out' ? operation.amountCents : 0,
      kind: operation.kind, sourceOperationId: operation.id });
    if (operation.kind === 'transfer') cashMovements.push({ id: `ledger:${operation.id}:destination`, date: operation.date, accountId: operation.toAccountId,
      inflowCents: operation.amountCents, outflowCents: 0, kind: 'transfer', sourceOperationId: operation.id });
    if (today && operation.date > today) warnings.push(`Операция «${operation.description}» датирована после среза; проверьте факт.`);
  }
  const loanBalances = [];
  for (const loan of ledger.loans) {
    const actual = confirmedOperations(state).filter(operation => operation.loanId === loan.id && (!today || operation.date <= today));
    const principal = sum([loan.openingPrincipalCents ?? 0, ...actual.filter(row => row.kind === 'loan_drawdown').map(row => row.amountCents), ...actual.filter(row => row.kind === 'loan_repayment').map(row => -row.amountCents)]);
    loanBalances.push({ loanId: loan.id, principalCents: principal, direction: loan.direction });
    if (loan.status !== 'active') continue;
    for (const item of loan.schedule) {
      if (item.kind === 'interest' && item.entryId) continue; // Existing obligation is the sole future cash source.
      const settled = sum(actual.filter(operation => operation.scheduleItemId === item.id).map(operation => operation.amountCents));
      const remaining = Math.max(0, item.amountCents - settled);
      if (!remaining) continue;
      const direction = item.kind === 'drawdown' ? loan.direction === 'borrowed' ? 'in' : 'out' : loan.direction === 'borrowed' ? 'out' : 'in';
      futureEvents.push({ id: `loan:${loan.id}:${item.id}`, date: item.date, accountId: loan.accountId, amountCents: remaining, direction,
        kind: item.kind === 'drawdown' ? 'loan_drawdown' : item.kind === 'principal' ? 'loan_repayment' : 'interest',
        description: `${loan.name}: ${item.kind === 'drawdown' ? 'выдача' : item.kind === 'principal' ? 'возврат тела' : 'проценты'}`, source: loan.source,
        sourceType: 'loan', sourceId: loan.id, scheduleItemId: item.id });
    }
    if (actual.some(operation => !operation.scheduleItemId)) warnings.push(`${loan.name}: фактические операции без строки графика требуют сверки; график автоматически не погашается.`);
  }
  const overflow = [...entryMap.values(), ...trancheMap.values(), ...loanBalances.map(row => row.principalCents)].includes(null);
  if (overflow) warnings.push('Суммы журнала выходят за точный диапазон расчёта.');
  return { settlementsByEntry: [...entryMap].map(([entryId, amountCents]) => ({ entryId, amountCents })),
    settlementsByTranche: [...trancheMap].map(([key, amountCents]) => { const [entryId, trancheId] = key.split('\0'); return { entryId, trancheId, amountCents }; }),
    cashMovements, futureEvents, legacyFacts, retentionPlans: retentionEffects(state, today), loanBalances, warnings };
}

const immutablePrefix = (oldRows, rows) => Array.isArray(rows) && rows.length >= (oldRows ?? []).length && (oldRows ?? []).every((row, index) => same(row, rows[index]));
const collectionNames = ['operations', 'confirmations', 'requests', 'retentions', 'loans'];
const fields = [...collectionNames, 'allocationEvents'];
const sameWithout = (a, b, omitted) => same(Object.fromEntries(Object.entries(a).filter(([key]) => !omitted.includes(key))), Object.fromEntries(Object.entries(b).filter(([key]) => !omitted.includes(key))));
const transitions = { draft: ['draft', 'submitted', 'canceled'], submitted: ['submitted', 'approved', 'rejected', 'canceled'], approved: ['approved', 'scheduled', 'canceled'], scheduled: ['scheduled', 'executing', 'partially_paid', 'paid', 'canceled'], executing: ['executing', 'partially_paid', 'paid', 'canceled'], partially_paid: ['partially_paid', 'paid', 'canceled'], paid: ['paid'], rejected: ['rejected', 'draft', 'canceled'], canceled: ['canceled'] };
/** Cheap boundary guard before read projections; semantic checks and server stamps follow later. */
export function validateFinanceLedgerShape(ledger) {
  if (ledger === undefined) return '';
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const rows = (value, maximum = 10000) => Array.isArray(value) && value.length <= maximum && value.every(record);
  if (!record(ledger) || ledger.version !== 1 || collectionNames.some(key => !rows(ledger[key]))
    || ledger.allocationEvents !== undefined && !rows(ledger.allocationEvents)
    || ledger.history !== undefined && !rows(ledger.history)) return 'Некорректная структура финансового журнала.';
  if (ledger.operations.some(operation => !rows(operation.allocations)
    || operation.legacyPayment !== undefined && !record(operation.legacyPayment)
    || operation.refundOfLegacyPayment !== undefined && !record(operation.refundOfLegacyPayment))
    || (ledger.allocationEvents ?? []).some(event => !rows(event.allocations))
    || ledger.loans.some(loan => !rows(loan.schedule, 1000))
    || ledger.requests.some(request => request.paymentAllocations !== undefined && !rows(request.paymentAllocations, 1000))) return 'Некорректная структура распределений и графиков финансового журнала.';
  return '';
}
/** Returns an error, or stamps NEW events/history only after all checks when called with server time. */
function validateLedger(previous, next, identity, now) {
  const old = previous?.financeLedger, ledger = next?.financeLedger;
  const changed = !same(old, ledger), factsChanged = ['financeEntries', 'treasury', 'documents'].some(key => !same(previous?.[key], next?.[key]));
  if (!changed && !factsChanged) return '';
  if (!ledger) return old ? 'Нельзя удалить финансовый журнал и его историю.' : '';
  if (changed && identity?.role !== 'management') return 'Финансовый журнал изменяет только управление.';
  const shapeError = validateFinanceLedgerShape(ledger); if (shapeError) return shapeError;
  if (ledger.version !== 1 || collectionNames.some(key => !Array.isArray(ledger[key])) || ledger.allocationEvents !== undefined && !Array.isArray(ledger.allocationEvents)) return 'Некорректная структура финансового журнала.';
  if (fields.some(key => (ledger[key] ?? []).some(row => !row || typeof row !== 'object' || Array.isArray(row)))) return 'Некорректная запись финансового журнала.';
  if (fields.some(key => (ledger[key]?.length ?? 0) > 10000)) return 'Слишком много записей финансового журнала.';
  if (old && !same(old.history ?? [], ledger.history ?? [])) return 'Историю финансового журнала записывает сервер.';
  if (!old && (ledger.history?.length ?? 0)) return 'Историю нового финансового журнала записывает сервер.';
  for (const key of ['operations', 'confirmations', 'allocationEvents']) if (!immutablePrefix(old?.[key], ledger[key] ?? [])) return 'Записанные операции, распределения и подтверждения неизменны; добавьте отдельное событие.';
  const entries = new Map((next.financeEntries ?? []).map(entry => [entry.id, entry]));
  const accounts = new Map((next.treasury?.accounts ?? []).map(account => [account.id, account]));
  const loans = new Map(ledger.loans.map(loan => [loan.id, loan]));
  const operations = new Map(ledger.operations.map(operation => [operation.id, operation]));
  const retentions = new Map(ledger.retentions.map(retention => [retention.id, retention]));
  const documents = new Map((next.documents ?? []).map(document => [document.id, document]));
  const allIds = new Set();
  for (const key of fields) for (const row of ledger[key] ?? []) {
    if (!text(row.id) || row.id.length > 200 || allIds.has(row.id)) return 'ID финансовых записей должны быть непустыми и уникальными.';
    allIds.add(row.id);
    if (!text(row.source) || row.source.length > 4000) return 'Укажите основание каждой финансовой записи.';
  }
  for (const key of ['operations', 'requests', 'retentions', 'loans']) for (const row of ledger[key]) {
    if (row.documentIds !== undefined && (!Array.isArray(row.documentIds) || row.documentIds.length > 100 || row.documentIds.some(id => !text(id)))) return 'Проверьте ссылки на оригиналы финансовых документов.';
    for (const id of [...(row.documentId ? [row.documentId] : []), ...(row.documentIds ?? [])]) {
      const document = documents.get(id);
      if (!document?.fileKey || document.clientVisible !== false || !text(next.project?.id) || !document.fileKey.startsWith(`${next.project.id}/`) || document.fileKey.includes('\\') || document.fileKey.split('/').some(part => ['.', '..'].includes(part))) return 'Приложите закрытый оригинал документа этого проекта.';
      const prior = old?.[key]?.find(item => item.id === row.id);
      if (prior && [prior.documentId, ...(prior.documentIds ?? [])].includes(id)) {
        const oldDocument = (previous.documents ?? []).find(item => item.id === id);
        if (oldDocument && !sameWithout(oldDocument, document, ['name', 'note', 'notes'])) return 'Нельзя заменить оригинал подтверждения записанной финансовой операции.';
      }
    }
  }
  const bankKeys = new Set();
  for (const row of [...ledger.operations, ...ledger.confirmations]) {
    if (row.sourceKey !== undefined) {
      if (!text(row.sourceKey) || row.sourceKey.length > 500 || bankKeys.has(row.sourceKey)) return 'Банковская операция с этим ключом уже зарегистрирована.';
      bankKeys.add(row.sourceKey);
    }
  }
  const oldOperationIds = new Set((old?.operations ?? []).map(operation => operation.id));
  const today = now ? datePart(now) : null;
  for (const loan of ledger.loans) {
    if (!text(loan.name) || !text(loan.counterparty) || !['borrowed', 'lent'].includes(loan.direction) || !accounts.has(loan.accountId) || !positive(loan.principalCents)
      || !['draft', 'active', 'closed'].includes(loan.status) || !Array.isArray(loan.schedule) || loan.schedule.length > 1000) return 'Проверьте договор займа, счёт, сумму и направление.';
    if (loan.openingPrincipalCents !== undefined && (!nonnegative(loan.openingPrincipalCents) || loan.openingPrincipalCents > loan.principalCents || !validDate(loan.openingDate))) return 'Для начального долга нужны сумма в пределах договора и дата.';
    const itemIds = new Set();
    for (const item of loan.schedule) {
      if (!text(item.id) || itemIds.has(item.id) || !['drawdown', 'principal', 'interest'].includes(item.kind) || !validDate(item.date) || !positive(item.amountCents)) return 'Проверьте строки графика займа.';
      if (item.entryId) {
        const entry = entries.get(item.entryId);
        if (item.kind !== 'interest' || !entry || entry.kind !== (loan.direction === 'borrowed' ? 'expense' : 'income') || item.amountCents > cents(entry.amount)) return 'Проценты должны ссылаться на соответствующее обязательство; тело займа не является выручкой или расходом.';
        if (item.trancheId && !(next.treasury?.entryPlans ?? []).find(plan => plan.entryId === item.entryId)?.tranches.some(row => row.id === item.trancheId)) return 'Связанный транш процентов не найден.';
        const priorLoan = old?.loans.find(row => row.id === loan.id), priorItem = priorLoan?.schedule.find(row => row.id === item.id);
        const newlyActiveMapping = loan.status !== 'draft' && (priorLoan?.status === 'draft' || priorItem?.entryId !== item.entryId || priorItem?.trancheId !== item.trancheId);
        if (newlyActiveMapping && (ledgerConfirmedLegacyPaidCents(next, entry) > 0 || ledger.operations.some(operation => operation.kind !== 'interest' && !operation.legacyPayment && operationAllocations(ledger, operation).some(allocation => allocation.entryId === entry.id)))) return 'Для процентов выберите обязательство без сторонних оплат и зачётов; существующие факты сохраняются отдельно.';
      } else if (item.trancheId) return 'Для транша процентов укажите обязательство.';
      itemIds.add(item.id);
    }
    const prior = old?.loans.find(row => row.id === loan.id);
    if (prior) for (const item of prior.schedule) if ((old?.operations ?? []).some(operation => operation.loanId === loan.id && operation.scheduleItemId === item.id)) {
      const current = loan.schedule.find(row => row.id === item.id);
      if (!current || !sameWithout(item, current, ['date', 'amountCents'])) return 'Строку графика с записанной операцией нельзя удалить или перепривязать.';
    }
    if (prior && (old?.operations ?? []).some(row => row.loanId === loan.id) && !sameWithout(prior, loan, ['name', 'source', 'status', 'schedule', 'updatedAt', 'updatedBy'])) return 'После операций нельзя менять направление, счёт и начальные условия займа.';
    if (prior?.status === 'closed' && loan.status !== 'closed') return 'Закрытый заём сохраняется; новый договор создаётся отдельно.';
  }
  for (const prior of old?.loans ?? []) if (!loans.has(prior.id)) return 'Договор займа нельзя удалить; используйте закрытие.';
  const linkedLegacy = new Set();
  const validateAllocations = (operation, allocations, isNew = !oldOperationIds.has(operation.id)) => {
    if (!Array.isArray(allocations) || allocations.length > 10000) return 'Некорректное распределение операции.';
    for (const allocation of allocations) {
      const entry = entries.get(allocation.entryId);
      if (!entry || !positive(allocation.amountCents)) return 'У распределения должен быть существующий долг и положительная сумма в копейках.';
      if (isNew && operation.kind !== 'interest' && ledger.loans.some(loan => loan.status !== 'draft' && loan.schedule.some(item => item.kind === 'interest' && item.entryId === entry.id))) return 'Проценты по займу оформляются в финансовом журнале: выберите заём и строку графика.';
      const wanted = ['payment', 'supplier_refund'].includes(operation.kind) ? 'expense' : ['receipt', 'customer_refund'].includes(operation.kind) ? 'income' : operation.kind === 'interest' ? loans.get(operation.loanId)?.direction === 'borrowed' ? 'expense' : 'income' : null;
      if (wanted && entry.kind !== wanted) return 'Направление распределения не совпадает с обязательством.';
      if (allocation.trancheId && !(next.treasury?.entryPlans ?? []).find(plan => plan.entryId === entry.id)?.tranches.some(tranche => tranche.id === allocation.trancheId)) return 'Связанный транш не найден в этом обязательстве.';
      if (allocation.retentionId) {
        const retention = retentions.get(allocation.retentionId);
        if (!retention || retention.entryId !== entry.id || retention.trancheId && retention.trancheId !== allocation.trancheId) return 'Удержание не соответствует обязательству или траншу.';
        if (!refundKind(operation.kind) && retention.status !== 'released' && isNew) return 'Удержание ещё не разрешено к выплате.';
      }
    }
    return '';
  };
  for (const operation of ledger.operations) {
    if (!operationKinds.includes(operation.kind) || !validDate(operation.date) || !positive(operation.amountCents) || !text(operation.description) || !text(operation.counterparty) || !own(confirmationRank, operation.confirmation)) return 'Проверьте вид, дату, сумму и описание операции.';
    if (today && !oldOperationIds.has(operation.id) && operation.date > today) return 'Будущая дата относится к плану, а не к фактической операции.';
    if (operation.cashTreatment !== undefined && !['account', 'participant_direct'].includes(operation.cashTreatment)) return 'Неизвестный источник расчёта.';
    if (operation.cashTreatment === 'participant_direct' && !['payment', 'receipt', 'supplier_refund', 'customer_refund'].includes(operation.kind)) return 'Прямой расчёт участником применим только к обязательствам.';
    if (operation.kind !== 'offset' && operation.cashTreatment !== 'participant_direct' && !accounts.has(operation.accountId)) return 'Выберите существующий счёт фактической операции.';
    if (operation.sourceKey && operation.confirmation !== 'reconciled') return 'Банковский ключ указывает на сверенный банковский факт.';
    if (operation.cashTreatment === 'participant_direct' && operation.confirmation === 'reconciled') return 'Прямую оплату участника нельзя объявить сверенной по счёту компании.';
    if (operation.kind === 'offset' && operation.confirmation === 'reconciled') return 'Неденежный зачёт не сверяется с банковским списанием.';
    if (operation.kind === 'offset' && (operation.accountId || operation.toAccountId)) return 'Зачёт не создаёт движения по счетам.';
    if (operation.kind === 'transfer') {
      if (!accounts.has(operation.toAccountId) || operation.toAccountId === operation.accountId || accounts.get(operation.toAccountId).legalEntityId !== accounts.get(operation.accountId)?.legalEntityId) return 'Перевод выполняется между разными счетами одного юрлица; межфирменный расчёт оформляется отдельным основанием.';
    } else if (operation.toAccountId) return 'Второй счёт задаётся только для перевода.';
    if (operation.documentId) {
      const document = documents.get(operation.documentId);
      if (!document?.fileKey || document.clientVisible !== false || !text(next.project?.id) || !document.fileKey.startsWith(`${next.project.id}/`) || document.fileKey.includes('\\') || document.fileKey.split('/').some(part => ['.', '..'].includes(part))) return 'Приложите закрытый оригинал документа этого проекта.';
      const oldDocument = (previous?.documents ?? []).find(row => row.id === operation.documentId);
      if (oldOperationIds.has(operation.id) && oldDocument && !sameWithout(oldDocument, document, ['name', 'note', 'notes'])) return 'Нельзя заменить оригинал подтверждения записанной финансовой операции.';
    }
    const allocationError = validateAllocations(operation, operation.allocations);
    if (allocationError) return allocationError;
    if (['loan_drawdown', 'loan_repayment', 'interest'].includes(operation.kind)) {
      const loan = loans.get(operation.loanId);
      if (!loan || loan.status === 'draft') return 'Операция займа требует действующего договора.';
      if (operation.scheduleItemId) {
        const item = loan.schedule.find(row => row.id === operation.scheduleItemId), kind = operation.kind === 'loan_drawdown' ? 'drawdown' : operation.kind === 'loan_repayment' ? 'principal' : 'interest';
        if (!item || item.kind !== kind) return 'Операция не соответствует строке графика займа.';
      }
      if (loan.accountId !== operation.accountId) return 'Счёт операции не совпадает со счётом договора займа.';
    } else if (operation.loanId || operation.scheduleItemId) return 'Ссылка на заём разрешена только для операций финансирования.';
    if (operation.legacyPayment) {
      const linked = legacyReference(next, operation.legacyPayment), key = `${operation.legacyPayment.entryId}\0${operation.legacyPayment.paymentId}`;
      if (!['payment', 'receipt'].includes(operation.kind) || !linked?.reference || linkedLegacy.has(key)
        || linked.entry.kind !== (operation.kind === 'payment' ? 'expense' : 'income') || linked.reference.amountCents !== operation.amountCents || linked.reference.date !== operation.date
        || operation.allocations.length || operation.loanId || operation.refundOfOperationId || operation.refundOfLegacyPayment) return 'Сверка должна точно совпасть с одной существующей оплатой и не создавать второе распределение.';
      linkedLegacy.add(key);
    }
    if (refundKind(operation.kind)) {
      if (Boolean(operation.refundOfOperationId) === Boolean(operation.refundOfLegacyPayment)) return 'Возврат должен ссылаться на одну исходную оплату.';
      const original = operations.get(operation.refundOfOperationId), legacy = legacyReference(next, operation.refundOfLegacyPayment);
      if (operation.refundOfOperationId && (!original || original.id === operation.id || original.kind !== (operation.kind === 'supplier_refund' ? 'payment' : 'receipt') || original.legacyPayment)) return 'Исходная операция возврата не найдена; для старой оплаты используйте её исходный ID.';
      if (operation.refundOfLegacyPayment && (!legacy?.reference || legacy.entry.kind !== (operation.kind === 'supplier_refund' ? 'expense' : 'income'))) return 'Исходная старая оплата возврата не найдена.';
      const originalDate = original?.date ?? legacy?.reference?.date;
      if (!originalDate || operation.date < originalDate) return 'Возврат не может предшествовать исходной оплате.';
      if (original && confirmationRank[effectiveLedgerConfirmation(ledger, original)] === 0) return 'Нельзя вернуть неподтверждённую оплату.';
    } else if (operation.refundOfOperationId || operation.refundOfLegacyPayment) return 'Основание возврата допустимо только для возвратной операции.';
  }
  for (const event of ledger.allocationEvents ?? []) {
    const operation = operations.get(event.operationId);
    if (!operation || operation.legacyPayment || !event.allocations?.length) return 'Дополнительное распределение требует существующей несверочной операции.';
    const error = validateAllocations(operation, event.allocations, !(old?.allocationEvents ?? []).some(row => row.id === event.id)); if (error) return error;
  }
  for (const event of ledger.confirmations) {
    const operation = operations.get(event.operationId);
    if (!operation || !['confirmed', 'reconciled'].includes(event.confirmation) || event.bankDate && event.bankDate !== operation.date) return 'Подтверждение должно относиться к существующей операции с той же датой.';
    if (event.confirmation === 'reconciled' && (operation.kind === 'offset' || operation.cashTreatment === 'participant_direct')) return 'Неденежный зачёт не сверяется с банковским списанием.';
  }
  const bankLegs = new Map();
  for (const operation of ledger.operations) if (operation.sourceKey) {
    if (operation.kind === 'offset' || operation.cashTreatment === 'participant_direct') return 'Банковский ключ недопустим для неденежной операции.';
    bankLegs.set(`${operation.id}\0${operation.accountId}`, operation.sourceKey);
  }
  for (const event of ledger.confirmations) if (event.sourceKey) {
    const operation = operations.get(event.operationId);
    if (event.confirmation !== 'reconciled' || !event.bankAccountId || ![operation.accountId, ...(operation.kind === 'transfer' ? [operation.toAccountId] : [])].includes(event.bankAccountId)) return 'Для банковской сверки укажите соответствующую сторону и счёт операции.';
    const key = `${operation.id}\0${event.bankAccountId}`;
    if (bankLegs.has(key)) return 'Эта сторона операции уже связана с банковским движением.';
    bankLegs.set(key, event.sourceKey);
  }
  const oldIds = new Set((old?.confirmations ?? []).map(event => event.id));
  for (const event of ledger.confirmations.filter(row => !oldIds.has(row.id))) {
    const priorRank = Math.max(confirmationRank[operations.get(event.operationId).confirmation], ...(old?.confirmations ?? []).filter(row => row.operationId === event.operationId).map(row => confirmationRank[row.confirmation]));
    if (confirmationRank[event.confirmation] < priorRank) return 'Уровень подтверждения нельзя понизить.';
  }
  for (const operation of ledger.operations) {
    const allocations = operationAllocations(ledger, operation), total = sum(allocations.map(row => row.amountCents));
    if (total === null) return 'Сумма распределения выходит за точный диапазон.';
    if (['loan_drawdown', 'loan_repayment', 'transfer'].includes(operation.kind) && total) return 'Тело займа и перевод не погашают строительные обязательства.';
    if (operation.kind === 'interest') {
      const item = loans.get(operation.loanId)?.schedule.find(row => row.id === operation.scheduleItemId);
      if ((total || item?.entryId) && (!item?.entryId || total !== operation.amountCents || allocations.some(row => row.entryId !== item.entryId || (row.trancheId ?? '') !== (item.trancheId ?? '')))) return 'Распределение процентов должно совпасть со связанным обязательством строки графика.';
    }
    if (operation.kind === 'offset') {
      if (sum(allocations.filter(row => entries.get(row.entryId)?.kind === 'expense').map(row => row.amountCents)) !== operation.amountCents || sum(allocations.filter(row => entries.get(row.entryId)?.kind === 'income').map(row => row.amountCents)) !== operation.amountCents) return 'Зачёт должен в равной сумме погасить встречные долги.';
    } else if (total > operation.amountCents || operation.legacyPayment && total) return 'Распределение превышает сумму исходной операции.';
  }
  // Every refund is bounded by the exact original settlement, including allocation dimensions.
  for (const operation of ledger.operations.filter(row => refundKind(row.kind))) {
    const original = operations.get(operation.refundOfOperationId), legacy = legacyReference(next, operation.refundOfLegacyPayment);
    const sourceAmount = original?.amountCents ?? legacy.reference.amountCents;
    const family = ledger.operations.filter(row => refundKind(row.kind) && (operation.refundOfOperationId ? row.refundOfOperationId === operation.refundOfOperationId : same(row.refundOfLegacyPayment, operation.refundOfLegacyPayment)));
    const returned = sum(family.map(row => row.amountCents));
    if (returned === null || returned > sourceAmount) return 'Сумма возвратов превышает исходную оплату.';
    const originalRows = original ? operationAllocations(ledger, original) : [{ entryId: legacy.entry.id, amountCents: sourceAmount }];
    const allocations = family.flatMap(row => operationAllocations(ledger, row));
    if (original) {
      const originalMap = countMap(originalRows), refundMap = countMap(allocations);
      if ([...refundMap].some(([key, value]) => !safe(value) || value > (originalMap.get(key) ?? 0))) return 'Возврат распределён на обязательство или транш, которых не было в исходной оплате.';
    } else if (allocations.some(row => row.entryId !== legacy.entry.id)) return 'Возврат старой оплаты относится только к её исходному обязательству.';
    const sourceUnallocated = sourceAmount - sum(originalRows.map(row => row.amountCents));
    const refundUnallocated = returned - sum(allocations.map(row => row.amountCents));
    if (refundUnallocated > sourceUnallocated) return 'Распределите возврат: он должен восстановить погашенный долг.';
  }
  for (const retention of ledger.retentions) {
    const entry = entries.get(retention.entryId);
    if (!entry || !positive(retention.amountCents) || !['held', 'released', 'canceled'].includes(retention.status) || retention.releaseDate !== undefined && !validDate(retention.releaseDate)) return 'Проверьте сумму, обязательство и срок удержания.';
    if (retention.trancheId && !(next.treasury?.entryPlans ?? []).find(plan => plan.entryId === retention.entryId)?.tranches.some(row => row.id === retention.trancheId)) return 'Транш удержания не найден.';
    const prior = old?.retentions.find(row => row.id === retention.id);
    if (prior && !sameWithout(prior, retention, ['status', 'releaseDate', 'source', 'updatedAt', 'updatedBy'])) return 'Сумма и основание удержания неизменны; отмените его и создайте новое.';
    if (prior?.status === 'canceled' && retention.status !== 'canceled') return 'Отменённое удержание нельзя вернуть без новой записи.';
    if (prior?.status === 'released' && retention.status === 'held') return 'Разрешённое удержание нельзя заблокировать задним числом.';
  }
  for (const prior of old?.retentions ?? []) if (!retentions.has(prior.id)) return 'Удержание нельзя удалить; используйте отмену.';
  for (const entry of entries.values()) {
    const balance = ledgerEntryBalance(next, entry.id), oldBalance = previous ? ledgerEntryBalance(previous, entry.id) : null;
    if (!balance || Object.values(balance).some(value => value === null)) return 'Денежные итоги выходят за точный диапазон.';
    if (balance.settledCents > (oldBalance?.settledCents ?? 0) && entry.kind === 'expense' && !text(entry.approvedAt) && !(cents(entry.acceptedAmount ?? (['accepted', 'paid'].includes(entry.status) ? entry.amount : 0)) > 0) && !(paidLegacy((previous?.financeEntries ?? []).find(row => row.id === entry.id) ?? { amount: 0 }) > 0)) return 'Сначала утвердите расход; заявленная операция сама его не утверждает.';
    if (balance.settledCents < 0 || balance.cashSettledCents < 0 || balance.overpaidCents > (oldBalance?.overpaidCents ?? 0)) return 'Расчёт превысит обязательство или возврат превысит оплаченное.';
    if (balance.heldCents > balance.remainingCents) return 'Оплата использует удержанную сумму; сначала разрешите удержание.';
    const mappedInterest = sum(ledger.loans.flatMap(loan => loan.schedule.filter(item => item.entryId === entry.id).map(item => item.amountCents)));
    if (mappedInterest === null || mappedInterest > balance.committedCents) return 'Сумма связанных процентов превышает обязательство.';
    const retainedTotal = sum(ledger.retentions.filter(row => row.entryId === entry.id && row.status !== 'canceled').map(row => row.amountCents));
    if (retainedTotal === null || retainedTotal > balance.committedCents) return 'Сумма удержаний превышает обязательство.';
  }
  // Validate planned principal as well as actual debt; no fictional repayment capacity.
  for (const loan of ledger.loans) {
    const actual = ledger.operations.filter(row => row.loanId === loan.id && confirmationRank[effectiveLedgerConfirmation(ledger, row)] > 0);
    let drawn = loan.openingPrincipalCents ?? 0, outstanding = drawn;
    for (const operation of [...actual].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'loan_drawdown' ? -1 : b.kind === 'loan_drawdown' ? 1 : 0))) {
      if (loan.openingDate && operation.date < loan.openingDate) return 'Операция займа предшествует дате начального долга.';
      if (operation.kind === 'loan_drawdown') { drawn = add(drawn, operation.amountCents); outstanding = add(outstanding, operation.amountCents); }
      if (operation.kind === 'loan_repayment') outstanding = add(outstanding, -operation.amountCents);
      if (drawn === null || outstanding === null || drawn > loan.principalCents || outstanding < 0) return 'Выдача превышает договор займа либо возврат превышает долг на дату операции.';
    }
    if (loan.status === 'closed' && (outstanding !== 0 || loan.schedule.some(item => item.amountCents > sum(actual.filter(operation => operation.scheduleItemId === item.id).map(operation => operation.amountCents))))) return 'Заём с непогашенным телом или строками графика нельзя закрыть.';
    for (const item of loan.schedule) {
      const settled = sum(actual.filter(operation => operation.scheduleItemId === item.id).map(operation => operation.amountCents));
      if (settled === null || settled > item.amountCents) return 'Операции превышают сумму строки графика займа.';
    }
    const plannedDrawn = sum([loan.openingPrincipalCents ?? 0, ...actual.filter(operation => operation.kind === 'loan_drawdown' && !operation.scheduleItemId).map(operation => operation.amountCents), ...loan.schedule.filter(item => item.kind === 'drawdown').map(item => item.amountCents)]);
    const plannedRepaid = sum([...actual.filter(operation => operation.kind === 'loan_repayment' && !operation.scheduleItemId).map(operation => operation.amountCents), ...loan.schedule.filter(item => item.kind === 'principal').map(item => item.amountCents)]);
    if (plannedDrawn === null || plannedRepaid === null || plannedDrawn > loan.principalCents || plannedRepaid > plannedDrawn) return 'План выдачи и возврата тела займа не сходится с условиями договора.';
    const timeline = actual.filter(operation => ['loan_drawdown', 'loan_repayment'].includes(operation.kind)).map(operation => ({ date: operation.date, delta: operation.kind === 'loan_drawdown' ? operation.amountCents : -operation.amountCents }));
    for (const item of loan.schedule.filter(item => item.kind !== 'interest')) {
      const remaining = item.amountCents - sum(actual.filter(operation => operation.scheduleItemId === item.id).map(operation => operation.amountCents));
      if (remaining > 0) timeline.push({ date: item.date, delta: item.kind === 'drawdown' ? remaining : -remaining });
    }
    let projectedDebt = loan.openingPrincipalCents ?? 0;
    for (const event of timeline.sort((a, b) => a.date.localeCompare(b.date) || b.delta - a.delta)) {
      if (loan.openingDate && event.date < loan.openingDate) return 'График займа не может предшествовать дате начального долга.';
      projectedDebt = add(projectedDebt, event.delta);
      if (projectedDebt === null || projectedDebt < 0) return 'Возврат по графику займа предшествует выдаче соответствующей суммы.';
    }
  }
  for (const request of ledger.requests) {
    const entry = entries.get(request.entryId), prior = old?.requests.find(row => row.id === request.id);
    if (!entry || entry.kind !== 'expense' || !positive(request.amountCents) || request.amountCents > cents(entry.amount) || !validDate(request.requestedDate) || !validDate(request.desiredDate) || !text(request.purpose) || !own(transitions, request.status)) return 'Проверьте заявку на оплату: обязательство, сумму, даты и назначение.';
    if (request.accountId && !accounts.has(request.accountId)) return 'Счёт заявки не найден.';
    if (request.trancheId && !(next.treasury?.entryPlans ?? []).find(plan => plan.entryId === entry.id)?.tranches.some(row => row.id === request.trancheId)) return 'Транш заявки не найден.';
    if (!prior && request.status !== 'draft' && request.status !== 'submitted') return 'Новая заявка начинается с черновика или передачи на согласование.';
    if (prior && !transitions[prior.status].includes(request.status)) return 'Недопустимый переход состояния заявки.';
    if (prior && !['draft', 'rejected'].includes(prior.status) && !sameWithout(prior, request, ['status', 'accountId', 'desiredDate', 'operationId', 'paymentAllocations', 'source', 'updatedAt', 'updatedBy'])) return 'После передачи на согласование сумму и назначение заявки нельзя переписывать.';
    if (['scheduled', 'executing', 'partially_paid', 'paid'].includes(request.status) && !request.accountId) return 'Для исполнения заявки укажите счёт.';
    if (request.paymentAllocations !== undefined && (!Array.isArray(request.paymentAllocations) || request.paymentAllocations.length > 1000)) return 'Некорректное распределение оплат заявки.';
    if (request.operationId && request.paymentAllocations?.length) return 'Выберите один способ привязки оплат заявки.';
    const links = request.paymentAllocations ?? (request.operationId ? [{ operationId: request.operationId, amountCents: request.amountCents }] : []);
    const linkIds = new Set();
    for (const link of links) {
      if (!positive(link.amountCents) || linkIds.has(link.operationId)) return 'Проверьте суммы и повторяющиеся оплаты заявки.';
      linkIds.add(link.operationId);
      const operation = operations.get(link.operationId);
      if (!operation || operation.kind !== 'payment' || effectiveLedgerConfirmation(ledger, operation) === 'claimed') return 'Оплаченная заявка требует подтверждённой оплаты.';
      const available = operation.legacyPayment?.entryId === request.entryId ? operation.amountCents : sum(operationAllocations(ledger, operation).filter(row => row.entryId === request.entryId && (!request.trancheId || row.trancheId === request.trancheId)).map(row => row.amountCents));
      if (link.amountCents > available || operation.accountId !== request.accountId) return 'Связанная оплата не покрывает заявку или относится к другому счёту.';
    }
    const linkedAmount = sum(links.map(link => link.amountCents));
    if (linkedAmount === null || linkedAmount > request.amountCents) return 'Распределённые оплаты превышают сумму заявки.';
    if (request.status === 'paid' && linkedAmount !== request.amountCents) return 'Оплаченная заявка требует подтверждённой оплаты на всю сумму.';
    if (request.status === 'partially_paid' && !(linkedAmount > 0 && linkedAmount < request.amountCents)) return 'Для частично оплаченной заявки укажите подтверждённую часть суммы.';
    if (linkedAmount > 0 && !['paid', 'partially_paid', 'canceled'].includes(request.status)) return 'У заявки с оплатами укажите частичное или полное погашение.';
    if (prior?.paymentAllocations && !immutablePrefix(prior.paymentAllocations, request.paymentAllocations ?? [])) return 'Привязки состоявшихся оплат заявки нельзя переписывать.';
    if (prior?.operationId && prior.operationId !== request.operationId) return 'Привязку состоявшейся оплаты нельзя переписывать.';
  }
  const requestLinks = ledger.requests.flatMap(request => (request.paymentAllocations ?? (request.operationId ? [{ operationId: request.operationId, amountCents: request.amountCents }] : [])).map(link => ({ ...link, entryId: request.entryId, trancheId: request.trancheId })));
  for (const operation of ledger.operations) {
    const links = requestLinks.filter(link => link.operationId === operation.id);
    for (const entryId of new Set(links.map(link => link.entryId))) {
      const available = operation.legacyPayment?.entryId === entryId ? operation.amountCents : sum(operationAllocations(ledger, operation).filter(row => row.entryId === entryId).map(row => row.amountCents));
      const assigned = sum(links.filter(link => link.entryId === entryId).map(link => link.amountCents));
      if (assigned === null || assigned > available) return 'Одна оплата уже использована в других заявках сверх её суммы.';
      for (const trancheId of new Set(links.filter(link => link.entryId === entryId && link.trancheId).map(link => link.trancheId))) {
        const trancheAvailable = operation.legacyPayment ? available : sum(operationAllocations(ledger, operation).filter(row => row.entryId === entryId && row.trancheId === trancheId).map(row => row.amountCents));
        const trancheAssigned = sum(links.filter(link => link.entryId === entryId && link.trancheId === trancheId).map(link => link.amountCents));
        if (trancheAssigned === null || trancheAssigned > trancheAvailable) return 'Оплата транша уже использована в других заявках.';
      }
    }

  }
  for (const prior of old?.requests ?? []) if (!ledger.requests.some(row => row.id === prior.id)) return 'Заявку нельзя удалить; используйте отмену.';
  if (changed && !text(ledger.changeReason)) return 'Укажите причину изменения финансового журнала.';
  if (changed && now) {
    const by = identity.name || identity.id || 'Управление';
    for (const key of ['operations', 'confirmations', 'allocationEvents']) {
      const known = new Set((old?.[key] ?? []).map(row => row.id));
      for (const row of ledger[key] ?? []) if (!known.has(row.id)) { row.recordedAt = now; row.recordedBy = by; }
    }
    for (const key of ['requests', 'retentions', 'loans']) for (const row of ledger[key]) {
      const prior = old?.[key]?.find(item => item.id === row.id);
      if (!prior) { row.createdAt = now; row.createdBy = by; }
      else { row.createdAt = prior.createdAt; row.createdBy = prior.createdBy; }
      if (!same(prior, row)) { row.updatedAt = now; row.updatedBy = by; }
    }
    const changes = fields.filter(key => !same(old?.[key] ?? [], ledger[key] ?? [])).map(field => ({ field, before: old?.[field] ?? [], after: structuredClone(ledger[field] ?? []) }));
    ledger.history = [...(old?.history ?? []), { id: `ledger-${now}-${(old?.history?.length ?? 0) + 1}`, at: now, by, reason: ledger.changeReason.trim(), changes }];
  }
  return '';
}

export function validateFinanceLedgerChanges(previous, next, identity, now) {
  try { return validateLedger(previous, next, identity, now); }
  catch { return 'Некорректные данные финансового журнала; проверьте суммы, ссылки и структуру записей.'; }
}
