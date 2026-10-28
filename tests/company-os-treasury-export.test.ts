import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIkiomaCompanyOsPayload } from '../sites/company-os-export.js';
import { treasuryProjection, treasuryCostSummary, type TreasuryProject } from '../src/domain/treasury.js';

const generatedAt = '2026-10-27T22:30:00Z'; // Already 28 October in the project timezone.
const fixture = (): TreasuryProject => ({
  project: { id: 'export-project' },
  budgetLines: [{ id: 'work', plan: 1000 }],
  financeEntries: [
    { id: 'expense', kind: 'expense', amount: 120.55, description: 'PRIVATE supplier phone +79990000000', dueDate: '2026-10-28' },
    { id: 'income', kind: 'income', amount: 100.10, description: 'PRIVATE customer', dueDate: '2026-10-30' },
    { id: 'direct', kind: 'expense', amount: 50, description: 'PRIVATE participant reimbursement', dueDate: '2026-10-29' },
  ],
  stages: [], tasks: [],
  treasury: {
    version: 1, enabled: true, reserveCents: 1000,
    accounts: [{ id: 'PRIVATE-account-id', name: 'PRIVATE bank 123456', legalEntityId: 'PRIVATE-entity-id', currency: 'RUB', isProjectDedicated: true,
      opening: { asOf: '2026-10-28', amountCents: 10000, confirmed: true, source: 'PRIVATE statement /source.pdf' } }],
    entryPlans: [
      { entryId: 'expense', sourceAccountId: 'PRIVATE-account-id', source: 'PRIVATE invoice', tranches: [
        { id: 'tranche', amountCents: 12055, contractualDueDate: '2026-10-27', forecastDate: '2026-10-29', certainty: 'confirmed', source: 'PRIVATE contract' },
      ] },
      { entryId: 'income', sourceAccountId: 'PRIVATE-account-id', source: 'PRIVATE agreement', tranches: [] },
      { entryId: 'direct', cashTreatment: 'participant_direct', source: 'PRIVATE name', tranches: [] },
    ],
    costEstimates: [{ id: 'cost', budgetLineId: 'work', name: 'PRIVATE estimate', recognizedCents: 20001, remainingWorkCents: 30002,
      stockToConsumeCents: 4003, otherRemainingCents: 5004, approvedBudgetCents: 100000, source: 'PRIVATE act.pdf' }],
  },
});
const exportState = (state: TreasuryProject) => buildIkiomaCompanyOsPayload({ generatedAt,
  stateRows: [{ revision: 5, updated_at: '2026-10-27T10:00:00Z', state_json: JSON.stringify(state) }] });

test('enabled treasury export shares cash and cost results with the workspace engine on generated local day', () => {
  const state = fixture(), original = structuredClone(state);
  const result = exportState(state).finance_projects[0].treasury;
  const projection = treasuryProjection(state, { today: '2026-10-28', horizonDays: 91, scenario: 'base' });
  const costs = treasuryCostSummary(state);
  assert.equal(result.enabled, true); assert.equal(result.canonical, true);
  assert.equal(result.as_of, '2026-10-28'); assert.equal(result.horizon_days, 91);
  assert.equal(result.cash_balance_rub, projection.openingCents! / 100);
  assert.equal(result.balance_known, projection.openingKnown);
  assert.equal(result.projection_complete, projection.completeness);
  assert.equal(result.minimum_balance_rub, projection.minBalanceCents! / 100);
  assert.equal(result.peak_funding_rub, projection.peakFundingCents! / 100);
  assert.equal(result.peak_reserve_funding_rub, projection.peakReserveFundingCents! / 100);
  assert.equal(result.first_deficit_date, projection.firstDeficitDate);
  assert.equal(result.costs.ac_rub, costs.recognizedCents! / 100);
  assert.equal(result.costs.etc_rub, costs.etcCents! / 100);
  assert.equal(result.costs.eac_rub, costs.eacCents! / 100);
  assert.equal(result.costs.variance_rub, costs.varianceCents! / 100);
  assert.equal(result.costs.complete, costs.complete);
  assert.deepEqual(result.days.map((day: { balance_rub: number | null }) => day.balance_rub), projection.days.map(day => day.balanceCents! / 100));
  assert.deepEqual(result.events.map((event: { id: string; amount_rub: number; date: string | null; contractual_due_date: string | null; certainty: string; excluded: boolean }) =>
    [event.id, event.amount_rub, event.date, event.contractual_due_date, event.certainty, event.excluded]),
  projection.events.map(event => [event.id, event.amountCents / 100, event.date, event.contractualDueDate, event.certainty, event.excluded === true]));
  assert.deepEqual(state, original);
});

test('unknown opening and incomplete costs export nulls, never fabricated zero balance or complete forecast', () => {
  const state = fixture(); delete state.treasury!.accounts[0].opening;
  state.treasury!.costEstimates = [];
  delete state.financeEntries[1].dueDate;
  const result = exportState(state).finance_projects[0].treasury;
  assert.equal(result.cash_balance_rub, null);
  assert.equal(result.balance_known, false); assert.equal(result.projection_complete, false);
  assert.equal(result.peak_funding_rub, null); assert.equal(result.peak_reserve_funding_rub, null);
  assert.ok(result.days.every((day: { balance_rub: number | null; deficit_rub: number | null }) => day.balance_rub === null && day.deficit_rub === null));
  assert.equal(result.unallocated_inflows_rub, 100.10);
  assert.equal(result.costs.ac_rub, null); assert.equal(result.costs.etc_rub, null); assert.equal(result.costs.eac_rub, null);
  assert.equal(result.costs.complete, false);
});

test('additive treasury namespace preserves every legacy finance field and stays absent on disabled projects', () => {
  const state = fixture();
  const withTreasury = exportState(state);
  const { treasury, ...legacyFields } = withTreasury.finance_projects[0];
  const disabled = structuredClone(state); disabled.treasury!.enabled = false;
  const withoutTreasury = exportState(disabled);
  assert.deepEqual(legacyFields, withoutTreasury.finance_projects[0]);
  assert.equal(withTreasury.finance_projects[0].cash_balance_rub, 0);
  assert.equal(withTreasury.finance_projects[0].bank_balance_confirmed, false);
  assert.equal('treasury' in withoutTreasury.finance_projects[0], false);
  delete disabled.treasury;
  assert.deepEqual(exportState(disabled), withoutTreasury);
  assert.deepEqual(withTreasury.meta, withoutTreasury.meta);
  assert.deepEqual(withTreasury.investor_projects, withoutTreasury.investor_projects);
  assert.equal(treasury.cash_balance_rub, 100);
});

test('treasury uses explicit safe fields: no descriptions, evidence, account identity or warning text', () => {
  const result = exportState(fixture()).finance_projects[0].treasury;
  assert.ok(result.warning_count > 0, 'excluded participant payment creates a warning containing its description in the engine');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(result).includes('+79990000000'), false);
  for (const event of result.events) {
    assert.deepEqual(Object.keys(event).sort(), ['id', 'entry_id', ...(event.tranche_id ? ['tranche_id'] : []), 'kind', 'amount_rub', 'date', 'scheduled_date', 'contractual_due_date', 'certainty', 'overdue', 'excluded', 'date_basis', 'date_requires_review', 'contract_overdue', 'forecast_delay_days'].sort());
  }
  assert.equal(result.events.find((event: { entry_id: string }) => event.entry_id === 'direct').excluded, true);
  assert.ok(result.days.every((day: { event_ids: string[] }) => !day.event_ids.includes('direct:remaining')));
});

test('export follows PPR forecast changes while preserving contractual deadlines and safe date metadata', () => {
  const state = fixture();
  state.stages = [{ id: 'stage', name: 'PRIVATE stage name', planStart: '2026-10-30', forecastEnd: '2026-11-02' }];
  state.treasury!.entryPlans[0].tranches[0].dateRule = { kind: 'stage_end', stageId: 'stage', offsetDays: 3, calendar: 'calendar' };
  const initial = exportState(state).finance_projects[0].treasury.events[0];
  state.stages[0].forecastEnd = '2026-11-07';
  const shifted = exportState(state).finance_projects[0].treasury.events[0];
  assert.equal(initial.scheduled_date, '2026-11-05');
  assert.equal(shifted.scheduled_date, '2026-11-10');
  assert.equal(shifted.contractual_due_date, initial.contractual_due_date);
  assert.equal(shifted.date_basis, 'recorded_plan');
  assert.equal(shifted.date_requires_review, true);
  assert.equal(shifted.contract_overdue, true);
  assert.equal(shifted.forecast_delay_days, 14);
  assert.equal(JSON.stringify(shifted).includes('PRIVATE'), false);
});
