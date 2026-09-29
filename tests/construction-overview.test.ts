import test from 'node:test';
import assert from 'node:assert/strict';
import { constructionOverview } from '../src/domain/construction-overview.ts';
import type { AppState } from '../src/entities/index';

const fixture = () => ({
  stages: [
    { id: 'summary', order: 0, status: 'in_progress', schedule: { kind: 'summary' } },
    { id: 'done', order: 1, status: 'accepted' },
    { id: 'roof', order: 3, status: 'in_progress', responsible: 'Прораб' },
    { id: 'walls', order: 2, status: 'blocked' },
  ],
  tasks: [], fieldReports: [],
} as unknown as AppState);

test('shows all parallel active works in order and excludes summary rows', () => {
  const result = constructionOverview(fixture(), 'management');
  assert.deepEqual(result.stages.map((s) => s.id), ['done', 'walls', 'roof']);
  assert.deepEqual(result.active.map((s) => s.id), ['walls', 'roof']);
  assert.equal(result.accepted, 1);
});

test('does not identify an accepted or unstarted stage as current work', () => {
  const state = fixture(); state.stages = state.stages.slice(1, 2);
  assert.equal(constructionOverview(state, 'management').current, undefined);
  state.stages[0].status = 'not_ready';
  assert.equal(constructionOverview(state, 'management').current, undefined);
  assert.equal(constructionOverview(state, 'management').next?.id, 'done');
});

test('prefers a photo linked to active work and never exposes private reports to clients', () => {
  const state = fixture();
  state.fieldReports = [
    { id: 'private', createdAt: '2026-09-27', clientVisible: false, stageId: 'roof', attachments: [{ key: 'roof.jpg', mimeType: 'image/jpeg' }] },
    { id: 'recent', createdAt: '2026-09-29', clientVisible: true, attachments: [{ key: 'object.jpg', mimeType: 'image/jpeg' }] },
    { id: 'audio', createdAt: '2026-09-30', clientVisible: true, attachments: [{ key: 'voice', mimeType: 'audio/ogg' }] },
  ] as AppState['fieldReports'];
  assert.equal(constructionOverview(state, 'management').photo?.file.key, 'roof.jpg');
  assert.equal(constructionOverview(state, 'client').photo?.file.key, 'object.jpg');
  assert.equal(constructionOverview(state, 'client').photoStage, undefined);
});

test('selects recorded next action or an open real task and hides internal actions from clients', () => {
  const state = fixture();
  state.tasks = [
    { id: 'auto-stage-a', title: 'Auto', status: 'todo', dueDate: '2026-09-01' },
    { id: 'closed', title: 'Done', status: 'done', dueDate: '2026-09-01' },
    { id: 'task', title: 'Заказать леса', status: 'todo', dueDate: '2026-09-30', stageId: 'roof', assigneeName: 'Прораб' },
  ] as AppState['tasks'];
  assert.equal(constructionOverview(state, 'management').action?.title, 'Заказать леса');
  assert.equal(constructionOverview(state, 'client').action, undefined);
  state.stages[2].siteUpdate = { nextAction: 'Принять кровлю', reviewOn: '2026-10-01', issueOwner: 'Иван' } as NonNullable<AppState['stages'][number]['siteUpdate']>;
  assert.equal(constructionOverview(state, 'management').action?.title, 'Принять кровлю');
  state.stages[2].siteUpdate!.nextAction = '  ';
  assert.equal(constructionOverview(state, 'management').action?.title, 'Заказать леса');
});
