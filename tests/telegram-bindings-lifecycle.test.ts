import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindingForTelegramProject,
  bindingForTelegramUser,
  saveTelegramProjectSelection,
  selectTelegramBinding,
} from '../sites/telegram/bindings.js';

class BindingsDb {
  bindings = [
    { telegram_user_id: 'user-1', project_id: 'project-a', updated_at: '2026-08-14T09:00:00.000Z' },
    { telegram_user_id: 'user-1', project_id: 'project-b', updated_at: '2026-08-14T10:00:00.000Z' },
    { telegram_user_id: 'user-2', project_id: 'project-c', updated_at: '2026-08-14T11:00:00.000Z' },
  ];

  selections = new Map([
    ['user-1:chat-1', 'project-b'],
    ['user-2:chat-2', 'project-c'],
  ]);

  saved: unknown[] | null = null;

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        all: async () => ({
          results: this.bindings.filter((item) => item.telegram_user_id === args[0]),
        }),
        first: async () => {
          if (sql.includes('FROM telegram_user_chat_projects')) {
            const projectId = this.selections.get(`${args[0]}:${args[1]}`);
            return projectId ? { project_id: projectId } : null;
          }
          return this.bindings.find((item) => (
            item.telegram_user_id === args[0] && item.project_id === args[1]
          )) ?? null;
        },
        run: async () => {
          this.saved = args;
          return { changes: 1 };
        },
      }),
    };
  }
}

const ensureSchema = async () => undefined;

test('multiple Telegram bindings require a project selected by the same user and chat', async () => {
  const db = new BindingsDb();

  assert.equal((await bindingForTelegramUser(db, 'user-1', 'chat-1', ensureSchema))?.project_id, 'project-b');
  assert.equal(await bindingForTelegramUser(db, 'user-1', 'chat-2', ensureSchema), null);
  assert.equal(await bindingForTelegramUser(db, 'user-1', 'chat-without-selection', ensureSchema), null);
});

test('Telegram project lookup is scoped to both user and project', async () => {
  const db = new BindingsDb();

  assert.equal((await bindingForTelegramProject(db, 'user-1', 'project-a', ensureSchema))?.project_id, 'project-a');
  assert.equal(await bindingForTelegramProject(db, 'user-1', 'project-c', ensureSchema), null);
});

test('Telegram project selection is stored for the composite user and chat owner', async () => {
  const db = new BindingsDb();

  await saveTelegramProjectSelection(db, 'user-1', 'chat-1', 'project-a');

  assert.deepEqual(db.saved?.slice(0, 3), ['user-1', 'chat-1', 'project-a']);
  assert.equal(selectTelegramBinding(db.bindings.filter((item) => item.telegram_user_id === 'user-1')), null);
});
