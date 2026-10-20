import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { seedState } from '../src/seed.ts';
import { changeProjectSettings } from '../src/application/settings.ts';
import { settingsSnapshot } from '../src/domain/settings.ts';
import { uploadProjectDocument } from '../src/application/project-documents.ts';
import { editProjectSchedule, scheduleEditSnapshot } from '../src/application/schedule-edits.ts';
import { commitStageControl, stageCommandSnapshot } from '../src/application/stage-control.ts';
const now = '2026-10-20T12:00:00.000Z', clock = { now: () => now };
const idGenerator = () => { let index = 0; return { next: (prefix: string) => `${prefix}-${++index}` }; };
const identity = { name: 'Управляющий', role: 'management' as const, canManageAccess: true, id: 'owner' };
const fixture = () => structuredClone(seedState);

test('settings commands preserve other data, set explicit values, audit and ignore unchanged settings', () => {
 const state = fixture(), before = structuredClone(state), input = { kind: 'channel' as const, expected: settingsSnapshot(state), key: 'browser' as const, enabled: !state.settings.notifications.channels.browser };
 const result = changeProjectSettings(state, input, identity, clock, idGenerator()); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.deepEqual(state, before); const next = result.change.state; assert.equal(next.settings.notifications.channels.browser, input.enabled); assert.deepEqual(next.settings.users, state.settings.users); assert.deepEqual(next.financeEntries, state.financeEntries); assert.equal(next.activity[0].timestamp, now);
 const repeat = changeProjectSettings(next, { ...input, expected: settingsSnapshot(next) }, identity, clock, idGenerator()); assert.ok(repeat.ok); if (repeat.ok) assert.equal(repeat.change, null);
 assert.equal(changeProjectSettings(next, input, identity, clock, idGenerator()).ok, false);
 assert.equal(changeProjectSettings(state, input, { ...identity, role: 'client' }, clock, idGenerator()).ok, false);
});
test('local roster fallback enforces owner, email uniqueness, existing identity and stale snapshots', () => {
 const state = fixture(); state.settings.users = [{ id: 'existing', name: 'Участник', email: 'one@example.test', role: 'foreman', status: 'active', telegramChatId: 'preserved' }];
 const input = { kind: 'user' as const, expected: settingsSnapshot(state), name: ' Новый ', email: 'two@example.test', role: 'client' as const, telegram: '' };
 assert.equal(changeProjectSettings(state, input, { ...identity, canManageAccess: false }, clock, idGenerator()).ok, false);
 assert.equal(changeProjectSettings(state, { ...input, email: 'ONE@example.test' }, identity, clock, idGenerator()).ok, false);
 const result = changeProjectSettings(state, { ...input, id: 'existing', email: 'new@example.test' }, identity, clock, idGenerator()); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.equal(result.change.state.settings.users[0].id, 'existing'); assert.equal(result.change.state.settings.users[0].telegramChatId, 'preserved');
 assert.equal(changeProjectSettings(state, { ...input, id: 'missing' }, identity, clock, idGenerator()).ok, false);
 const command = { ...input }; state.project.id = 'other'; assert.equal(changeProjectSettings(state, command, identity, clock, idGenerator()).ok, false);
});
const documentDraft = () => ({ name: '', category: 'contract' as const, number: ' 1 ', documentDate: '2026-10-20', status: 'signed' as const, direction: 'incoming' as const, counterpartyId: '', stageId: '', clientVisible: false });
const fileMetadata = (projectId: string) => ({ key: `${projectId}/documents/test.pdf`, name: 'test.pdf', type: 'application/pdf', size: 4, uploadedAt: now });
test('document workflow uses latest state after upload, preserves unrelated work and commits once', async () => {
 const state = fixture(), before = structuredClone(state); let writes = 0;
 const result = await uploadProjectDocument(() => state, { projectId: state.project.id, draft: documentDraft(), file: new File(['test'], 'test.pdf') }, identity, clock, idGenerator(), { upload: async projectId => { state.activity.unshift({ id: 'parallel', actor: 'Другой', text: 'Задача обновлена', timestamp: now, tone: 'neutral' }); return fileMetadata(projectId); } }, (next, metadata) => { writes++; assert.equal(next.activity[1].id, 'parallel'); assert.equal(metadata?.action, 'document_updated'); }, new AbortController().signal);
 assert.ok(result.ok); if (!result.ok) return;
 assert.equal(writes, 1); assert.equal(result.change.state.documents[0].name, 'test'); assert.equal(result.change.state.documents[0].fileKey, `${state.project.id}/documents/test.pdf`); assert.equal(result.change.state.documents[0].signedAt, now); assert.equal(result.change.state.documents[0].clientVisible, false); assert.deepEqual(result.change.state.financeEntries, before.financeEntries);
});
test('document workflow rejects changed project, cancelled response and foreign file before any state write', async () => {
 for (const mode of ['project', 'cancel', 'foreign', 'stage']) {
  const state = fixture(), projectId = state.project.id, controller = new AbortController(), draft = documentDraft(); let writes = 0;
  const result = await uploadProjectDocument(() => state, { projectId, draft, file: new File(['test'], 'test.pdf') }, identity, clock, idGenerator(), { upload: async () => { if (mode === 'project') state.project.id = 'other'; if (mode === 'cancel') controller.abort(); if (mode === 'stage') draft.stageId = 'missing'; return fileMetadata(mode === 'foreign' ? 'other' : projectId); } }, () => { writes++; }, controller.signal);
  assert.equal(result.ok, false); assert.equal(writes, 0);
 }
});
test('invalid document inputs and roles fail before calling storage', async () => {
 const state = fixture(); let uploads = 0;
 const uploader = { upload: async () => { uploads++; return fileMetadata(state.project.id); } };
 for (const mode of ['client', 'stage', 'date']) {
  const draft = documentDraft(); if (mode === 'stage') draft.stageId = 'missing'; if (mode === 'date') draft.documentDate = '2026-02-30';
  const result = await uploadProjectDocument(() => state, { projectId: state.project.id, draft, file: new File(['test'], 'test.pdf') }, mode === 'client' ? { ...identity, role: 'client' } : identity, clock, idGenerator(), uploader, () => {}, new AbortController().signal); assert.equal(result.ok, false);
 }
 assert.equal(uploads, 0);
});
test('baseline command requires source, preserves fixed original dates, and rejects stale/unauthorized edits', () => {
 const state = fixture(); state.project.baseline = undefined; state.stages = [];
 const draft = { source: 'document', note: 'Договор', start: '2026-10-01', end: '2026-11-01', targetDate: state.project.targetDate, reason: '', stages: [] };
 const input = { kind: 'baseline' as const, expected: scheduleEditSnapshot(state, 'baseline'), draft };
 assert.equal(editProjectSchedule(state, { ...input, draft: { ...draft, note: '' } }, identity, clock, idGenerator()).ok, false);
 assert.equal(editProjectSchedule(state, input, { ...identity, role: 'foreman' }, clock, idGenerator()).ok, false);
 const result = editProjectSchedule(state, input, identity, clock, idGenerator()); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.equal(result.change.state.project.baseline?.end, '2026-11-01'); assert.equal(state.project.baseline, undefined);
 const next = result.change.state, repeat = editProjectSchedule(next, { ...input, expected: scheduleEditSnapshot(next, 'baseline'), draft: { ...draft, end: '2026-12-01' } }, identity, clock, idGenerator()); assert.ok(repeat.ok); if (repeat.ok) assert.equal(repeat.change, null);
 assert.equal(editProjectSchedule(next, input, identity, clock, idGenerator()).ok, false);
});
const scheduleFixture = () => {
 const state = fixture(); state.stages = [{ ...state.stages[0], status: 'ready', actualStart: undefined, completedOn: undefined, actualEnd: undefined, acceptedAt: undefined, blocker: undefined, schedule: { kind: 'work', phase: 'Работы', summaryOf: [], dependencies: [], calendar: 'daily', daysOff: [], crew: '', reporterId: 'reporter' } }]; state.settings.users = [{ id: 'reporter', name: 'Прораб', email: 'reporter@example.test', role: 'foreman', status: 'active' }]; return state;
};
test('structure command uses shared validation and leaves trusted stamps to the server', () => {
 const state = scheduleFixture(), stage = state.stages[0], structure = { ...stage.schedule!, crew: 'Бригада' };
 const input = { kind: 'structure' as const, stageId: stage.id, expected: scheduleEditSnapshot(state, 'structure', stage.id), structure, daysOff: '', checked: true };
 const result = editProjectSchedule(state, input, identity, clock, idGenerator()); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.equal(result.change.state.stages[0].schedule?.crew, 'Бригада'); assert.equal(result.change.state.stages[0].schedule?.updatedAt, undefined); assert.deepEqual(result.change.state.financeEntries, state.financeEntries);
 assert.equal(editProjectSchedule(state, { ...input, checked: false }, identity, clock, idGenerator()).ok, false);
 const invalid = { ...input, structure: { ...structure, dependencies: [{ stageId: stage.id, gate: 'accepted' as const, lagDays: 0 }] } }; assert.equal(editProjectSchedule(state, invalid, identity, clock, idGenerator()).ok, false);
});
test('review command restricts reporter, validates input, and does not forge confirmation stamps', () => {
 const state = scheduleFixture(), stage = state.stages[0];
 const input = { kind: 'review' as const, stageId: stage.id, expected: scheduleEditSnapshot(state, 'review', stage.id), form: { asOf: '2026-10-20', reviewOn: '2026-10-27', remainingDays: 3, readyOn: '2026-10-20', acceptanceOn: '', note: 'Состояние проверено', nextAction: '', issueOwner: '' } };
 assert.equal(editProjectSchedule(state, input, { name: 'Чужой', role: 'foreman', id: 'other' }, clock, idGenerator()).ok, false);
 const result = editProjectSchedule(state, input, { name: 'Прораб', role: 'foreman', id: 'reporter' }, clock, idGenerator()); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.ok(result.change.state.stages[0].siteUpdate?.requestId); assert.equal(result.change.state.stages[0].siteUpdate?.confirmationId, undefined); assert.equal(result.change.state.stages[0].siteUpdate?.updatedAt, undefined);
});
test('stage control commits metadata and uses injected clocks/IDs without changing financial facts', () => {
 const state = scheduleFixture(), stage = state.stages[0]; state.tasks = []; state.checkpoints = [];
 const next = commitStageControl(state, stage.id, 'start', { date: '2026-10-20', note: 'Работы начаты', tasks: [] }, identity.name, identity.role, identity.id, stageCommandSnapshot(state, stage.id), clock, idGenerator(), (candidate, metadata) => { assert.equal(metadata?.action, 'schedule_updated'); assert.equal(candidate.activity[0].timestamp, now); });
 assert.equal(next.activity[0].id, 'activity-1'); assert.equal(next.stages[0].status, 'in_progress'); assert.deepEqual(next.financeEntries, state.financeEntries);
 assert.throws(() => commitStageControl(next, stage.id, 'complete', { date: '2026-10-20', note: 'Готово', tasks: [] }, identity.name, identity.role, identity.id, stageCommandSnapshot(state, stage.id), clock, idGenerator(), () => {}));
});
test('generic page mutation facades are removed and remaining editors delegate state assembly', () => {
 assert.equal(existsSync(new URL('../src/application/page-commands.ts', import.meta.url)), false);
 for (const path of ['src/pages/SettingsPage.tsx','src/pages/ProjectPage.tsx','src/components/BaselinePanel.tsx','src/components/ScheduleReconciliation.tsx','src/components/SiteProgress.tsx','src/components/StageRadar.tsx','src/components/FieldReportUpload.tsx']) { const code = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'); assert.doesNotMatch(code, /saveChange\(|saveSettings\(|next\.project\.|row\.siteUpdate\s*=|row\.completedOn\s*\|\|=/); }
});

test('fact recovery fills only unknown fields with evidence and preserves the known completion date', () => {
 const state = scheduleFixture(), stage = state.stages[0]; stage.status = 'accepted'; stage.completedOn = '2026-10-01'; stage.actualEnd = '2026-10-01'; stage.acceptedAt = undefined;
 const input = { kind: 'facts' as const, stageId: stage.id, expected: scheduleEditSnapshot(state, 'facts', stage.id), end: '2026-10-02', accepted: '2026-10-03', note: 'Акт приёмки' };
 assert.equal(editProjectSchedule(state, { ...input, note: '' }, identity, clock, idGenerator()).ok, false);
 const result = editProjectSchedule(state, input, identity, clock, idGenerator()); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.equal(result.change.state.stages[0].completedOn, '2026-10-01'); assert.equal(result.change.state.stages[0].actualEnd, '2026-10-01'); assert.equal(result.change.state.stages[0].acceptedAt, '2026-10-03T12:00:00+03:00'); assert.deepEqual(result.change.state.financeEntries, state.financeEntries);
});

test('site progress preserves history and financial facts, rejects stale and foreign project drafts', () => {
 const state = fixture(), input = { kind: 'progress' as const, expected: scheduleEditSnapshot(state, 'progress'), date: '2026-10-20', completed: '  Подготовка  ', remaining: 'Монтаж', source: 'Фотоотчёт' };
 const result = editProjectSchedule(state, input, identity, clock, idGenerator()); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.deepEqual(result.change.state.project.siteProgressHistory?.at(-1)?.completed, ['Подготовка']); assert.deepEqual(result.change.state.financeEntries, state.financeEntries);
 assert.equal(editProjectSchedule(result.change.state, input, identity, clock, idGenerator()).ok, false);
 assert.equal(editProjectSchedule(state, input, { ...identity, role: 'foreman' }, clock, idGenerator()).ok, false);
 const other = structuredClone(state); other.project.id = 'other'; assert.equal(editProjectSchedule(other, input, identity, clock, idGenerator()).ok, false);
});
test('project forecast requires evidence and preserves accepted work and baseline', () => {
 const state = fixture(), input = { kind: 'forecast' as const, expected: scheduleEditSnapshot(state, 'forecast'), date: '2026-11-30', note: 'Проверенная оценка' };
 assert.equal(editProjectSchedule(state, { ...input, note: '' }, identity, clock, idGenerator()).ok, false);
 const result = editProjectSchedule(state, input, identity, clock, idGenerator()); assert.ok(result.ok && result.change); if (!result.ok || !result.change) return;
 assert.equal(result.change.state.project.workForecastDate, input.date); assert.deepEqual(result.change.state.stages, state.stages); assert.deepEqual(result.change.state.project.baseline, state.project.baseline);
});
