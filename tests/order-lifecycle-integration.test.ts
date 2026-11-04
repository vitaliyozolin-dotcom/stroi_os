import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from '../src/seed.ts';
import { emptyOrderRelations } from '../src/domain/order-relations.js';
import { applyBattleAutomations } from '../sites/automations/battle.js';
import { notificationEvents, createNotificationService } from '../sites/integrations/notifications.js';
import { stateForRole, documentVisibilityForRole } from '../sites/access-control.js';
import { applyLocalChange, createSyncModel, reconcileSavedSnapshot } from '../src/application/project-sync.ts';

test('paused/canceled orders create no future construction tasks while retaining all financial facts', () => {
  for (const status of ['on_hold', 'canceled', 'completed'] as const) {
    const before = structuredClone(seedState), next = structuredClone(before);
    next.project.status = 'active'; next.orderRelations = { ...emptyOrderRelations(), status };
    next.stages[0].status = 'in_progress';
    next.financeEntries = [{ id: 'advance', kind: 'income', description: 'Аванс', counterparty: 'Клиент', amount: 100, status: 'paid', date: '2026-01-01', paidAmount: 100 }];
    const facts = structuredClone(next.financeEntries);
    applyBattleAutomations(before, next, 'Владелец');
    assert.deepEqual(next.tasks, []); assert.deepEqual(next.checkpoints, []); assert.deepEqual(next.financeEntries, facts);
  }
});

test('stopped work suppresses ordinary task reminders but keeps warranty and financial notifications', async () => {
  const before = structuredClone(seedState), next = structuredClone(before);
  next.orderRelations = { ...emptyOrderRelations(), status: 'canceled', links: [{ id: 'l', kind: 'task', entityId: 'warranty-task', warrantyCaseId: 'w' }] };
  next.tasks = ['ordinary-task', 'warranty-task'].map(id => ({ id, title: id, assigneeId: 'owner', assigneeName: 'Owner', createdBy: 'Owner', createdAt: '2026-01-01', updatedAt: '2026-01-01', status: 'todo', priority: 'normal', dueDate: '2026-01-02', originalDueDate: '2026-01-02', rescheduleCount: 0, history: [] }));
  next.financeEntries = [{ id: 'settlement', kind: 'expense', description: 'Расчёт', counterparty: 'Поставщик', amount: 100, paidAmount: 100, status: 'paid', date: '2026-01-02' }];
  const events = notificationEvents(before, next, '2026-01-03');
  assert.ok(events.some(event => event.entityId === 'warranty-task'));
  assert.ok(events.some(event => event.page === 'finance'));
  assert.ok(events.every(event => event.entityId !== 'ordinary-task'));
  const service = createNotificationService({ resolveTelegramConnection: async () => null, sha256: async () => 'x' });
  const unchanged = structuredClone(next); unchanged.tasks[0].title = 'Изменена обычная задача';
  const plan = await service.buildPlan(next, unchanged, {}, 'Owner', 'https://test.invalid', 'Обновлена задача');
  assert.equal(plan.deliveries.length, 0); assert.equal(plan.message, '');
});

test('private master-contract/change evidence and file aliases stay inaccessible to restricted roles', () => {
  const state = structuredClone(seedState); state.project.id = 'p';
  const doc = (id: string, fileKey: string, clientVisible: boolean, category: 'contract' | 'other' = 'other') => ({ id, name: id, type: 'pdf', status: 'signed' as const, updatedAt: '2026-01-01', fileKey, category, clientVisible });
  state.documents = [doc('master', 'p/master.pdf', false, 'contract'), doc('master-alias', 'p/master.pdf', true), doc('change', 'p/change.pdf', false), doc('change-alias', 'p/change.pdf', true), doc('customer-legacy', 'p/customer.pdf', true, 'contract')];
  state.orderRelations = { ...emptyOrderRelations(), changeRequests: [{ id: 'c', title: 'Изменение стоимости', reason: 'Допработы', status: 'draft', objectIds: [], costDeltaCents: 10000, documentIds: ['change'] }] };
  for (const role of ['client', 'foreman']) {
    const allowed = state.documents.filter(documentVisibilityForRole(state, { role })).map(row => row.id);
    assert.ok(!allowed.includes('master')); assert.ok(!allowed.includes('master-alias'));
    assert.ok(!allowed.includes('change')); assert.ok(!allowed.includes('change-alias'));
    assert.equal(stateForRole(state, { role, id: role }).orderRelations, undefined);
  }
  assert.ok(state.documents.filter(documentVisibilityForRole(state, { role: 'client' })).some(row => row.id === 'customer-legacy'));
});

test('canonical customer/status acknowledgements preserve concurrent project naming edits', () => {
  const sent = structuredClone(seedState); sent.project.clientNames = 'Старое имя'; sent.project.status = 'draft';
  sent.orderRelations = { ...emptyOrderRelations(), customerId: 'customer-1', status: 'active' };
  const local = structuredClone(sent); local.project.name = 'Новая локальная правка';
  const saved = structuredClone(sent); saved.project.clientNames = 'Каноническое имя'; saved.project.status = 'active';
  saved.orderRelations!.history = [{ id: 'server-h', at: '2026-01-01', by: 'Owner', reason: 'Сохранено', sections: ['customerId'], changes: [] }];
  const model = applyLocalChange(createSyncModel({ state: sent, revision: 1 }, false, true), local);
  const merged = reconcileSavedSnapshot(model, sent, { state: saved, revision: 2 });
  assert.equal(merged.state.project.name, 'Новая локальная правка'); assert.equal(merged.state.project.clientNames, 'Каноническое имя'); assert.equal(merged.state.project.status, 'active');
  assert.equal(merged.state.orderRelations!.history[0].id, 'server-h'); assert.equal(merged.dirty, true);
});
