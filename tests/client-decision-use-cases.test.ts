import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { seedState } from '../src/seed.ts';
import { clientDecisionOptions, clientDecisionSnapshot } from '../src/domain/client-decisions.ts';
import { createClientDecisionUseCases } from '../src/application/client-decisions.ts';
const now = '2026-10-20T12:00:00Z', clock = { now: () => now }, ids = { next: (prefix: string) => `${prefix}-test` };
const fixture = () => { const state = structuredClone(seedState); state.decisions = [{ id: 'decision-1', title: 'Цвет фасада', status: 'waiting', dueDate: '2026-11-01' }, { id: 'other', title: 'Другой вопрос', status: 'waiting', dueDate: '2026-11-02' }]; return state; };
const input = (state: ReturnType<typeof fixture>) => ({ decisionId: 'decision-1', expected: clientDecisionSnapshot(state, 'decision-1'), choice: 'Терракота' });
const commands = (state: ReturnType<typeof fixture>, role: 'client' | 'management' | 'foreman' = 'client', sink = (_next: ReturnType<typeof fixture>) => {}) => createClientDecisionUseCases(state, { name: 'Участник сессии', role }, clock, ids, sink);
test('confirmation changes only the target decision, preserves facts and audits the session actor', () => {
 const state = fixture(), before = structuredClone(state); let writes = 0;
 const result = commands(state, 'client', () => { writes++; }).confirm(input(state)); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.deepEqual(state, before); assert.equal(writes, 1);
 const next = result.change.state; assert.equal(next.decisions[0].status, 'decided'); assert.equal(next.decisions[0].choice, 'Терракота'); assert.deepEqual(next.decisions[1], state.decisions[1]); assert.deepEqual(next.financeEntries, state.financeEntries); assert.deepEqual(next.stages, state.stages); assert.deepEqual(next.checkpoints, state.checkpoints); assert.equal(result.change.action, 'client_decision_updated'); assert.equal(next.activity[0].actor, 'Участник сессии'); assert.equal(next.activity[0].timestamp, now);
});
test('foreman and unsupported variants cannot confirm or write audit', () => {
 const state = fixture(); assert.equal(commands(state, 'foreman').confirm(input(state)).ok, false);
 for (const choice of ['', ' ', 'Вариант A', 'Непредусмотренный вариант']) { let writes = 0; assert.equal(commands(state, 'client', () => { writes++; }).confirm({ ...input(state), choice }).ok, false); assert.equal(writes, 0); }
 assert.ok(commands(state, 'management').confirm(input(state)).ok);
});
test('changed question, deleted decision and switched project require reopening the form', () => {
 for (const mutate of [(state: ReturnType<typeof fixture>) => { state.decisions[0].title = 'Другой вопрос'; }, (state: ReturnType<typeof fixture>) => { state.decisions = []; }, (state: ReturnType<typeof fixture>) => { state.project.id = 'other'; }]) { const state = fixture(), command = input(state); mutate(state); const before = structuredClone(state); assert.equal(commands(state).confirm(command).ok, false); assert.deepEqual(state, before); }
});
test('same confirmed choice is a no-op and another choice cannot rewrite it', () => {
 const state = fixture(), first = commands(state).confirm(input(state)); assert.ok(first.ok && first.change); if (!first.ok || !first.change) return;
 const next = first.change.state; let writes = 0;
 const repeat = commands(next, 'client', () => { writes++; }).confirm(input(next)); assert.ok(repeat.ok); if (repeat.ok) assert.equal(repeat.change, null); assert.equal(writes, 0);
 assert.equal(commands(next).confirm({ ...input(next), choice: 'Графит' }).ok, false);
});
test('unrelated activity and other decisions are preserved from the latest snapshot', () => {
 const state = fixture(), command = input(state); state.decisions[1].choice = 'Вариант B'; state.activity.unshift({ id: 'latest', actor: 'Другой', text: 'Обновление', timestamp: now, tone: 'neutral' });
 const result = commands(state).confirm(command); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.equal(result.change.state.activity[1].id, 'latest'); assert.equal(result.change.state.decisions[1].choice, 'Вариант B');
});
test('legacy generic decision choices remain available without fabricated acceptance facts', () => {
 const state = fixture(), result = commands(state).confirm({ decisionId: 'other', expected: clientDecisionSnapshot(state, 'other'), choice: 'Нужна консультация' }); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.equal(result.change.state.decisions[1].choice, 'Нужна консультация'); assert.deepEqual(result.change.state.documents, state.documents); assert.ok(clientDecisionOptions('other').includes('Вариант B'));
});
test('page delegates decisions and uses session identity rather than the project client label', () => {
 const page = readFileSync(new URL('../src/pages/ClientPage.tsx', import.meta.url), 'utf8'); assert.match(page, /decisions\.confirm/); assert.match(page, /decisionError && <p role="alert"/); assert.doesNotMatch(page, /createClientDecisionCommands|saveChange\(|decisions:|activity:|uid\(/);
});
