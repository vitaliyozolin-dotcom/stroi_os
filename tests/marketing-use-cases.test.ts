import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import { createMarketingUseCases } from '../src/application/marketing.ts';
import { leadSnapshot, type LeadDraft } from '../src/domain/marketing.ts';
import { readFileSync } from 'node:fs';
const clock = { now: () => '2026-10-20T12:00:00Z' };
const ids = { next: (prefix: string) => `${prefix}-test` };
const fixture = () => { const state = structuredClone(seedState); state.leads = [{ id: 'existing', createdAt: clock.now(), name: 'Клиент', phone: '+7 000', source: 'manual', stage: 'new', nextAction: 'Звонок', owner: 'Менеджер' }]; return state; };
const draft = (): LeadDraft => ({ name: ' Новый клиент ', phone: ' +7 001 ', source: 'manual', budget: 100, houseArea: 80, landStatus: 'unknown', mortgageStatus: 'unknown', nextAction: ' ', owner: ' ', notes: ' Заметка ' });
const useCases = (state: ReturnType<typeof fixture>, sink = (_next: ReturnType<typeof fixture>) => {}, role: 'management' | 'foreman' | 'client' = 'management') => createMarketingUseCases(state, { name: 'Менеджер', role }, clock, ids, sink);
test('step 1: creating a lead normalizes data, preserves unrelated records and uses injected audit', () => {
 const state = fixture(), before = structuredClone(state); let writes = 0;
 const result = useCases(state, () => { writes++; }).execute({ action: 'create', projectId: state.project.id, draft: draft() });
 assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.deepEqual(state, before); assert.equal(writes, 1); const lead = result.change.state.leads[0];
 assert.equal(lead.id, 'lead-test'); assert.equal(lead.name, 'Новый клиент'); assert.equal(lead.stage, 'new'); assert.equal(lead.owner, 'Менеджер'); assert.equal(lead.createdAt, clock.now()); assert.equal(lead.nextAction, 'Позвонить и квалифицировать заявку'); assert.equal(result.change.action, 'lead_updated'); assert.deepEqual(result.change.state.financeEntries, state.financeEntries);
});
test('step 1: invalid amounts/contact/date, roles and changed project fail without writes', () => {
 for (const invalid of [{ name: ' ' }, { phone: ' ' }, { budget: NaN }, { budget: -1 }, { houseArea: Infinity }, { nextActionAt: '2026-02-30T12:00' }]) {
  const state = fixture(); let writes = 0;
  assert.equal(useCases(state, () => { writes++; }).execute({ action: 'create', projectId: state.project.id, draft: { ...draft(), ...invalid } }).ok, false); assert.equal(writes, 0);
 }
 const state = fixture();
 for (const role of ['foreman', 'client'] as const) assert.equal(useCases(state, undefined, role).execute({ action: 'create', projectId: state.project.id, draft: draft() }).ok, false);
 assert.equal(useCases(state).execute({ action: 'create', projectId: 'other', draft: draft() }).ok, false);
});
test('step 2: qualifying a lead preserves identity and no-op makes no write', () => {
 const state = fixture(), expected = leadSnapshot(state, 'existing');
 const result = useCases(state).execute({ action: 'qualify', leadId: 'existing', expected, patch: { landStatus: 'owned', mortgageStatus: 'approved' } });
 assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 const next = result.change.state; assert.equal(next.leads[0].id, 'existing'); assert.equal(next.leads[0].landStatus, 'owned'); assert.equal(next.leads[0].mortgageStatus, 'approved'); assert.equal(next.leads[0].stage, 'new');
 let writes = 0; const repeat = useCases(next, () => { writes++; }).execute({ action: 'qualify', leadId: 'existing', expected: leadSnapshot(next, 'existing'), patch: { landStatus: 'owned' } }); assert.ok(repeat.ok); if (repeat.ok) assert.equal(repeat.change, null); assert.equal(writes, 0);
 assert.equal(useCases(next).execute({ action: 'qualify', leadId: 'existing', expected, patch: { landStatus: 'owned' } }).ok, false);
});
test('step 3: forward progression stops at won/lost while explicit selection can reopen a lead', () => {
 let state = fixture();
 for (const stage of ['qualified', 'site_visit', 'estimate', 'negotiation', 'won']) { const result = useCases(state).execute({ action: 'stage', leadId: 'existing', expected: leadSnapshot(state, 'existing') }); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return; state = result.change.state; assert.equal(state.leads[0].stage, stage); }
 const terminal = useCases(state).execute({ action: 'stage', leadId: 'existing', expected: leadSnapshot(state, 'existing') }); assert.ok(terminal.ok); if (terminal.ok) assert.equal(terminal.change, null);
 const lost = useCases(state).execute({ action: 'stage', leadId: 'existing', expected: leadSnapshot(state, 'existing'), stage: 'lost' }); assert.ok(lost.ok && lost.change); if (!lost.ok || !lost.change) return;
 const noAdvance = useCases(lost.change.state).execute({ action: 'stage', leadId: 'existing', expected: leadSnapshot(lost.change.state, 'existing') }); assert.ok(noAdvance.ok); if (noAdvance.ok) assert.equal(noAdvance.change, null);
 const reopened = useCases(state).execute({ action: 'stage', leadId: 'existing', expected: leadSnapshot(state, 'existing'), stage: 'qualified' }); assert.ok(reopened.ok && reopened.change);
});
const incoming = () => ({ id: 'web-1', name: 'Клиент сайта', phone: '+7 002', created_at: clock.now(), source: 'unknown', message: 'Дом' });
test('step 4: import deduplicates both existing and repeated records and preserves latest edits', () => {
 const state = fixture(), response = { leads: [incoming(), incoming(), { ...incoming(), id: 'existing' }] };
 state.leads[0].notes = 'Свежая заметка'; state.activity.unshift({ id: 'latest', actor: 'Другой', text: 'Изменение', timestamp: clock.now(), tone: 'neutral' });
 const result = useCases(state).execute({ action: 'import', projectId: state.project.id, response }); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 const next = result.change.state; assert.equal(next.leads.length, 2); assert.equal(next.leads[0].source, 'website'); assert.equal(next.leads[1].notes, 'Свежая заметка'); assert.equal(next.activity[1].id, 'latest'); assert.equal(next.activity[0].actor, 'ИКИОМА ОС');
 let writes = 0; const repeat = useCases(next, () => { writes++; }).execute({ action: 'import', projectId: next.project.id, response }); assert.ok(repeat.ok); if (repeat.ok) assert.equal(repeat.change, null); assert.equal(writes, 0);
});
test('step 4: malformed response fails atomically and another project cannot receive it', () => {
 for (const response of [null, {}, { leads: [incoming(), null] }, { leads: [{ ...incoming(), phone: {} }] }, { leads: [{ ...incoming(), created_at: '2026-02-30' }] }]) { const state = fixture(), before = structuredClone(state); assert.equal(useCases(state).execute({ action: 'import', projectId: state.project.id, response }).ok, false); assert.deepEqual(state, before); }
 const state = fixture(); assert.equal(useCases(state).execute({ action: 'import', projectId: 'other', response: { leads: [incoming()] } }).ok, false);
});
test('all existing lead commands reject missing/stale cross-project records', () => { const state = fixture(), expected = leadSnapshot(state, 'existing'); state.project.id = 'other'; assert.equal(useCases(state).execute({ action: 'stage', leadId: 'existing', expected }).ok, false); state.leads = []; assert.equal(useCases(state).execute({ action: 'qualify', leadId: 'existing', expected, patch: { landStatus: 'owned' } }).ok, false); });
test('UI has explicit commands, cancellable import, latest-snapshot access and error feedback', () => { const page = readFileSync(new URL('../src/pages/MarketingPage.tsx', import.meta.url), 'utf8'); assert.doesNotMatch(page, /createMarketingCommands|saveChange\(|leads:|activity:|uid\(/); assert.match(page, /latest\.current\.execute/); assert.match(page, /controller\.abort\(\)/); assert.match(page, /response\.ok/); assert.match(page, /Повторить загрузку заявок/); });
