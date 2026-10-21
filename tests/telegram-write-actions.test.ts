import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegramWriteActions } from '../sites/telegram/write-actions.js';

function fixture(role = 'management') {
  const user = { id: 'manager', name: 'Manager', role };
  const state = {
    project: { id: 'project' },
    tasks: [{ id: 'task', title: 'Task', assigneeId: 'manager', status: 'todo', history: [] as any[] }],
    settings: { users: [user], notifications: { events: { taskAssigned: true } } },
    activity: [],
  };
  const calls: string[] = [];
  const noop = Symbol('noop');
  let beforeMutation = () => {};
  let visible = true;
  const actions = createTelegramWriteActions({
    projectForBinding: async () => ({ snapshot: { state: structuredClone(state) }, user: { ...user } }),
    mutateProjectFromTelegram: async (_env, projectId, _actor, _role, action, _summary, mutate) => {
      assert.equal(projectId, 'project');
      assert.equal(action, 'telegram.task.status');
      beforeMutation();
      const previous = structuredClone(state);
      const result = mutate(state);
      calls.push(result === noop ? 'noop' : 'write');
      return { previous, state };
    },
    TELEGRAM_MUTATION_NOOP: noop,
    dispatchNotifications: async () => { calls.push('notifications'); },
    telegramOrigin: () => 'https://example.test',
    telegramDurableVisibility: async () => { calls.push('visible'); return visible; },
    requireTelegramVisibility: value => { if (!value) throw new Error('delivery_failed'); },
    telegramAnswerCallback: async () => { calls.push('answer'); },
  });
  const run = (action = 'done') => actions.telegramChangeTaskStatus(
    { id: 'callback', message: { chat: { id: 'chat' } } },
    { project_id: 'project', system_user_id: 'manager' }, 'task', action, {},
  );
  return { state, calls, run, beforeMutation: (fn: () => void) => { beforeMutation = fn; }, hide: () => { visible = false; } };
}

test('task status writes once and retries notification delivery with the same callback', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.state.tasks[0].status, 'done');
  assert.equal(f.state.tasks[0].history[0].sourceTelegramCallbackId, 'callback');
  assert.deepEqual(f.calls, ['write', 'notifications', 'visible', 'answer']);
  await f.run();
  assert.equal(f.state.tasks[0].history.length, 1);
  assert.deepEqual(f.calls.slice(4), ['noop', 'notifications', 'visible', 'answer']);
});

test('task status rechecks revoked access and reassignment inside persistence', async () => {
  for (const revoke of [
    f => { f.state.settings.users = []; },
    f => { f.state.tasks[0].assigneeId = 'other'; },
  ]) {
    const f = fixture('foreman');
    f.beforeMutation(() => revoke(f));
    await assert.rejects(() => f.run('review'), /action_denied/);
    assert.equal(f.state.tasks[0].status, 'todo');
    assert.deepEqual(f.calls, []);
  }
  const f = fixture('foreman');
  await assert.rejects(() => f.run(), /action_denied/);
});

test('failed confirmation preserves committed task and a retry does not duplicate history', async () => {
  const f = fixture();
  f.hide();
  await assert.rejects(() => f.run(), /delivery_failed/);
  await assert.rejects(() => f.run(), /delivery_failed/);
  assert.equal(f.state.tasks[0].status, 'done');
  assert.equal(f.state.tasks[0].history.length, 1);
  assert.ok(!f.calls.includes('answer'));
});
