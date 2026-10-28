import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import type { AppState, Stage } from '../src/entities/index.ts';
import { forecastSchedule, schedulePayload, simulateSchedule } from '../src/domain/construction/schedule-forecast.js';
import { automaticSchedule } from '../src/domain/construction/automatic-schedule.js';
import { validateScheduleReview } from '../src/domain/construction/schedule-validation.js';
import { stageCanStart } from '../src/domain/construction/stage-control.js';
const today = '2026-09-09', now = `${today}T12:00:00Z`, owner = { role: 'management', name: 'Управление', id: 'owner' };
const work = (id: string, days = 1): Stage => ({
  id, name: id, shortName: id, order: 1, status: 'not_ready', weight: 1, progress: 0, responsible: 'Бригада', planStart: today, planEnd: '2026-09-14', forecastEnd: '2026-09-14',
  schedule: { kind: 'work', phase: 'Этап', summaryOf: [], dependencies: [], calendar: 'daily', daysOff: [], crew: id, reporterId: '' },
  siteUpdate: { asOf: today, reviewOn: '2026-09-16', remainingDays: days, readyOn: today, acceptanceOn: '', note: 'Остаток проверен', nextAction: '', issueOwner: '', requestId: crypto.randomUUID() },
});
const link = (stage: Stage, id: string, type: 'FS' | 'SS' | 'FF' = 'FS', lagDays = 0, gate: 'completed' | 'accepted' = 'completed') => { stage.schedule!.dependencies.push({ stageId: id, type, lagDays, gate }); };
const fixture = (...stages: Stage[]): AppState => {
  const state = structuredClone(seedState); state.stages = stages; state.tasks = []; state.checkpoints = [];
  assert.equal(validateScheduleReview(null, state, owner, now), null); return state;
};
const recheck = (stage: Stage) => { stage.siteUpdate!.confirmedSchedule = JSON.stringify(schedulePayload(stage.schedule)); };
const row = (view: ReturnType<typeof forecastSchedule>, id: string) => view.rows.find(item => item.id === id)!;

test('CPM parallel graph gives different total/free float and preserves the critical chain', () => {
  const a = work('a', 4), b = work('b'), c = work('c'), d = work('d'); link(c, 'b'); link(d, 'a'); link(d, 'c');
  const state = fixture(d, c, b, a), original = structuredClone(state), view = forecastSchedule(state, today);
  assert.deepEqual(view.issues, []); assert.equal(view.end, '2026-09-14'); assert.equal(view.cpmComplete, true);
  assert.deepEqual(new Set(view.criticalIds), new Set(['a', 'd']));
  assert.deepEqual([row(view, 'b').totalFloatDays, row(view, 'b').freeFloatDays, row(view, 'b').latestStart], [2, 0, '2026-09-12']);
  assert.deepEqual([row(view, 'c').totalFloatDays, row(view, 'c').freeFloatDays], [2, 2]);
  assert.equal(simulateSchedule(state, { stageId: 'b', remainingDays: 3 }, today).gainedDays, 0);
  assert.equal(simulateSchedule(state, { stageId: 'b', remainingDays: 4 }, today).gainedDays, -1);
  assert.deepEqual(state, original);
});

test('FS stays legacy-compatible while SS, FF and negative lead overlap work correctly', () => {
  const a = work('a', 5), fs = work('fs', 2), ss = work('ss', 2), ff = work('ff', 2), lead = work('lead', 2);
  fs.schedule!.dependencies = [{ stageId: 'a', gate: 'completed', lagDays: 0 }];
  link(ss, 'a', 'SS', 1); link(ff, 'a', 'FF', 1); link(lead, 'a', 'FS', -2);
  const state = fixture(a, fs, ss, ff, lead), view = forecastSchedule(state, today);
  assert.deepEqual(view.issues, []); assert.equal(row(view, 'fs').start, '2026-09-15');
  assert.equal(row(view, 'ss').start, '2026-09-11'); assert.equal(row(view, 'ff').end, '2026-09-15');
  assert.equal(row(view, 'lead').start, '2026-09-13');
  const auto = automaticSchedule(state, today); assert.equal(auto.end, view.end);
  for (const result of view.rows) assert.deepEqual([auto.rows.find(r => r.id === result.id)?.start, auto.rows.find(r => r.id === result.id)?.end], [result.start, result.end]);
});

test('SS and FF backward constraints drive different endpoints', () => {
  const a = work('a', 2), b = work('b', 6), c = work('c', 2); link(b, 'a', 'SS', 2); link(c, 'a', 'FF', 1);
  const view = forecastSchedule(fixture(a, b, c), today);
  assert.equal(view.end, '2026-09-17'); assert.equal(row(view, 'a').totalFloatDays, 0);
  assert.equal(row(view, 'c').totalFloatDays, 5); assert.deepEqual(new Set(view.criticalIds), new Set(['a', 'b']));
});

test('backward pass honors weekends and explicit holidays, floats are calendar days', () => {
  const long = work('long', 7), short = work('short', 2); short.schedule!.calendar = 'weekdays'; short.schedule!.daysOff = ['2026-09-15'];
  const view = forecastSchedule(fixture(long, short), today);
  assert.equal(view.end, '2026-09-16'); assert.deepEqual(row(view, 'short').workDates, ['2026-09-10', '2026-09-11']);
  assert.deepEqual([row(view, 'short').latestStart, row(view, 'short').latestEnd, row(view, 'short').totalFloatDays, row(view, 'short').freeFloatDays], ['2026-09-14', '2026-09-16', 4, 4]);
  const before = work('before', 3), finish = work('finish', 2); finish.schedule!.calendar = 'weekdays'; link(finish, 'before', 'FF', 0);
  assert.deepEqual(row(forecastSchedule(fixture(before, finish), today), 'finish').workDates, ['2026-09-11', '2026-09-14']);
});

test('acceptance is an explicit fixed milestone and never permits negative lead or SS', () => {
  for (const [type, lag] of [['SS', 0], ['FS', -1], ['FF', -1]] as const) {
    const a = work('a'), b = work('b'); link(b, 'a', type, lag, 'accepted');
    const state = structuredClone(seedState); state.stages = [a, b];
    assert.match(validateScheduleReview(null, state, owner, now)!, /Приёмка допускает/);
  }
  const a = work('a'), b = work('b', 2); a.siteUpdate!.acceptanceOn = '2026-09-14'; link(b, 'a', 'FF', 0, 'accepted');
  const state = fixture(a, b), view = forecastSchedule(state, today);
  assert.equal(row(view, 'b').end, '2026-09-14'); assert.equal(row(view, 'a').totalFloatDays, 4);
  assert.equal(stageCanStart(state, state.stages[1]), true); // FF restricts finish, not start.
  state.stages[1].schedule!.dependencies[0].type = 'FS'; recheck(state.stages[1]);
  assert.equal(stageCanStart(state, state.stages[1]), false); // Forecast acceptance never becomes actual permission.
});

test('incomplete observations and crew conflicts never expose numerical reserves', () => {
  const state = fixture(work('a', 3), work('b'));
  for (const mutate of [(s: AppState) => { s.stages[1].schedule!.crew = 'a'; recheck(s.stages[1]); }, (s: AppState) => { s.stages[1].siteUpdate!.reviewOn = '2026-09-08'; }]) {
    const next = structuredClone(state); mutate(next); const view = forecastSchedule(next, today);
    assert.equal(view.end, null); assert.equal(view.cpmComplete, false); assert.deepEqual(view.criticalIds, []);
    assert.ok(view.rows.every(item => item.totalFloatDays === null && item.freeFloatDays === null));
  }
});

test('fixed actual starts control SS and facts never gain movable float', () => {
  const a = work('a', 2), b = work('b', 3); a.status = 'in_progress'; a.actualStart = '2026-09-07'; link(b, 'a', 'SS', 4);
  const state = fixture(a, b), view = forecastSchedule(state, today);
  assert.equal(row(view, 'b').start, '2026-09-11'); assert.equal(view.end, '2026-09-13');
  const completed = work('completed'), successor = work('successor'); completed.status = 'awaiting_inspection'; completed.completedOn = today; completed.siteUpdate!.remainingDays = null; link(successor, 'completed', 'SS');
  const unknown = fixture(completed, successor); assert.equal(forecastSchedule(unknown, today).end, null);
  assert.ok(forecastSchedule(unknown, today).issues.some(issue => issue.code === 'dependency_start'));
  unknown.stages[0].actualStart = '2026-09-06'; const facts = forecastSchedule(unknown, today);
  assert.equal(row(facts, 'completed').end, today); assert.equal(row(facts, 'completed').totalFloatDays, null);
});

test('server rejects cycles for completed facts and enforces management for new dependency edits', () => {
  const a = work('a'), b = work('b'); const state = fixture(a, b), next = structuredClone(state); link(next.stages[1], 'a', 'SS');
  assert.match(validateScheduleReview(state, next, { role: 'foreman', name: 'Прораб', id: 'worker' }, now)!, /управление/);
  assert.equal(validateScheduleReview(state, structuredClone(next), owner, now), null);
  const cycle = structuredClone(state); for (const stage of cycle.stages) { stage.status = 'awaiting_inspection'; stage.completedOn = today; }
  link(cycle.stages[0], 'b'); link(cycle.stages[1], 'a');
  const view = forecastSchedule(cycle, today); assert.equal(view.end, null); assert.ok(view.issues.some(issue => issue.code === 'cycle'));
  assert.match(validateScheduleReview(state, cycle, owner, now)!, /цикл/);
});


test('a completed FF successor retains its fact but contradicting relation blocks CPM', () => {
  const a = work('a'), b = work('b'); const state = fixture(a, b);
  const successor = state.stages[1]; successor.status = 'awaiting_inspection'; successor.completedOn = today;
  link(successor, 'a', 'FF', 1); recheck(successor);
  const view = forecastSchedule(state, today);
  assert.equal(row(view, 'b').end, today); assert.equal(view.end, null);
  assert.ok(view.issues.some(issue => issue.code === 'dependency_fact'));
  assert.equal(row(view, 'b').totalFloatDays, null); assert.equal(successor.completedOn, today);
});


test('a fixed completed FF successor with lead still bounds predecessor float', () => {
  const a = work('a'), b = work('b'), long = work('long', 5); b.status = 'awaiting_inspection'; b.completedOn = today; b.siteUpdate!.remainingDays = null;
  link(b, 'a', 'FF', -2); const state = fixture(a, b, long), view = forecastSchedule(state, today);
  assert.deepEqual(view.issues, []); assert.equal(view.end, '2026-09-14');
  assert.equal(row(view, 'a').latestEnd, '2026-09-11'); assert.equal(row(view, 'a').totalFloatDays, 1);
  assert.equal(row(view, 'b').end, today); assert.equal(row(view, 'b').totalFloatDays, null);
});
