import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import type { AppState, Stage, StageSchedule } from '../src/entities/index.ts';
import { confirmedSiteUpdate, forecastSchedule, schedulePayload, simulateSchedule } from '../sites/lib/schedule-forecast.js';
import { validateScheduleReview } from '../sites/projects/schedule-review.js';
import { validateStageControl } from '../sites/projects/stage-control.js';
import { validateBaselineChanges } from '../sites/projects/baseline.js';
import { createSyncModel, reconcileSavedSnapshot } from '../src/application/project-sync.ts';
import { applyStageControl } from '../src/application/stage-control.ts';
import { stageCanStart } from '../sites/lib/stage-control.js';
import { createProjectWriteHandler } from '../sites/projects/write.js';
import { createTelegramProjectStore } from '../sites/telegram/project-store.js';

const today = '2026-09-09', now = `${today}T12:00:00Z`, owner = { role: 'management', name: 'Управление', id: 'owner' };
const worker = { role: 'foreman', name: 'Ответственный', id: 'worker' };
const structure = (id: string): StageSchedule => ({ kind: 'work', phase: 'Фундамент', summaryOf: [], dependencies: [], calendar: 'daily', daysOff: [], crew: id, reporterId: 'worker' });
const makeStage = (id: string, days = 2): Stage => ({
  id, name: `Работа ${id}`, shortName: id, order: 1, status: 'not_ready', weight: 1, progress: 0, responsible: 'Подрядчик',
  planStart: today, planEnd: '2026-09-10', forecastEnd: '2026-09-10',
  baseline: { start: today, end: '2026-09-10', source: 'document', note: 'Исходный ППР', recordedAt: now, recordedBy: owner.name },
  schedule: structure(id), siteUpdate: { asOf: today, reviewOn: '2026-09-16', remainingDays: days, readyOn: today, acceptanceOn: '', note: 'Остаток проверен на объекте', nextAction: '', issueOwner: '', requestId: crypto.randomUUID() },
});
const fixture = (...stages: Stage[]): AppState => {
  const state = structuredClone(seedState); state.stages = stages; state.tasks = []; state.checkpoints = [];
  state.settings.users = [{ id: 'worker', role: 'foreman', name: worker.name, email: 'worker@test.local', status: 'active' }];
  return state;
};
const confirm = (state: AppState, at = now) => { const next = structuredClone(state); assert.equal(validateScheduleReview(null, next, owner, at), null); return next; };
const refreshSnapshots = (stage: Stage) => {
  stage.siteUpdate!.confirmedStatus = stage.status; stage.siteUpdate!.confirmedBlocker = stage.blocker || '';
  stage.siteUpdate!.confirmedFacts = JSON.stringify([stage.actualStart || '', stage.completedOn || '', stage.actualEnd || '', stage.acceptedAt || '']);
  stage.siteUpdate!.confirmedSchedule = JSON.stringify(schedulePayload(stage.schedule));
};

test('forecast uses remaining work after the end-of-day cut, FS+0, and same-milestone delta', () => {
  const a = makeStage('a'), b = makeStage('b', 3); b.schedule!.dependencies = [{ stageId: 'a', gate: 'completed', lagDays: 0 }];
  const state = confirm(fixture(a, b)), before = structuredClone(state), view = forecastSchedule(state, today);
  assert.deepEqual(view.issues, []); assert.equal(view.rows[0].start, '2026-09-10'); assert.equal(view.rows[0].end, '2026-09-11');
  assert.equal(view.end, '2026-09-14'); assert.equal(view.baselineShift, 4); assert.deepEqual(new Set(view.criticalIds), new Set(['a', 'b']));
  assert.deepEqual(state, before);
});

test('work calendars and explicit days off count inclusively, not as elapsed calendar duration', () => {
  const a = makeStage('a', 2); a.siteUpdate!.asOf = '2026-09-11'; a.siteUpdate!.reviewOn = '2026-09-18'; a.schedule!.calendar = 'weekdays'; a.schedule!.daysOff = ['2026-09-15'];
  const state = confirm(fixture(a), '2026-09-11T12:00:00Z');
  assert.deepEqual(forecastSchedule(state, '2026-09-11').rows[0].workDates, ['2026-09-14', '2026-09-16']);
  state.stages[0].schedule!.calendar = 'six-day'; refreshSnapshots(state.stages[0]);
  assert.deepEqual(forecastSchedule(state, '2026-09-11').rows[0].workDates, ['2026-09-12', '2026-09-14']);
});

test('completed work needs facts, not a remaining duration; acceptance is a distinct gate', () => {
  const a = makeStage('a'); a.status = 'awaiting_inspection'; a.completedOn = today; a.siteUpdate!.remainingDays = null;
  const b = makeStage('b', 1); b.schedule!.dependencies = [{ stageId: 'a', gate: 'accepted', lagDays: 0 }];
  const state = confirm(fixture(a, b)); assert.equal(forecastSchedule(state, today).end, null);
  assert.ok(forecastSchedule(state, today).issues.some((i) => i.code === 'acceptance'));
  state.stages[0].siteUpdate!.acceptanceOn = '2026-09-11';
  assert.equal(forecastSchedule(state, today).end, '2026-09-12');
  state.stages[1].schedule!.dependencies[0].gate = 'completed'; refreshSnapshots(state.stages[1]);
  assert.equal(forecastSchedule(state, today).end, '2026-09-10');
});

test('acceptance timestamps use the project Moscow day, including UTC midnight boundary', () => {
  const a = makeStage('a'); a.status = 'accepted'; a.completedOn = '2026-09-11'; a.actualEnd = a.completedOn; a.acceptedAt = '2026-09-11T23:30:00Z'; a.siteUpdate = undefined;
  const b = makeStage('b', 1); b.siteUpdate!.asOf = '2026-09-12'; b.siteUpdate!.reviewOn = '2026-09-19'; b.schedule!.dependencies = [{ stageId: 'a', gate: 'accepted', lagDays: 0 }];
  const state = confirm(fixture(a, b), '2026-09-12T12:00:00Z');
  assert.equal(forecastSchedule(state, '2026-09-12').end, '2026-09-13');
});

test('parallel crew conflict blocks the date instead of inventing an order', () => {
  const a = makeStage('a'), b = makeStage('b'); b.schedule!.crew = ' A ';
  const view = forecastSchedule(confirm(fixture(a, b)), today);
  assert.equal(view.end, null); assert.equal(view.issues.filter((i) => i.code === 'resource').length, 2);
});

test('missing, stale, pending, contradictory or cyclic data cannot claim a forecast', () => {
  const base = confirm(fixture(makeStage('a')));
  for (const mutate of [
    (s: Stage) => { s.schedule = undefined; },
    (s: Stage) => { s.siteUpdate!.reviewOn = '2026-09-08'; },
    (s: Stage) => { s.siteUpdate!.requestId = 'pending-save'; },
    (s: Stage) => { s.siteUpdate!.remainingDays = 0; },
    (s: Stage) => { s.status = 'in_progress'; },
    (s: Stage) => { s.siteUpdate!.asOf = '2026-08-01'; },
    (s: Stage) => { s.schedule!.dependencies = [{ stageId: 'a', gate: 'completed', lagDays: 0 }]; refreshSnapshots(s); },
  ]) { const state = structuredClone(base); mutate(state.stages[0]); assert.equal(forecastSchedule(state, today).end, null); }
  assert.equal(forecastSchedule(fixture(), today).end, null);
});

test('an unstarted or blocked row cannot silently consume days before an unconfirmed start', () => {
  const state = confirm(fixture(makeStage('a', 10)));
  assert.ok(forecastSchedule(state, '2026-09-14').issues.some((i) => i.code === 'start_unconfirmed'));
  const row = state.stages[0]; row.status = 'in_progress'; row.actualStart = today; refreshSnapshots(row);
  assert.equal(forecastSchedule(state, '2026-09-14').end, '2026-09-19');
  row.blocker = 'Нет материала'; row.siteUpdate!.nextAction = 'Получить поставку'; row.siteUpdate!.issueOwner = 'Снабжение'; refreshSnapshots(row);
  assert.equal(forecastSchedule(state, '2026-09-14').end, null);
});

test('summary rows aggregate without double counting or hiding conflicting completion facts', () => {
  const a = makeStage('a', 2), b = makeStage('b', 4), summary = makeStage('summary'); summary.schedule!.kind = 'summary'; summary.schedule!.summaryOf = ['a', 'b']; summary.siteUpdate = undefined;
  const state = confirm(fixture(a, b, summary)), view = forecastSchedule(state, today);
  assert.equal(view.total, 2); assert.equal(view.end, '2026-09-13'); assert.equal(view.rows.find((r) => r.id === 'summary')?.end, '2026-09-13');
  state.stages[2].status = 'awaiting_inspection'; state.stages[2].completedOn = today;
  assert.ok(forecastSchedule(state, today).issues.some((i) => i.code === 'summary_fact'));
});

test('actual finish stays available without old remaining confirmation; unknown baseline is not zero delay', () => {
  const a = makeStage('a'); a.status = 'accepted'; a.completedOn = today; a.actualEnd = today; a.baseline = undefined; a.siteUpdate = undefined;
  const view = forecastSchedule(confirm(fixture(a)), today);
  assert.equal(view.kind, 'actual'); assert.equal(view.end, today); assert.equal(view.baselineShift, null);
});

test('a scenario can gain zero days on parallel chains and never mutates facts, baseline or money', () => {
  const state = confirm(fixture(makeStage('a', 4), makeStage('b', 4))), before = structuredClone(state);
  const result = simulateSchedule(state, { stageId: 'a', remainingDays: 1 }, today);
  assert.equal(result.forecast?.end, '2026-09-13'); assert.equal(result.gainedDays, 0); assert.deepEqual(state, before);
  assert.equal(simulateSchedule(state, { stageId: 'a', remainingDays: 2, crew: 'b' }, today).forecast?.end, null);
});

test('server alone stamps confirmations, preserves old-client omissions, and rejects deletion or forged stamps', () => {
  const base = confirm(fixture(makeStage('a'))), old = structuredClone(base); delete old.stages[0].schedule; delete old.stages[0].siteUpdate; delete old.stages[0].scheduleHistory;
  assert.equal(validateScheduleReview(base, old, worker, now), null); assert.deepEqual(old, base);
  const forged = structuredClone(base); forged.stages[0].siteUpdate!.updatedBy = 'Подмена'; forged.stages[0].schedule!.updatedBy = 'Подмена'; forged.stages[0].scheduleHistory = [];
  assert.equal(validateScheduleReview(base, forged, worker, now), null); assert.deepEqual(forged, base);
  const removed = structuredClone(base); removed.stages = []; assert.ok(validateScheduleReview(base, removed, owner, now));
  const payload = JSON.parse(JSON.stringify(base)); payload.stages[0].siteUpdate = null; assert.ok(validateScheduleReview(base, payload, owner, now));
  const replay = structuredClone(base); replay.stages[0].siteUpdate!.requestId = replay.stages[0].siteUpdate!.confirmationId;
  assert.equal(validateScheduleReview(base, replay, worker, now), null); assert.equal(replay.stages[0].scheduleHistory?.length, 2);
});

test('structure is management-only and site reports require the designated trusted user ID', () => {
  const base = confirm(fixture(makeStage('a'))), change = structuredClone(base); change.stages[0].siteUpdate!.remainingDays = 3; change.stages[0].siteUpdate!.requestId = crypto.randomUUID();
  for (const identity of [{ ...worker, id: '' }, { ...worker, id: 'someone-else' }, { ...worker, role: 'client' }]) assert.ok(validateScheduleReview(base, structuredClone(change), identity, now));
  assert.equal(validateScheduleReview(base, change, worker, now), null); assert.equal(change.stages[0].siteUpdate!.updatedBy, worker.name);
  const structureEdit = structuredClone(base); structureEdit.stages[0].schedule!.crew = 'Новая бригада';
  assert.ok(validateScheduleReview(base, structureEdit, worker, now));
  assert.equal(validateScheduleReview(base, structureEdit, owner, now), null); assert.equal(confirmedSiteUpdate(structureEdit.stages[0], today), false);
  const disabled = fixture(makeStage('a')); disabled.settings.users[0].status = 'disabled'; assert.ok(validateScheduleReview(null, disabled, owner, now));
});

test('server rejects cycles, nested/double summaries, unknown dependencies and unbounded freshness', () => {
  const a = makeStage('a'), b = makeStage('b'); a.schedule!.dependencies = [{ stageId: 'b', gate: 'completed', lagDays: 0 }]; b.schedule!.dependencies = [{ stageId: 'a', gate: 'completed', lagDays: 0 }];
  assert.ok(validateScheduleReview(null, fixture(a, b), owner, now));
  const missing = makeStage('a'); missing.schedule!.dependencies = [{ stageId: 'missing', gate: 'completed', lagDays: 0 }]; assert.ok(validateScheduleReview(null, fixture(missing), owner, now));
  const old = makeStage('old'); old.siteUpdate!.reviewOn = '2099-01-01'; assert.ok(validateScheduleReview(null, fixture(old), owner, now));
  const leaf = makeStage('leaf'), s1 = makeStage('s1'), s2 = makeStage('s2');
  for (const s of [s1, s2]) { s.schedule!.kind = 'summary'; s.schedule!.summaryOf = ['leaf']; s.siteUpdate = undefined; }
  assert.ok(validateScheduleReview(null, fixture(leaf, s1, s2), owner, now));
  s2.schedule!.summaryOf = ['s1']; assert.ok(validateScheduleReview(null, fixture(leaf, s1, s2), owner, now));
});

test('stage actions preserve new data and money; facts invalidate the old residual confirmation', () => {
  const base = confirm(fixture(makeStage('a'))), next = applyStageControl(base, 'a', 'start', { date: today, note: 'Бригада приступила', tasks: [] }, worker.name, 'foreman', 'worker');
  assert.equal(validateStageControl(base, next, worker, now), null); assert.equal(validateBaselineChanges(base, next, worker, now), null);
  assert.equal(confirmedSiteUpdate(next.stages[0], today), false); assert.deepEqual(next.financeEntries, base.financeEntries); assert.deepEqual(next.stages[0].baseline, base.stages[0].baseline);
  assert.throws(() => applyStageControl(base, 'a', 'start', { date: today, note: 'Начато', tasks: [] }, worker.name, 'foreman', 'other'));
  assert.throws(() => applyStageControl(next, 'a', 'not_started', { date: today, note: 'Не начато', tasks: [] }, worker.name, 'foreman', 'worker'));
});

test('own-save acknowledgement adopts server confirmations but preserves a second local report', () => {
  const before = fixture(makeStage('a')); before.stages[0].schedule = undefined; before.stages[0].siteUpdate = undefined;
  const sent = fixture(makeStage('a')), saved = structuredClone(sent); assert.equal(validateScheduleReview(before, saved, owner, now), null);
  const local = structuredClone(sent); local.stages[0].responsible = 'Другой подрядчик';
  const model = reconcileSavedSnapshot({ ...createSyncModel({ state: before, revision: 1 }), state: local }, sent, { state: saved, revision: 2 });
  assert.equal(model.state.stages[0].responsible, 'Другой подрядчик'); assert.deepEqual(model.state.stages[0].siteUpdate, saved.stages[0].siteUpdate); assert.equal(confirmedSiteUpdate(model.state.stages[0], today), true);
  const second = structuredClone(sent); second.stages[0].siteUpdate!.requestId = crypto.randomUUID(); second.stages[0].siteUpdate!.remainingDays = 5;
  const concurrent = reconcileSavedSnapshot({ ...createSyncModel({ state: before, revision: 1 }), state: second }, sent, { state: saved, revision: 2 });
  assert.equal(concurrent.state.stages[0].siteUpdate!.remainingDays, 5); assert.equal(confirmedSiteUpdate(concurrent.state.stages[0], today), false);
  assert.deepEqual(concurrent.state.stages[0].scheduleHistory, saved.stages[0].scheduleHistory);
  assert.equal(validateScheduleReview(saved, structuredClone(concurrent.state), owner, now), null);
});

test('a summary cannot be completed or accepted before its children; its own fact gates successors', () => {
  const a = makeStage('a'), summary = makeStage('summary'); summary.schedule!.kind = 'summary'; summary.schedule!.summaryOf = ['a']; summary.siteUpdate = undefined;
  const base = confirm(fixture(a, summary)), completed = structuredClone(base);
  completed.stages[1].status = 'awaiting_inspection'; completed.stages[1].completedOn = today; completed.stages[1].completionNote = 'Осмотр'; completed.stages[1].statusNote = 'Осмотр';
  assert.match(validateStageControl(base, completed, owner, now) || '', /вложенных/);
  const done = structuredClone(base); done.stages[0].status = 'awaiting_inspection'; done.stages[0].completedOn = '2026-09-07'; done.stages[0].siteUpdate = undefined;
  done.stages[1].status = 'awaiting_inspection'; done.stages[1].completedOn = today;
  const b = makeStage('b', 1); b.schedule!.dependencies = [{ stageId: 'summary', gate: 'completed', lagDays: 0 }];
  const gated = confirm(fixture(...done.stages, b));
  assert.equal(stageCanStart(gated, gated.stages[2]), false); assert.equal(forecastSchedule(gated, today).end, '2026-09-10');
  const accepted = structuredClone(done); accepted.stages[1].status = 'accepted'; accepted.stages[1].acceptedAt = now; accepted.stages[1].completionNote = 'Осмотр'; accepted.stages[1].statusNote = 'Осмотр';
  assert.match(validateStageControl(done, accepted, owner, now) || '', /вложенных/);
});

test('HTTP and legacy Telegram reject invalid confirmations before any database write', async () => {
  const base = confirm(fixture(makeStage('a'))); base.project.id = 'schedule-review-test';
  const invalid = structuredClone(base); invalid.stages[0].schedule!.dependencies = [{ stageId: 'missing', gate: 'completed', lagDays: 0 }];
  let writes = 0;
  const db = { prepare() { writes++; throw Error('must not write'); } };
  const handler = createProjectWriteHandler({ ensureSchema: async () => {}, readSnapshot: async () => ({ state: base, revision: 1 }), changes: () => 1,
    applyAutomations: () => { throw Error('must not automate'); }, buildNotificationPlan: async () => [], dispatchNotifications: async () => {} });
  const response = await handler(new Request('https://app.test/api/state?projectId=schedule-review-test', { method: 'PUT', headers: { 'content-type': 'application/json', 'oai-authenticated-user-email': 'owner@test.local' }, body: JSON.stringify({ projectId: base.project.id, expectedRevision: 1, state: invalid }) }), { DB: db, OWNER_EMAIL: 'owner@test.local' }, { waitUntil() {} });
  assert.equal(response.status, 422); assert.equal((await response.json()).error, 'invalid_stage_transition'); assert.equal(writes, 0);
  const store = createTelegramProjectStore({ ensureSchema: async () => {}, readSnapshot: async () => ({ state: base, revision: 1 }), changes: () => 1, mutationNoop: Symbol() });
  const update = structuredClone(base); update.stages[0].siteUpdate!.requestId = crypto.randomUUID();
  await assert.rejects(store.mutate({ DB: db }, base.project.id, worker.name, 'foreman', 'review', 'review', () => update), /invalid_stage_transition/);
  assert.equal(writes, 0);
});

test('management may recover only missing completed/accepted facts with a source, never rewrite known dates', () => {
  const a = makeStage('a'); a.status = 'accepted'; a.siteUpdate = undefined;
  const base = confirm(fixture(a)), recovered = structuredClone(base);
  recovered.stages[0].completedOn = '2026-09-07'; recovered.stages[0].actualEnd = '2026-09-07'; recovered.stages[0].acceptedAt = '2026-09-08T12:00:00+03:00'; recovered.stages[0].factRecoveryNote = 'Акт выполнения от 07.09, журнал приёмки от 08.09';
  assert.ok(validateStageControl(base, structuredClone(recovered), worker, now));
  const noSource = structuredClone(recovered); delete noSource.stages[0].factRecoveryNote; assert.ok(validateStageControl(base, noSource, owner, now));
  assert.equal(validateStageControl(base, recovered, owner, now), null);
  assert.equal(recovered.stages[0].factRecoveryNote, undefined); assert.match(recovered.stages[0].statusHistory!.at(-1)!.note, /Акт выполнения/);
  assert.equal(recovered.stages[0].acceptedBy, undefined); // author of a historical acceptance is not invented
  assert.deepEqual(recovered.financeEntries, base.financeEntries);
  assert.equal(forecastSchedule(recovered, today).end, '2026-09-07');
  const overwrite = structuredClone(recovered); overwrite.stages[0].completedOn = '2026-09-06'; overwrite.stages[0].actualEnd = '2026-09-06'; overwrite.stages[0].factRecoveryNote = 'Другой документ';
  assert.ok(validateStageControl(recovered, overwrite, owner, now));
  const awaiting = structuredClone(base); awaiting.stages[0].status = 'awaiting_inspection'; awaiting.stages[0].completionNote = 'Старое подтверждение результата';
  const withoutRecovery = structuredClone(awaiting); withoutRecovery.stages[0].completedOn = today;
  assert.ok(validateStageControl(awaiting, withoutRecovery, worker, now));
  assert.throws(() => applyStageControl(awaiting, 'a', 'accept', { date: today, note: 'Приёмка', tasks: [] }, owner.name, 'management'), /фактическую дату/);
  const overwrittenEvidence = structuredClone(withoutRecovery); overwrittenEvidence.stages[0].factRecoveryNote = 'Акт'; overwrittenEvidence.stages[0].completionNote = 'Переписанный результат';
  assert.ok(validateStageControl(awaiting, overwrittenEvidence, owner, now));
});

test('an accepted predecessor cannot use a future expected acceptance to replace an unknown historical date', () => {
  const a = makeStage('a'); a.status = 'accepted'; a.completedOn = today; a.actualEnd = today; a.siteUpdate!.remainingDays = null; a.siteUpdate!.acceptanceOn = '2026-09-11';
  const b = makeStage('b'); b.schedule!.dependencies = [{ stageId: 'a', gate: 'accepted', lagDays: 0 }];
  const view = forecastSchedule(confirm(fixture(a, b)), today);
  assert.equal(view.end, null); assert.ok(view.issues.some((i) => i.code === 'acceptance_fact'));
});
