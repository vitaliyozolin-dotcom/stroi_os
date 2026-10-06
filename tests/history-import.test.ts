import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { parseHistoryRegister, prepareHistoryImport, type HistoryRegister } from '../src/domain/history-import.ts';
import { validateFinanceChanges } from '../sites/projects/finance.js';
import { financeTotals } from '../src/domain/finance.ts';

const now = '2026-09-30T00:00:00.000Z';
const identity = { role: 'management', name: 'Владелец' };
const register = (): HistoryRegister => ({ format: 'IKIOMA-Kelosi-staged-import-v1', sources: [{ fileName: 'invoice.pdf', sha256: 'a'.repeat(64) }], budgetLines: [{ id: 'source-1', sourceRow: 1, name: 'Материалы', stageIds: ['sip'], plan: 120000, sourceFact: 90000 }], budgetReconciliation: { sourceDisplayedPlan: 100000, sumOfPlanItems: 120000 }, paidInvoices: [{ vendor: 'Поставщик', vendorInn: '1234567890', number: '1', documentDate: '2026-09-07', amount: 50000, description: 'Материалы', file: 'invoice.pdf', dedupKey: 'supplier:1', suggestedBudgetSourceRow: 1, paymentConfirmation: 'Владелец подтвердил оплату' }], paidLemanaPurchases: [] });
const current = () => {
  const state = structuredClone(seedState);
  state.project.id = 'project-test';
  state.documents.push({ id: 'doc-1', name: 'Счёт', fileName: 'invoice.pdf', fileKey: 'project-test/invoice.pdf', type: 'Счёт', updatedAt: now, clientVisible: false, status: 'current' });
  return state;
};

test('a purchase without invoice number keeps its actual supplier label and deduplicates', () => {
  const input = register();
  delete input.paidInvoices[0].number;
  input.paidInvoices[0].vendor = 'Петрович';
  const first = prepareHistoryImport(current(), input, identity.name, now, false);
  assert.equal(first.state.financeEntries[0].description, 'Петрович · Материалы');
  const second = prepareHistoryImport(first.state, input, identity.name, now, false);
  assert.equal(second.added, 0);
  assert.deepEqual(second.state, first.state);
});

test('import preserves original state, source totals, prior budget and unknown actual payment date', () => {
  const before = current(), snapshot = structuredClone(before);
  before.financeEntries.push({ id: 'old', kind: 'income', status: 'paid', amount: 100, date: '2026-09-01', counterparty: 'Заказчик', description: 'Аванс' });
  snapshot.financeEntries = structuredClone(before.financeEntries);
  const result = prepareHistoryImport(before, register(), identity.name, now, true);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(result.state.financeEntries[0], before.financeEntries[0]);
  assert.equal(result.added, 1);
  assert.equal(result.state.budgetLines[0].plan, 120000);
  assert.equal(result.state.budgetLines[0].sourceFact, 90000);
  assert.deepEqual(result.state.budgetMeta.importPreviousBudget?.lines, before.budgetLines);
  assert.equal(result.state.financeEntries[1].paidAt, undefined);
  assert.equal(financeTotals(result.state).paid, 50000);
  assert.equal(financeTotals(result.state).accepted, 0);
  assert.deepEqual(result.state.stages, before.stages);
  assert.deepEqual(result.state.settings, before.settings);
  assert.equal(validateFinanceChanges(before, result.state, identity, now), '');
});

test('repeat import is deduplicated and original recorded timestamp remains', () => {
  const first = prepareHistoryImport(current(), register(), identity.name, now, true);
  assert.equal(validateFinanceChanges(current(), first.state, identity, now), '');
  const second = prepareHistoryImport(first.state, register(), identity.name, '2026-10-01T00:00:00Z', true);
  assert.equal(second.added, 0); assert.equal(second.skipped, 1);
  assert.deepEqual(second.state, first.state);
});

test('an unassigned purchase stays unallocated when the existing budget has no source rows', () => {
  const input = register();
  delete input.paidInvoices[0].suggestedBudgetSourceRow;
  const result = prepareHistoryImport(current(), input, identity.name, now, false);
  const entry = result.state.financeEntries.find((item) => item.historicalPayment)!;
  assert.equal(entry.budgetLineId, undefined);
  assert.equal(entry.stageId, undefined);
});

test('missing, client-visible and foreign project documents cannot back an import', () => {
  for (const mode of ['missing', 'visible', 'foreign']) {
    const state = current();
    if (mode === 'missing') state.documents = [];
    if (mode === 'visible') state.documents[0].clientVisible = true;
    if (mode === 'foreign') state.documents[0].fileKey = 'other/invoice.pdf';
    assert.throws(() => prepareHistoryImport(state, register(), identity.name, now, true));
  }
});

test('server rejects fabricated acceptance, missing evidence, duplicate source, non-manager and historical edits', () => {
  const base = current(), candidate = prepareHistoryImport(base, register(), identity.name, now, true).state;
  for (const mutate of [(s: typeof candidate) => { s.financeEntries[0].acceptedAmount = 50000; }, (s: typeof candidate) => { s.documents = []; }, (s: typeof candidate) => { s.financeEntries.push({ ...s.financeEntries[0], id: 'duplicate' }); }, (s: typeof candidate) => { s.financeEntries[0].paidAt = '2026-02-30'; }]) {
    const bad = structuredClone(candidate); mutate(bad); assert.ok(validateFinanceChanges(base, bad, identity, now));
  }
  assert.ok(validateFinanceChanges(base, structuredClone(candidate), { role: 'foreman', name: 'Прораб' }, now));
  assert.equal(validateFinanceChanges(base, candidate, identity, now), '');
  const changed = structuredClone(candidate); changed.financeEntries[0].description = 'Изменено';
  assert.ok(validateFinanceChanges(candidate, changed, identity, now));
  const removed = structuredClone(candidate); removed.financeEntries = [];
  assert.ok(validateFinanceChanges(candidate, removed, identity, now));
});

test('malformed or duplicate records fail before state mutation', () => {
  const input = register(); input.paidInvoices[0].amount = -5;
  assert.throws(() => parseHistoryRegister(input));
  const duplicate = register(); duplicate.paidInvoices.push({ ...duplicate.paidInvoices[0] });
  assert.throws(() => parseHistoryRegister(duplicate));
});

test('owner confirmation marks an existing expense paid once while preserving its identity and links', () => {
  const base = current();
  base.financeEntries.push({ id: 'legacy-expense', kind: 'expense', status: 'committed', amount: 500, date: '2026-08-01', description: 'Подготовка', counterparty: 'Исполнитель', budgetLineId: base.budgetLines[0].id, createdBy: 'Прораб' });
  const input = register();
  input.budgetApproval = 'Владелец принимает смету за план';
  input.existingPaidExpenses = [{ existingOperation: true, vendor: 'Исполнитель', description: 'Подготовка', amount: 500, documentDate: '2026-08-01', file: 'invoice.pdf', dedupKey: 'existing:1', paymentConfirmation: 'Владелец подтвердил все расходы' }];
  const result = prepareHistoryImport(base, input, identity.name, now, true);
  assert.equal(result.updated, 1);
  const expense = result.state.financeEntries.find((item) => item.id === 'legacy-expense')!;
  assert.equal(expense.createdBy, 'Прораб');
  assert.equal(expense.budgetLineId, base.financeEntries[0].budgetLineId);
  assert.equal(expense.status, 'paid'); assert.equal(expense.paidAmount, 500);
  assert.equal(expense.acceptedAmount, 0); assert.equal(expense.paidAt, undefined);
  assert.equal(result.state.budgetMeta.approvedBy, identity.name);
  assert.equal(validateFinanceChanges(base, result.state, identity, now), '');
  const again = prepareHistoryImport(result.state, input, identity.name, '2026-10-01T00:00:00Z', true);
  assert.equal(again.updated, 0); assert.deepEqual(again.state, result.state);
  const altered = structuredClone(result.state); altered.financeEntries[0].amount = 501;
  assert.ok(validateFinanceChanges(base, altered, identity, now));
  const absent = structuredClone(base); absent.financeEntries = [];
  assert.throws(() => prepareHistoryImport(absent, input, identity.name, now, true));
});

test('confirmation cannot rewrite an existing expense or bypass the existing-operation boundary', () => {
  const base = current();
  base.financeEntries.push({ id: 'existing', kind: 'expense', status: 'committed', amount: 500, date: '2026-08-01', description: 'Подготовка', counterparty: 'Исполнитель', createdBy: 'Прораб', approvedAt: '2026-08-02T00:00:00Z', approvedBy: 'Управление' });
  const input = register();
  input.existingPaidExpenses = [{ existingOperation: true, vendor: 'Исполнитель', description: 'Подготовка', amount: 500, documentDate: '2026-08-01', file: 'invoice.pdf', dedupKey: 'existing:1', paymentConfirmation: 'Подтверждение владельца' }];
  const candidate = prepareHistoryImport(base, input, identity.name, now, false).state;
  assert.equal(validateFinanceChanges(base, candidate, identity, now), '');
  assert.equal(candidate.financeEntries[0].approvedBy, 'Управление');
  for (const key of ['amount', 'date', 'description', 'counterparty', 'createdBy', 'approvedBy', 'stageId'] as const) {
    const bad = structuredClone(candidate);
    Object.assign(bad.financeEntries[0], { [key]: key === 'amount' ? 501 : 'подмена' });
    assert.ok(validateFinanceChanges(base, bad, identity, now), key);
  }
  const missing = structuredClone(base); missing.financeEntries = [];
  assert.ok(validateFinanceChanges(missing, structuredClone(candidate), identity, now));
});

test('owner budget approval applies only when the source budget is included', () => {
  const input = register(); input.budgetApproval = 'Смета принята владельцем за план';
  const base = current();
  delete base.budgetMeta.approvedAt; delete base.budgetMeta.approvedBy;
  const result = prepareHistoryImport(base, input, identity.name, now, false);
  assert.equal(result.state.budgetMeta.approvedAt, undefined);
  assert.equal(result.state.project.targetCost, base.project.targetCost);
});

test('a later budget import allocates unmatched historical payments without changing payment facts', () => {
  const base = current();
  const input = register();
  const first = prepareHistoryImport(base, input, identity.name, now, false).state;
  assert.equal(validateFinanceChanges(base, first, identity, now), '');
  const old = structuredClone(first.financeEntries[0]);
  const second = prepareHistoryImport(first, input, identity.name, now, true).state;
  assert.equal(validateFinanceChanges(first, second, identity, now), '');
  assert.equal(second.financeEntries[0].budgetLineId, 'source-1');
  assert.deepEqual(second.financeEntries[0].historicalPayment, old.historicalPayment);
  assert.equal(second.financeEntries[0].amount, old.amount);
  assert.equal(second.financeEntries[0].budgetAllocation?.by, identity.name);
  for (const change of [{ amount: 1 }, { budgetLineId: 'missing' }, { date: '2026-01-01' }]) {
    const bad = structuredClone(second); Object.assign(bad.financeEntries[0], change);
    assert.ok(validateFinanceChanges(first, bad, identity, now));
  }
  assert.ok(validateFinanceChanges(first, structuredClone(second), { role: 'foreman' }, now));
});

test('source rows outside its total are retained without increasing the accepted plan', () => {
  const input = register();
  input.budgetLines.push({ id: 'outside', name: 'Вне формулы', sourceRow: 2, stageIds: [], plan: 0, sourcePlan: 20000, sourceFact: 15000, outsideSourceTotal: true });
  const result = prepareHistoryImport(current(), input, identity.name, now, true);
  assert.equal(financeTotals(result.state).plan, 120000);
  assert.equal(result.state.budgetLines[1].sourcePlan, 20000);
  assert.equal(result.state.budgetLines[1].sourceFact, 15000);
  assert.match(result.state.budgetMeta.note!, /20.*000/);
  input.budgetLines[1].sourcePlan = -1;
  assert.throws(() => parseHistoryRegister(input));
});

test('a revised source budget preserves classification history, independent forecast and payment links by stable id', () => {
  const firstInput = register();
  const before = prepareHistoryImport(current(), firstInput, identity.name, now, true).state;
  const classification = [{ group: 'construction' as const, at: now, by: identity.name }];
  Object.assign(before.budgetLines[0], { costGroup: 'construction', costGroupHistory: classification, forecast: 155000 });
  const originalPayment = structuredClone(before.financeEntries[0]);
  const snapshot = structuredClone(before);
  const revision = register();
  revision.sources[0].sha256 = 'b'.repeat(64);
  Object.assign(revision.budgetLines[0], { name: 'Материалы и монтаж', sourceRow: 4, plan: 140000, sourceFact: 110000 });
  revision.budgetReconciliation.sumOfPlanItems = 140000;
  const result = prepareHistoryImport(before, revision, identity.name, '2026-10-01T00:00:00Z', true);
  assert.equal(result.state.budgetLines.length, 1);
  assert.deepEqual(result.state.budgetLines[0], {
    ...revision.budgetLines[0], forecast: 155000, sourcePlan: undefined, outsideSourceTotal: undefined,
    sourceParticipantAmounts: undefined, costGroup: 'construction', costGroupHistory: classification,
  });
  assert.deepEqual(result.state.financeEntries[0], originalPayment);
  assert.deepEqual(before, snapshot);
  assert.equal(validateFinanceChanges(before, result.state, identity, now), '');
  assert.deepEqual(result.state.budgetLines[0].costGroupHistory, classification);
  const again = prepareHistoryImport(result.state, revision, identity.name, '2026-10-02T00:00:00Z', true);
  assert.deepEqual(again.state, result.state);
});

test('a default forecast follows the revised plan but independent forecasts above or below it survive', () => {
  for (const [oldForecast, expected] of [[120000, 140000], [155000, 155000], [100000, 100000]]) {
    const before = current();
    before.budgetLines = [{ id: 'source-1', name: 'Материалы', sourceRow: 1, stageIds: ['sip'], plan: 120000, forecast: oldForecast }];
    const input = register();
    input.paidInvoices = [];
    input.budgetLines[0].plan = 140000;
    input.budgetReconciliation.sumOfPlanItems = 140000;
    const after = prepareHistoryImport(before, input, identity.name, now, true).state;
    assert.equal(after.budgetLines[0].plan, 140000);
    assert.equal(after.budgetLines[0].forecast, expected);
  }
});

test('an unambiguous row and name match keeps the existing id and its financial links', () => {
  const before = prepareHistoryImport(current(), register(), identity.name, now, true).state;
  Object.assign(before.budgetLines[0], { costGroup: 'overhead', forecast: 125000 });
  const payment = structuredClone(before.financeEntries[0]);
  const input = register();
  input.sources[0].sha256 = 'b'.repeat(64);
  input.budgetLines[0].id = 'new-source-id';
  input.budgetLines[0].name = ' Материалы ';
  const after = prepareHistoryImport(before, input, identity.name, now, true).state;
  assert.equal(after.budgetLines.length, 1);
  assert.equal(after.budgetLines[0].id, 'source-1');
  assert.equal(after.budgetLines[0].costGroup, 'overhead');
  assert.equal(after.budgetLines[0].forecast, 125000);
  assert.deepEqual(after.financeEntries[0], payment);
  assert.equal(validateFinanceChanges(before, after, identity, now), '');
});

test('row fallback cannot steal an id matched elsewhere in the same import', () => {
  const before = current();
  before.budgetLines = [{ id: 'source-1', name: 'Материалы', sourceRow: 1, stageIds: ['sip'], plan: 100, forecast: 130, costGroup: 'construction' }];
  const input = register();
  input.paidInvoices = [];
  input.budgetLines = [
    { id: 'new-line', name: 'Материалы', sourceRow: 1, stageIds: ['sip'], plan: 20 },
    { id: 'source-1', name: 'Материалы переименованы', sourceRow: 2, stageIds: ['sip'], plan: 110 },
  ];
  input.budgetReconciliation.sumOfPlanItems = 130;
  const after = prepareHistoryImport(before, input, identity.name, now, true).state;
  assert.deepEqual(after.budgetLines.map(line => [line.id, line.forecast, line.costGroup]), [
    ['new-line', 20, undefined], ['source-1', 130, 'construction'],
  ]);
});

test('reused row numbers and ambiguous prior rows do not inherit another article classification or forecast', () => {
  for (const ambiguous of [false, true]) {
    const before = current();
    before.budgetLines = [{ id: 'previous-line', name: ambiguous ? 'Материалы' : 'Другая статья', sourceRow: 1, stageIds: ['sip'], plan: 100, forecast: 150, costGroup: 'overhead' }];
    if (ambiguous) before.budgetLines.push({ ...before.budgetLines[0], id: 'another-previous-line' });
    const input = register();
    input.paidInvoices = [];
    const after = prepareHistoryImport(before, input, identity.name, now, true).state;
    assert.equal(after.budgetLines[0].id, 'source-1');
    assert.equal(after.budgetLines[0].costGroup, undefined);
    assert.equal(after.budgetLines[0].forecast, 120000);
  }
});

test('confirming an existing expense imports its known payment date and deduplicates it', () => {
  const before = current();
  before.financeEntries.push({ id: 'legacy-expense', kind: 'expense', status: 'committed', amount: 500, date: '2026-08-01', description: 'Подготовка', counterparty: 'Исполнитель' });
  const input = register();
  input.paidInvoices = [];
  input.existingPaidExpenses = [{ existingOperation: true, vendor: 'Исполнитель', description: 'Подготовка', amount: 500, documentDate: '2026-08-01', paymentDate: '2026-08-07', file: 'invoice.pdf', dedupKey: 'existing:dated', paymentConfirmation: 'Владелец подтвердил оплату и дату' }];
  const after = prepareHistoryImport(before, input, identity.name, now, false).state;
  assert.equal(after.financeEntries[0].date, '2026-08-01');
  assert.equal(after.financeEntries[0].paidAt, '2026-08-07');
  assert.equal(after.financeEntries[0].paidAmount, 500);
  assert.equal(after.financeEntries[0].acceptedAmount, 0);
  assert.equal(validateFinanceChanges(before, after, identity, now), '');
  assert.deepEqual(prepareHistoryImport(after, input, identity.name, now, false).state, after);
  input.existingPaidExpenses![0].paymentDate = '2026-08-08';
  assert.throws(() => prepareHistoryImport(after, input, identity.name, now, false), /Дата оплаты отличается/);
});

test('existing known payment dates are preserved or matched, never overwritten by a conflicting import', () => {
  const before = current();
  before.financeEntries.push({ id: 'legacy-expense', kind: 'expense', status: 'committed', amount: 500, date: '2026-08-01', paidAt: '2026-08-07', description: 'Подготовка', counterparty: 'Исполнитель' });
  const input = register();
  input.paidInvoices = [];
  input.existingPaidExpenses = [{ existingOperation: true, vendor: 'Исполнитель', description: 'Подготовка', amount: 500, documentDate: '2026-08-01', file: 'invoice.pdf', dedupKey: 'existing:dated', paymentConfirmation: 'Подтверждение владельца' }];
  for (const paymentDate of [undefined, null, '2026-08-07']) {
    input.existingPaidExpenses[0].paymentDate = paymentDate;
    const after = prepareHistoryImport(before, input, identity.name, now, false).state;
    assert.equal(after.financeEntries[0].paidAt, '2026-08-07');
    assert.equal(validateFinanceChanges(before, after, identity, now), '');
  }
  const snapshot = structuredClone(before);
  input.existingPaidExpenses[0].paymentDate = '2026-08-08';
  assert.throws(() => prepareHistoryImport(before, input, identity.name, now, false), /Дата оплаты отличается/);
  assert.deepEqual(before, snapshot);
});

test('invalid source totals, facts, participant amounts and duplicate worksheet rows fail validation', () => {
  const invalidInputs: ((input: HistoryRegister) => void)[] = [
    input => { input.budgetReconciliation.sourceDisplayedPlan = NaN; },
    input => { input.budgetReconciliation.sumOfPlanItems = -1; },
    input => { input.budgetLines[0].sourceFact = Infinity; },
    input => { input.budgetLines[0].participantAmounts = { Владелец: NaN }; },
    input => { input.budgetLines[0].sourceRow = 0; },
    input => { input.budgetLines.push({ ...input.budgetLines[0], id: 'different-id' }); },
  ];
  for (const mutate of invalidInputs) {
    const input = register();
    mutate(input);
    assert.throws(() => parseHistoryRegister(input));
  }
});
