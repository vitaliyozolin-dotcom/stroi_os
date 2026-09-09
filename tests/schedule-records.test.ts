import assert from 'node:assert/strict';
import test from 'node:test';
import { recordedScheduleStatus } from '../sites/lib/stage-control.js';
import { baselineOverview } from '../sites/lib/plan-baseline.js';
import { seedState } from '../src/seed.ts';
import type { Stage, ProjectTask } from '../src/entities/index.ts';

const today = '2026-09-09';
const stage = (id: string, end = '2026-08-15'): Stage => ({ id, name: id, shortName: id, order: 1, status: 'not_ready', weight: 1, progress: 0, planStart: '2026-08-10', planEnd: end, forecastEnd: end, responsible: 'Ответственный', baseline: { end, source: 'document', note: 'ППР', recordedAt: '2026-08-10T00:00:00Z', recordedBy: 'Управление' } });
const task = (id: string, dueDate = '2026-08-20'): ProjectTask => ({ id, title: id, status: 'todo', priority: 'normal', assigneeId: 'worker', assigneeName: 'Исполнитель', createdBy: 'Управление', createdAt: '2026-08-10T00:00:00Z', updatedAt: '2026-08-10T00:00:00Z', dueDate, originalDueDate: dueDate, rescheduleCount: 0, history: [] });
const fixture = () => ({ ...structuredClone(seedState), stages: [stage('Поставка'), stage('Параллельная работа', '2026-08-20')], tasks: [task('Задача')] });

test('unchanged PPR can have overdue records; the maximum is not a sum or a project forecast', () => {
  const state = fixture(), before = structuredClone(state);
  const result = recordedScheduleStatus(state, today);
  assert.equal(baselineOverview(state).shift, 0);
  assert.equal(result.stages.overdue.length, 2);
  assert.equal(result.stages.maxDays, 25);
  assert.equal(result.stages.maxBaselineDays, 25);
  assert.equal(result.stages.overdue[0].record.name, 'Поставка');
  assert.equal(result.tasks.maxDays, 20);
  assert.deepEqual(state, before);
});

test('a later current deadline does not erase an overdue baseline', () => {
  const state = fixture(); state.stages = [stage('Поставка')]; state.stages[0].planEnd = '2026-09-15';
  const result = recordedScheduleStatus(state, today);
  assert.equal(result.stages.maxDays, 0);
  assert.equal(result.stages.overdue.length, 0);
  assert.equal(result.stages.maxBaselineDays, 25);
  assert.equal(result.stages.baselineOverdue.length, 1);
  assert.equal(baselineOverview(state).shift, 31);
});

test('review is separate from open work, accepted legacy facts and service tasks do not add overdue days', () => {
  const state = fixture();
  state.stages = [
    { ...stage('С датой'), status: 'awaiting_inspection', completedOn: '2026-08-20' },
    { ...stage('Без даты'), status: 'awaiting_inspection' },
    { ...stage('Принят'), status: 'accepted', actualEnd: '2026-08-20' },
    { ...stage('Доработка'), status: 'rework', completedOn: '2026-08-20' },
  ];
  state.tasks = [{ ...task('Проверка'), status: 'review' }, { ...task('Готово'), status: 'done' }, { ...task('Отмена'), status: 'canceled' }, { ...task('auto-stage-Доработка'), stageId: 'Доработка' }];
  const result = recordedScheduleStatus(state, today);
  assert.equal(result.stages.awaitingReview, 2);
  assert.equal(result.stages.overdue.length, 1);
  assert.equal(result.stages.overdue[0].record.id, 'Доработка');
  assert.equal(result.stages.maxDays, 25);
  assert.equal(result.tasks.awaitingReview, 1);
  assert.equal(result.tasks.overdue.length, 0);
  assert.equal(result.tasks.recordCount, 2);
});

test('missing and invalid dates stay unknown; today is not overdue and incomplete PPR has no total end', () => {
  const state = fixture();
  state.stages = [stage('Сегодня', today), { ...stage('Без даты'), planEnd: '', baseline: undefined }, { ...stage('Неверная дата'), planEnd: '2026-02-30' }];
  state.tasks = [{ ...task('Без даты', ''), originalDueDate: '' }];
  const result = recordedScheduleStatus(state, today);
  assert.equal(result.stages.overdue.length, 0);
  assert.equal(result.stages.missingDue, 2);
  assert.equal(result.tasks.missingDue, 1);
  assert.equal(result.tasks.missingBaseline, 1);
  assert.equal(baselineOverview(state).currentEnd, null);
  assert.equal(baselineOverview(state).shift, null);
  const empty = recordedScheduleStatus({ ...state, stages: [], tasks: [] }, today);
  assert.equal(empty.stages.recordCount, 0);
  assert.equal(empty.tasks.recordCount, 0);
});
