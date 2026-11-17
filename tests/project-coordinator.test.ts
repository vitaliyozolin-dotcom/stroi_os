import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBattleAutomations } from '../sites/automations/battle.js';
import { qualityShotTemplate, buildMeetingBrief, buildMissingMeetingUpdates, qualityRequestStillNeeded } from '../sites/automations/project-coordinator.js';
import { qualityReplyTarget, receiveQualityReply } from '../sites/telegram/quality-replies.js';
import { validateStageControl } from '../src/domain/construction/stage-validation.js';
import { createNotificationService } from '../sites/integrations/notifications.js';
import { transitionProcurement, procurementSnapshot } from '../src/domain/procurement-workflow.ts';
const fixture = (): any => ({ project: { id: 'project-one', code: 'H-001', status: 'active' }, stages: [{ id: 'foundation', name: 'Фундамент', responsible: 'Костя', status: 'in_progress', forecastEnd: '2026-12-01' }], checkpoints: [{ id: 'quality-one', title: 'Фундамент', stageId: 'foundation', status: 'pending', requiredShots: ['Общий вид', 'Узел'], photos: [], assignee: 'Костя' }], tasks: [], procurement: [], settings: { users: [{ id: 'foreman-one', name: 'Костя', role: 'foreman', status: 'active', telegramChatId: 'foreman-chat' }], notifications: { channels: { telegram: true }, events: { qualityRework: true } } }, activity: [] });
test('photo coordination creates one stable task, never accepts work and resolves on complete evidence', () => {
 const before = fixture(); before.stages[0].status = 'ready'; const next = fixture();
 applyBattleAutomations(before, next, 'Автор');
 assert.equal(next.tasks.filter(t => t.id === 'auto-photo-quality-one').length, 1);
 const repeat = structuredClone(next); applyBattleAutomations(next, repeat, 'Автор'); assert.equal(repeat.tasks.length, next.tasks.length);
 const completed = structuredClone(repeat); completed.checkpoints[0].photos = [{ id: 'a' }, { id: 'b' }]; applyBattleAutomations(repeat, completed, 'Автор');
 assert.equal(completed.tasks.find(t => t.id === 'auto-photo-quality-one').status, 'done');
 assert.equal(completed.checkpoints[0].status, 'pending'); assert.equal(qualityRequestStillNeeded(completed, 'quality-one'), false);
});
test('unknown work receives no invented universal photo standard or invented owner', () => {
 assert.deepEqual(qualityShotTemplate({ name: 'Согласование документов' }), []);
 assert.equal(qualityShotTemplate({ name: 'Фундамент' }).length, 3);
 const before = fixture(), next = fixture(); before.stages[0].status = 'ready'; next.settings.users = [];
 applyBattleAutomations(before, next, 'Автор'); assert.equal(next.tasks.find(t => t.id === 'auto-photo-quality-one').assigneeId, '');
});
test('stopped project does not request photos', () => {
 const state = fixture(); state.orderRelations = { status: 'on_hold' };
 assert.equal(qualityRequestStillNeeded(state, 'quality-one'), false);
});
test('meeting brief is short, task-based, role scoped and does not repeat complete updates', () => {
 const state = fixture(); state.tasks = [{ id: 'one', title: 'Проверить смету', assigneeId: 'a', assigneeName: 'Анна', status: 'todo', dueDate: '2026-11-10' }, { id: 'two', title: 'Получить фото', assigneeId: 'b', assigneeName: 'Костя', status: 'todo', dueDate: '2026-11-20' }];
 const brief = buildMeetingBrief(state, { userId: 'b', today: '2026-11-17' }); assert.equal(brief.rows.length, 1); assert.match(brief.rows[0], /Костя — Получить фото — 2026-11-20/);
 assert.deepEqual(buildMissingMeetingUpdates(state, { management: true }), []);
 state.tasks[0].dueDate = ''; assert.equal(buildMissingMeetingUpdates(state, { management: true }).length, 1);
});
test('photo request uses configured responsible channel with cancellable project context', async () => {
 const previous = fixture(), next = fixture(); next.tasks.push({ id: 'auto-photo-quality-one', checkpointId: 'quality-one', assigneeId: 'foreman-one', assigneeName: 'Костя', status: 'todo' });
 const service = createNotificationService({ resolveTelegramConnection: async () => ({ chat: { id: 'approved-group' } }), sha256: async value => String(value).padEnd(64, '0') });
 const plan = await service.buildPlan(previous, next, { TELEGRAM_BOT_TOKEN: 'configured' }, 'Автор', 'https://os.test', '', '2');
 assert.equal(plan.deliveries.length, 1); assert.equal(plan.deliveries[0].chatId, 'foreman-chat'); assert.equal(plan.deliveries[0].options._qualityRequest.checkpointId, 'quality-one');
 assert.match(plan.deliveries[0].text, /ответом на это сообщение/);
});
test('quality reply resolves only a genuine bot message on exact application origin', () => {
 const message: any = { reply_to_message: { from: { is_bot: true, username: 'ikioma_bot' }, text: 'Фото: https://os.test/?projectId=project-one&page=quality&entity=quality-one' } };
 assert.deepEqual(qualityReplyTarget(message, 'ikioma_bot', 'https://os.test'), { projectId: 'project-one', checkpointId: 'quality-one' });
 message.reply_to_message.from.username = 'impostor'; assert.equal(qualityReplyTarget(message, 'ikioma_bot', 'https://os.test'), null);
 message.reply_to_message.from.username = 'ikioma_bot'; assert.equal(qualityReplyTarget(message, 'ikioma_bot', 'https://other.test'), null);
});
test('quality reply outside sender project bindings does not download or mutate', async () => {
 let mutated = false;
 const message = { photo: [{ file_id: 'photo' }], reply_to_message: { from: { is_bot: true, username: 'ikioma_bot' }, text: 'https://os.test/?projectId=project-one&page=quality&entity=quality-one' } };
 assert.equal(await receiveQualityReply({ message, bindings: [], env: { BUCKET: {}, APP_PUBLIC_URL: 'https://os.test' }, botUsername: 'ikioma_bot', readSnapshot: async () => { throw new Error('must not read'); }, mutateProjectFromTelegram: async () => { mutated = true; } }), false);
 assert.equal(mutated, false);
});
test('partial receipt keeps shortage, never changes finances and cannot claim acceptance over received', () => {
 const state: any = fixture(); state.procurement = [{ id: 'supply-one', item: 'Доска', quantity: 10, unit: 'шт', stageId: 'foundation', status: 'ordered', budget: 1000 }]; state.financeEntries = [{ id: 'payment', paidAmount: 500 }];
 const input: any = { action: 'receipt', itemId: 'supply-one', expected: procurementSnapshot(state, 'supply-one'), receivedQuantity: 6, acceptedQuantity: 5, expectedDeliveryDate: '2026-12-01', note: 'Одна доска с браком' };
 const result = transitionProcurement(state, input, '2026-11-17T12:00:00Z', ''); assert.ok(result.ok); if (!result.ok) return;
 assert.equal(result.patch.procurement?.[0].status, 'in_transit'); assert.match(result.patch.procurement?.[0].risk || '', /4 шт/); assert.equal('financeEntries' in result.patch, false);
 assert.equal(transitionProcurement(state, { ...input, acceptedQuantity: 7 }, '2026-11-17T12:00:00Z', '').ok, false);
});

test('uncertain sender lease cannot be retried blindly', async () => {
 const { telegramOutboxRetryReady } = await import('../sites/telegram/outbox.js');
 assert.equal(telegramOutboxRetryReady({ status: 'sending', updated_at: '2020-01-01T00:00:00Z' }), false);
 assert.equal(telegramOutboxRetryReady({ status: 'uncertain', updated_at: '2020-01-01T00:00:00Z' }), false);
 assert.equal(telegramOutboxRetryReady({ status: 'canceled', updated_at: '2020-01-01T00:00:00Z' }), false);
 assert.equal(telegramOutboxRetryReady({ status: 'failed', updated_at: '2020-01-01T00:00:00Z' }), true);
});

test('unrelated save does not backfill historical photo requests or invent their dates', () => {
 const before = fixture(), next = structuredClone(before); next.project.name = 'Новое название';
 applyBattleAutomations(before, next, 'Автор'); assert.equal(next.tasks.some(t => t.id.startsWith('auto-photo-')), false);
 before.stages[0].status = 'ready'; next.stages[0].forecastEnd = ''; applyBattleAutomations(before, next, 'Автор');
 assert.equal(next.tasks.find(t => t.id === 'auto-photo-quality-one').dueDate, '');
});

test('genuine bound photo reply stores original once, resolves collection only and ignores replay', async () => {
 const state = fixture(); state.checkpoints[0].requiredShots = ['Общий вид']; state.tasks.push({ id: 'auto-photo-quality-one', status: 'todo' });
 const message = { chat: { id: -123 }, from: { id: 123 }, message_id: 42, date: 1794920400, photo: [{ file_id: 'file-one', file_unique_id: 'unique-one' }], reply_to_message: { from: { is_bot: true, username: 'ikioma_bot' }, text: 'https://os.test/?projectId=project-one&page=quality&entity=quality-one' } };
 const originalFetch = globalThis.fetch; let downloads = 0, writes = 0;
 globalThis.fetch = async url => {
   if (String(url).endsWith('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/a.jpg', file_size: 8 } }), { headers: { 'content-type': 'application/json' } });
   downloads++; return new Response(new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]), { headers: { 'content-type': 'image/jpeg' } });
 };
 const env = { APP_PUBLIC_URL: 'https://os.test', TELEGRAM_BOT_TOKEN: 'test-token', BUCKET: { put: async (key, body) => { assert.match(key, /project-one\/quality\/quality-one\//); await new Response(body).arrayBuffer(); writes++; } } };
 const args = { message, env, botUsername: 'ikioma_bot', bindings: [{ project_id: 'project-one', system_user_id: 'foreman-one' }], readSnapshot: async () => ({ state }), mutationNoop: Symbol('noop'), mutateProjectFromTelegram: async (_env, _id, _actor, _role, _action, _text, mutate) => { const before = structuredClone(state); mutate(state); assert.equal(validateStageControl(before, state, { role: 'foreman', name: 'Костя' }), null); } };
 try {
   assert.equal(await receiveQualityReply(args), true); assert.equal(await receiveQualityReply(args), true);
   assert.equal(downloads, 1); assert.equal(writes, 1); assert.equal(state.checkpoints[0].photos.length, 1);
   assert.equal(state.tasks[0].status, 'done'); assert.equal(state.checkpoints[0].status, 'pending'); assert.equal(state.stages[0].status, 'in_progress');
 } finally { globalThis.fetch = originalFetch; }
});

test('queued photo request is canceled before send once photos arrive', async () => {
 const { deliverTelegramOutbox } = await import('../sites/telegram/outbox.js');
 const state = fixture(); state.checkpoints[0].photos = [{ id: 'one' }, { id: 'two' }];
 let status = '', sends = 0; const originalFetch = globalThis.fetch;
 globalThis.fetch = async () => { sends++; throw new Error('must not send'); };
 const DB = { prepare: sql => ({ bind: (...args) => ({ run: async () => { if (sql.includes('SET status = ?')) status = args[0]; return { changes: 1 }; }, first: async () => ({ state_json: JSON.stringify(state) }) }) }) };
 try {
   assert.equal(await deliverTelegramOutbox({ DB }, { id: 'request', status: 'pending', attempts: 0, updated_at: '2026-11-17T12:00:00Z', options_json: JSON.stringify({ _qualityRequest: { projectId: 'project-one', checkpointId: 'quality-one' } }) }), false);
   assert.equal(status, 'canceled'); assert.equal(sends, 0);
 } finally { globalThis.fetch = originalFetch; }
});

test('transport timeout preserves uncertain delivery and does not retry it', async () => {
 const { deliverTelegramOutbox } = await import('../sites/telegram/outbox.js');
 let status = 'pending', sends = 0; const originalFetch = globalThis.fetch;
 globalThis.fetch = async () => { sends++; throw new Error('timeout after request body'); };
 const DB = { prepare: sql => ({ bind: (...args) => ({ run: async () => { if (sql.includes('SET status = ?')) status = args[0]; return { changes: 1 }; } }) }) };
 const row = { id: 'request', status, chat_id: 'configured-chat', text: 'Запрос', attempts: 0, updated_at: '2026-11-17T12:00:00Z', options_json: '{}' };
 try {
   assert.equal(await deliverTelegramOutbox({ DB, TELEGRAM_BOT_TOKEN: 'test' }, row), false);
   assert.equal(status, 'uncertain');
   assert.equal(await deliverTelegramOutbox({ DB, TELEGRAM_BOT_TOKEN: 'test' }, { ...row, status }), false);
   assert.equal(sends, 1);
 } finally { globalThis.fetch = originalFetch; }
});
