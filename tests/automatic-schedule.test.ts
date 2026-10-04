import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticSchedule, plannedStageDays } from '../sites/lib/automatic-schedule.js';
import { schedulePayload } from '../sites/lib/schedule-forecast.js';

const today = '2026-02-10';
const stage = (id, start = '2026-01-01', end = '2026-01-05') => ({ id, order: 1, name: id, shortName: id, status: 'not_ready', planStart: start, planEnd: end, baseline: { start, end }, progress: 0 });
const state = (...stages) => ({ project: { targetDate: '2026-02-01' }, stages, tasks: [{ status: 'in_progress' }], financeEntries: [{ amount: 17 }] });
const structure = (dependencies = [], crew = '') => ({ kind: 'work', phase: 'Structure', calendar: 'daily', daysOff: [], summaryOf: [], dependencies, crew, reporterId: '', updatedAt: '2026-02-10T00:00:00Z' });
const update = (row, remainingDays, overrides = {}) => {
  row.siteUpdate = { asOf: '2026-02-09', reviewOn: '2026-02-15', remainingDays, readyOn: today, acceptanceOn: '', updatedAt: '2026-02-10T00:00:00Z', confirmedStatus: row.status, confirmedBlocker: row.blocker || '', confirmedFacts: JSON.stringify([row.actualStart || '', row.completedOn || '', row.actualEnd || '', row.acceptedAt || '']), confirmedSchedule: JSON.stringify(schedulePayload(row.schedule)), ...overrides };
};

test('automatic plan preserves parallel dates and includes today exactly once', () => {
  const input = state(stage('a'), stage('b')), before = structuredClone(input);
  const result = automaticSchedule(input, today);
  assert.equal(result.kind, 'estimated'); assert.equal(result.end, '2026-02-14');
  assert.equal(result.remainingDays, 5); assert.equal(result.remainingStages, 2);
  assert.deepEqual(result.rows.map(row => row.remainingDays), [5, 5]);
  assert.deepEqual(input, before);
  assert.equal(automaticSchedule(input, '2026-02-11').end, '2026-02-15');
});

test('plan sequence retains gaps; explicit dependency overrides overlapping intervals', () => {
  const a = stage('a'), b = stage('b', '2026-01-07', '2026-01-09');
  const planned = automaticSchedule(state(a, b), today);
  assert.equal(planned.rows.find(row => row.id === 'b').start, '2026-02-16');
  assert.equal(planned.end, '2026-02-18');
  const c = stage('c'); c.dependencyId = 'a';
  assert.equal(automaticSchedule(state(a, c), today).end, '2026-02-19');
});

test('completed work has no remaining duration even when exact dates are unknown', () => {
  const a = stage('a'); a.status = 'accepted'; a.completionObservedOn = today; a.ownerAcceptance = { note: 'Confirmed' };
  const b = stage('b', '2026-01-07', '2026-01-09');
  const input = state(a, b), original = structuredClone(input), result = automaticSchedule(input, today);
  assert.equal(result.end, '2026-02-12'); assert.equal(result.remainingDays, 3);
  assert.equal(result.rows.find(row => row.id === 'a').source, 'observation');
  assert.equal(result.remainingStages, 1); assert.deepEqual(input, original);
  b.status = 'awaiting_inspection'; b.completionObservedOn = today;
  const done = automaticSchedule(input, today);
  assert.equal(done.kind, 'observed'); assert.equal(done.remainingDays, 0);
  assert.equal(b.completedOn, undefined);
});

test('known actual dates yield an actual PPR finish, not a fake future forecast', () => {
  const a = stage('a'); a.status = 'accepted'; a.completedOn = '2026-02-08';
  const result = automaticSchedule(state(a), today);
  assert.equal(result.kind, 'actual'); assert.equal(result.end, '2026-02-08'); assert.equal(result.remainingDays, 0);
  a.completedOn = '2026-02-11'; assert.equal(automaticSchedule(state(a), today).end, null);
});

test('calendars skip weekends and explicit days off; partial progress does not invent remaining work', () => {
  const a = stage('a', '2026-02-02', '2026-02-08');
  a.schedule = { ...structure([], 'Crew A'), calendar: 'weekdays', daysOff: ['2026-02-13'] }; a.progress = 80;
  assert.equal(plannedStageDays(a), 5);
  const result = automaticSchedule(state(a), '2026-02-12');
  assert.equal(result.end, '2026-02-19');
  assert.equal(result.rows[0].remainingDays, 5);
  assert.equal(plannedStageDays(stage('one', today, today)), 1);
});

test('fresh confirmed remainder takes precedence; expiry falls back with explicit assumptions', () => {
  const a = stage('a'); a.schedule = structure([], 'Crew A'); update(a, 2);
  const fresh = automaticSchedule(state(a), today);
  assert.equal(fresh.kind, 'confirmed'); assert.equal(fresh.end, '2026-02-11');
  const expired = automaticSchedule(state(a), '2026-02-17');
  assert.equal(expired.kind, 'estimated'); assert.equal(expired.end, '2026-02-21');
  assert.ok(expired.notes.some(note => note.includes('полную длительность')));
});

test('unknown delays, missing durations, dependency cycles and crew collisions block a date', () => {
  const a = stage('a'); a.blocker = 'Delivery unknown';
  assert.equal(automaticSchedule(state(a), today).end, null);
  delete a.blocker; a.planEnd = ''; assert.equal(automaticSchedule(state(a), today).end, null);
  const b = stage('b'), c = stage('c'); b.dependencyId = 'c'; c.dependencyId = 'b';
  assert.equal(automaticSchedule(state(b, c), today).end, null);
  delete b.dependencyId; delete c.dependencyId; b.schedule = structure([], 'Same crew'); c.schedule = structure([], 'Same crew');
  assert.ok(automaticSchedule(state(b, c), today).issues.some(issue => issue.message.includes('бригада')));
  c.schedule.crew = 'Other crew'; assert.equal(automaticSchedule(state(b, c), today).end, '2026-02-14');
});

test('explicit acceptance gates remain real gates and owner confirmation unlocks them', () => {
  const a = stage('a'); a.status = 'awaiting_inspection'; a.completionObservedOn = '2026-02-09';
  const b = stage('b'); b.schedule = structure([{ stageId: 'a', gate: 'accepted', lagDays: 1 }], 'Crew B');
  assert.equal(automaticSchedule(state(a, b), today).end, null);
  a.status = 'accepted'; a.acceptedAt = '2026-02-09T23:30:00Z';
  const result = automaticSchedule(state(a, b), today);
  assert.equal(result.rows.find(row => row.id === 'b').start, '2026-02-12');
  a.acceptedAt = '2026-03-01T00:00:00Z';
  assert.equal(automaticSchedule(state(a, b), today).end, null);
});

test('fresh future availability is respected and no duration is inferred from a percentage', () => {
  const a = stage('a'); a.blocker = 'Waiting'; a.schedule = structure([], 'Crew A');
  update(a, 2, { readyOn: '2026-02-15', nextAction: 'Receive', issueOwner: 'Owner' });
  assert.equal(automaticSchedule(state(a), today).end, '2026-02-16');
  a.siteUpdate.readyOn = '2026-02-01'; assert.equal(automaticSchedule(state(a), today).end, null);
});

test('summary duration is not counted again and missing house works stay visible', () => {
  const a = stage('a'); a.name = '3. Монтаж окон ПВХ';
  const summary = stage('total'); summary.schedule = { ...structure(), kind: 'summary', summaryOf: ['a'] };
  const input = state(a, summary); input.project.siteProgressHistory = [{ remaining: ['Монтаж окон', 'Инженерные системы', 'Внутренняя отделка'] }];
  const result = automaticSchedule(input, today);
  assert.equal(result.remainingStages, 1); assert.equal(result.end, '2026-02-14');
  assert.deepEqual(result.unmappedWork, ['Инженерные системы', 'Внутренняя отделка']);
  assert.equal(automaticSchedule(state(), today).end, null);
});
