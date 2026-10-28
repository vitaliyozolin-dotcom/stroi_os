import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { previewTaskSave, previewTaskStatus } from '../src/application/task-payment-preview.ts';
import { taskSnapshot, type TaskDraft } from '../src/application/tasks-runtime.js';
import { treasuryScheduleImpact } from '../src/domain/treasury.js';

const identity = { name: 'Управление', role: 'management' as const, id: 'manager' };
const now = '2026-10-28T12:00:00Z';
function fixture() {
  const state = structuredClone(seedState);
  state.tasks = [{ id: 't', title: 'Монтаж', status: 'in_progress', priority: 'normal', assigneeId: 'manager', assigneeName: identity.name,
    createdBy: identity.name, createdAt: now, updatedAt: now, plannedStart: '2026-10-27', dueDate: '2026-10-31', originalDueDate: '2026-10-31', rescheduleCount: 0, history: [] }];
  state.settings.users = [{ id: 'manager', name: identity.name, role: 'management', status: 'active', email: 'manager@example.test' }];
  state.financeEntries = [{ id: 'pay', kind: 'expense', amount: 100, paidAmount: 30, acceptedAmount: 0, description: 'Расчёт за монтаж', date: '2026-10-20', status: 'committed',
    payments: [{ id: 'p', amount: 30, date: '2026-10-25', actor: 'Управление' }] }];
  state.treasury = { version: 1, enabled: true, accounts: [], costEstimates: [], entryPlans: [{ entryId: 'pay', source: 'Договор',
    tranches: [{ id: 'rest', amountCents: 10000, contractualDueDate: '2026-11-02', certainty: 'confirmed', source: 'Договор',
      dateRule: { kind: 'task_end', taskId: 't', offsetDays: 2, calendar: 'calendar' }, paymentAllocations: [{ paymentId: 'p', amountCents: 3000 }] }] }] };
  return state;
}
const draft = (): TaskDraft => ({ title: 'Монтаж', description: '', priority: 'normal', assigneeId: 'manager', reviewerId: '',
  dueDate: '2026-11-05', plannedStart: '2026-10-27', baselineEnd: '2026-10-31', baselineNote: '', reason: 'Подрядчик подтвердил новый срок',
  stageId: '', counterpartyId: '', procurementItemId: '', checkpointId: '' });

test('task edit preview runs the validated command and moves only remaining linked cash without mutations', () => {
  const state = fixture(), original = structuredClone(state);
  const preview = previewTaskSave(state, identity, now, { taskId: 't', expected: taskSnapshot(state, 't'), draft: draft() });
  assert.equal(preview.ok, true); if (!preview.ok) return;
  const impact = treasuryScheduleImpact(state, preview.state, { today: '2026-10-28' });
  assert.equal(impact.changes.length, 1);
  assert.equal(impact.changes[0].beforeDate, '2026-11-02');
  assert.equal(impact.changes[0].afterDate, '2026-11-07');
  assert.equal(impact.changes[0].amountCents, 7000);
  assert.equal(impact.changes[0].contractualDueDate, '2026-11-02');
  assert.deepEqual(preview.state.financeEntries, original.financeEntries);
  assert.deepEqual(preview.state.treasury, original.treasury);
  assert.deepEqual(state, original);
});

test('completion preview switches task anchor to factual date, reopening returns to the current plan', () => {
  const state = fixture();
  const completed = previewTaskStatus(state, identity, now, { taskId: 't', expected: taskSnapshot(state, 't'), status: 'done', text: 'Работа принята', extra: { completionNote: 'Акт' } });
  assert.equal(completed.ok, true); if (!completed.ok) return;
  const impact = treasuryScheduleImpact(state, completed.state, { today: '2026-10-28' });
  assert.equal(impact.changes[0].afterDate, '2026-10-30');
  assert.equal(impact.changes[0].afterResolution.basis, 'actual');
  assert.equal(state.tasks[0].completedAt, undefined);
  const reopened = previewTaskStatus(completed.state, identity, now, { taskId: 't', expected: taskSnapshot(completed.state, 't'), status: 'in_progress', text: 'Доработка' });
  assert.equal(reopened.ok, true); if (!reopened.ok) return;
  assert.equal(treasuryScheduleImpact(completed.state, reopened.state, { today: '2026-10-28' }).changes[0].afterDate, '2026-11-02');
});

test('task previews reject stale snapshots, missing change reasons and restricted roles before finance calculation', () => {
  const state = fixture(), original = structuredClone(state);
  assert.equal(previewTaskSave(state, identity, now, { taskId: 't', expected: 'stale', draft: draft() }).ok, false);
  assert.equal(previewTaskSave(state, identity, now, { taskId: 't', expected: taskSnapshot(state, 't'), draft: { ...draft(), reason: '' } }).ok, false);
  for (const role of ['foreman', 'client'] as const) {
    assert.equal(previewTaskStatus(state, { ...identity, role }, now, { taskId: 't', expected: taskSnapshot(state, 't'), status: 'done', text: 'Готово' }).ok, false);
  }
  assert.deepEqual(state, original);
});
