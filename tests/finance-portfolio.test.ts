import test from 'node:test';
import assert from 'node:assert/strict';
import { financePortfolio, validatePortfolioWrite, requiresPortfolioCheck } from '../src/domain/finance-portfolio.js';
import { emptyTreasury, treasuryScopeFingerprint } from '../src/domain/treasury.js';
import { financeCalendarItems } from '../src/domain/finance-calendar.ts';
import { schedulePaymentMarkers } from '../src/components/schedule-work-model.ts';
import { createFinancePortfolioHandler } from '../sites/projects/finance-portfolio.js';

const today = '2026-10-28';
const fixture = (id = 'a', allocation = 6000, company = 'company') => ({
  project: { id, name: `Project ${id}`, code: id }, stages: [], tasks: [], financeEntries: [], budgetLines: [],
  treasury: { ...emptyTreasury(), enabled: true,
    accounts: [{ id: 'bank', name: 'Account', legalEntityId: company, currency: 'RUB', isProjectDedicated: false, sharedAccountKey: 'bank-shared',
      projectAllocationCents: allocation, opening: { asOf: today, amountCents: 10000, confirmed: true, source: 'Bank snapshot' } }],
    costEstimates: [{ id: 'cost', name: 'Whole scope', recognizedCents: 0, remainingWorkCents: 0, stockToConsumeCents: 0, otherRemainingCents: 0, approvedBudgetCents: 0, source: 'Full scope reviewed' }] },
  settings: { users: [{ id: 'user', email: 'manager@example.test', name: 'Manager', role: 'management', status: 'active' }] },
});
const review = state => { state.treasury.cashScopeReview = { asOf: today, source: 'All obligations reviewed', fingerprint: treasuryScopeFingerprint(state) }; return state; };

test('portfolio sums allocated shares once, not repeated full shared-bank balances', () => {
  const a = review(fixture()), b = review(fixture('b', 4000));
  assert.equal(validatePortfolioWrite(a, a, [b]), '');
  const result = financePortfolio([a, b], { today, horizonDays: 7 });
  assert.equal(result.summary.openingCents, 10000);
  assert.equal(result.companies[0].openingCents, 10000);
  assert.equal(result.summary.complete, true);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.scope, 'authorized_project_allocations');
});

test('shared allocation guard rejects overcommit and different snapshots, without leaking other projects', () => {
  const a = fixture(), b = fixture('private-name', 4001);
  assert.match(validatePortfolioWrite(null, a, [b]), /превышают/);
  b.treasury.accounts[0].projectAllocationCents = 4000;
  b.treasury.accounts[0].opening.amountCents = 11000;
  const message = validatePortfolioWrite(null, a, [b]);
  assert.match(message, /расходятся/); assert.ok(!message.includes('private-name'));
  const legacy = fixture(); delete legacy.treasury.accounts[0].sharedAccountKey;
  assert.equal(validatePortfolioWrite(legacy, legacy, []), '');
  const changed = structuredClone(legacy); changed.treasury.accounts[0].projectAllocationCents++;
  assert.match(validatePortfolioWrite(legacy, changed, []), /идентификатор/);
  assert.equal(financePortfolio([review(legacy)], { today }).summary.complete, false);
});

test('bank import source identity cannot occur in another project or evade transaction check', () => {
  const a = fixture(), b = fixture('b', 4000);
  a.financeLedger = { operations: [{ sourceKey: 'bank:shared:123' }], confirmations: [] };
  b.financeLedger = { operations: [], confirmations: [{ sourceKey: 'bank:shared:123' }] };
  assert.equal(requiresPortfolioCheck(fixture(), a), true);
  assert.match(validatePortfolioWrite(null, a, [b]), /уже записана/);
  const dedicated = fixture(); dedicated.treasury.accounts[0].isProjectDedicated = true;
  const rename = structuredClone(dedicated); rename.treasury.accounts[0].name = 'New name';
  assert.equal(requiresPortfolioCheck(dedicated, rename), false);
});

test('unknown project cash stays unknown and entity deficits remain visible under positive aggregate cash', () => {
  const a = fixture(), b = fixture('b', 4000, 'other-company');
  for (const state of [a, b]) { state.treasury.accounts[0].isProjectDedicated = true; delete state.treasury.accounts[0].sharedAccountKey; }
  a.financeEntries = [{ id: 'expense', kind: 'expense', amount: 150, description: 'Cost', dueDate: '2026-10-29' }];
  a.treasury.entryPlans = [{ entryId: 'expense', sourceAccountId: 'bank', cashTreatment: 'account', tranches: [], source: 'Contract' }];
  const result = financePortfolio([review(a), review(b)], { today, horizonDays: 7 });
  assert.equal(result.summary.peakFundingCents, 0);
  assert.equal(result.companiesWithDeficit, 1); assert.equal(result.companies[0].peakFundingCents, 5000);
  delete b.treasury.accounts[0].opening;
  const unknown = financePortfolio([a, b], { today });
  assert.equal(unknown.summary.openingCents, null); assert.equal(unknown.summary.peakFundingCents, null); assert.equal(unknown.summary.complete, false);
});

test('portfolio endpoint exposes only management projects, also respecting local membership boundary', async () => {
  const a = fixture(), privateProject = fixture('private', 4000), clientProject = fixture('client', 4000);
  privateProject.settings.users = []; clientProject.settings.users[0].role = 'client';
  const DB = { prepare: () => ({ all: async () => ({ results: [a, privateProject, clientProject].map(state => ({ state_json: JSON.stringify(state) })) }) }) };
  const handler = createFinancePortfolioHandler({ ensureSchema: async () => {} });
  const request = new Request(`https://example.test/api/finance/portfolio?asOf=${today}`, { headers: { 'oai-authenticated-user-email': 'manager@example.test', 'oai-authenticated-user-access-mode': 'local-membership', 'oai-authenticated-user-projects': 'a,client' } });
  const response = await handler(request, { DB, OWNER_EMAIL: 'owner@example.test' });
  assert.equal(response.status, 200);
  const body = await response.json(); assert.deepEqual(body.portfolio.projects.map(item => item.projectId), ['a']);
  assert.ok(!JSON.stringify(body).includes('private'));
  const denied = await handler(new Request('https://example.test/api/finance/portfolio'), { DB });
  assert.equal(denied.status, 403);
});

test('standalone work estimate stays visible in calendar and triggering PPR stage without a synthetic obligation', () => {
  const state = fixture(); state.stages = [{ id: 'stage', name: 'Build', planStart: '2026-10-29' }];
  state.treasury.cashPlans = [{ id: 'uncontracted', name: 'Work to procure', kind: 'expense', category: 'uncontracted_work', amountCents: 2500,
    dateRule: { kind: 'stage_start', stageId: 'stage', offsetDays: 0, calendar: 'calendar' }, accountId: 'bank', certainty: 'expected', source: 'Cost estimate' }];
  const [calendar] = financeCalendarItems(state, today);
  assert.equal(calendar.entry, undefined); assert.equal(calendar.kind, 'expense'); assert.equal(calendar.remaining, 25);
  assert.equal(calendar.dueDate, '2026-10-29'); assert.equal(calendar.projectionEvent.sourceType, 'cash_plan');
  const [marker] = schedulePaymentMarkers(state, 'management', today);
  assert.equal(marker.stageId, 'stage'); assert.equal(marker.date, calendar.dueDate); assert.equal(marker.amount, calendar.remaining);
  assert.equal(marker.sourceType, 'cash_plan'); assert.equal(state.financeEntries.length, 0);
  assert.deepEqual(schedulePaymentMarkers(state, 'foreman', today), []);
});
