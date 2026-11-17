import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { validateProjectFundingChanges } from '../src/domain/project-funding.js';
import { validateFinanceChanges } from '../src/domain/finance/index.js';
import { emptyTreasury, treasuryProjection } from '../src/domain/treasury.js';
import { financeWorkspaceSummary } from '../src/domain/finance-workspace.js';
import { stateForRole, mergeStateForRole } from '../sites/access-control.js';
const now = '2026-11-17T12:00:00.000Z';
const identity = { role: 'management' as const, name: 'Finance manager' };
const base = () => { const state = structuredClone(seedState); delete state.project.funding; delete state.financeLedger; state.financeEntries = []; state.treasury = emptyTreasury(); return state; };
const event = (amountCents = 900_000_000, date = '2026-11-16') => ({ amountCents, date, source: 'Bank statement' });

test('funding persists independent escrow facts and stamps immutable history without creating money', () => {
  const before = base(), state = structuredClone(before);
  state.project.funding = { route: 'escrow', bank: 'Bank', escrow: { planned: event(), deposited: event() }, contractor: { kind: 'own', confirmed: true, ...event(300_000_000) }, changeReason: 'Statements received' };
  assert.equal(validateFinanceChanges(before, state, identity, now), '');
  assert.equal(state.project.funding.recordedBy, identity.name);
  assert.equal(state.project.funding.history?.length, 1);
  assert.equal(state.project.funding.escrow?.released, undefined);
  assert.equal(state.project.funding.escrow?.received, undefined);
  assert.equal(state.financeEntries.length, 0);
  assert.equal(financeWorkspaceSummary(state, '2026-11-17').availableCashCents, null);
  const snapshot = structuredClone(state);
  assert.equal(validateProjectFundingChanges(snapshot, state, identity, now), '');
  assert.equal(state.project.funding.history?.length, 1);
  const changed = structuredClone(state);
  changed.project.funding!.escrow!.released = event(600_000_000);
  changed.project.funding!.changeReason = 'Partial release';
  assert.equal(validateProjectFundingChanges(state, changed, identity, now), '');
  assert.equal(changed.project.funding!.history?.length, 2);
  assert.equal(changed.project.funding!.history?.[0].record.escrow?.released, undefined);
  const forged = structuredClone(changed); forged.project.funding!.history = [];
  assert.match(validateProjectFundingChanges(changed, forged, identity, now), /История/);
});

test('funding rejects missing evidence, foreign files, future facts, contradictory money and unauthorized role', () => {
  const before = base(), state = structuredClone(before);
  state.project.funding = { route: 'escrow', escrow: { deposited: event() }, changeReason: 'Source checked' };
  assert.match(validateProjectFundingChanges(before, state, { role: 'foreman', name: 'Foreman' }, now), /управление/);
  for (const patch of [{ source: '' }, { date: '2026-11-18' }, { amountCents: -1 }, { documentId: 'outside-project' }]) {
    const next = structuredClone(state); Object.assign(next.project.funding!.escrow!.deposited!, patch);
    assert.notEqual(validateProjectFundingChanges(before, next, identity, now), '');
  }
  const excess = structuredClone(state); excess.project.funding!.escrow!.released = event(950_000_000);
  assert.match(validateProjectFundingChanges(before, excess, identity, now), /суммы/);
  const tooEarly = structuredClone(state); tooEarly.project.funding!.escrow!.released = event(600_000_000, '2026-11-15');
  assert.match(validateProjectFundingChanges(before, tooEarly, identity, now), /порядок/);
  const noSource = structuredClone(state); noSource.project.funding!.contractor = { kind: 'loan', confirmed: true };
  assert.match(validateProjectFundingChanges(before, noSource, identity, now), /подтверждённого/);
});

test('escrow account and forecast inflows cannot become available money even without manual restrictions', () => {
  const state = base();
  state.project.funding = { route: 'escrow', escrowAccountId: 'escrow', escrow: { deposited: event(), released: event(), received: event() }, changeReason: 'Evidence only' };
  state.treasury = { ...emptyTreasury(), enabled: true, accounts: [
    { id: 'operating', name: 'Operating', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: true, opening: { amountCents: 100_000, asOf: '2026-11-17', confirmed: true, source: 'Bank' } },
    { id: 'escrow', name: 'Escrow', currency: 'RUB', legalEntityId: 'company', isProjectDedicated: true, opening: { amountCents: 900_000_000, asOf: '2026-11-17', confirmed: true, source: 'Bank' } },
  ], cashPlans: [{ id: 'deposit', kind: 'income', name: 'Escrow replenishment', category: 'other', amountCents: 20_000_000, date: '2026-11-18', certainty: 'confirmed', source: 'Plan', accountId: 'escrow' }] };
  const projection = treasuryProjection(state, { today: '2026-11-17' });
  assert.equal(projection.openingCents, 100_000);
  assert.equal(projection.events.find(row => row.sourceId === 'deposit')?.excluded, true);
  assert.equal(projection.days[0].inflowCents, 0);
  assert.equal(financeWorkspaceSummary(state, '2026-11-17').availableCashCents, 100_000);
});

test('funding details stay out of foreman and client projections', () => {
  const state = base(); state.project.funding = { route: 'escrow', bank: 'Private bank', changeReason: 'Private' };
  assert.equal(stateForRole(state, { role: 'foreman', name: 'Foreman' }).project.funding, undefined);
  assert.equal(stateForRole(state, { role: 'client', name: 'Client' }).project.funding, undefined);
});

test('older clients cannot silently erase funding evidence on unrelated saves', () => {
  const before = base(); before.project.funding = { route: 'escrow', changeReason: 'Evidence' };
  const incoming = structuredClone(before); delete incoming.project.funding;
  const merged = mergeStateForRole(before, incoming, { ...identity, isOwner: true });
  assert.deepEqual(merged.project.funding, before.project.funding);
});
