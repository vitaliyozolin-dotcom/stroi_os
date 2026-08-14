export const bindingForTelegramProject = async (db, telegramUserId, projectId, ensureSchema) => {
  await ensureSchema(db);
  return db.prepare(`
    SELECT telegram_user_id, project_id, system_user_id, private_chat_id, username, display_name, role, bound_at, updated_at
    FROM telegram_bindings
    WHERE telegram_user_id = ? AND project_id = ?
  `).bind(telegramUserId, projectId).first();
};

export const bindingsForTelegramUser = async (db, telegramUserId, ensureSchema) => {
  await ensureSchema(db);
  const result = await db.prepare(`
    SELECT telegram_user_id, project_id, system_user_id, private_chat_id, username, display_name, role, bound_at, updated_at
    FROM telegram_bindings
    WHERE telegram_user_id = ?
    ORDER BY updated_at DESC
  `).bind(telegramUserId).all();
  return result?.results ?? [];
};

export const selectTelegramBinding = (bindings, selectedProjectId = '') => {
  if (selectedProjectId) {
    const selected = bindings.find((item) => item.project_id === selectedProjectId);
    if (selected) return selected;
  }
  return bindings.length === 1 ? bindings[0] : null;
};

export const bindingForTelegramUser = async (db, telegramUserId, chatId, ensureSchema) => {
  const bindings = await bindingsForTelegramUser(db, telegramUserId, ensureSchema);
  if (!bindings.length) return null;
  if (chatId) {
    const mapped = await db.prepare(`
      SELECT project_id
      FROM telegram_user_chat_projects
      WHERE telegram_user_id = ? AND chat_id = ?
    `).bind(telegramUserId, chatId).first();
    const selected = selectTelegramBinding(bindings, mapped?.project_id);
    if (selected) return selected;
  }
  return selectTelegramBinding(bindings);
};

export const saveTelegramProjectSelection = async (db, telegramUserId, chatId, projectId) => {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO telegram_user_chat_projects (telegram_user_id, chat_id, project_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_user_id, chat_id) DO UPDATE SET
      project_id = excluded.project_id,
      updated_at = excluded.updated_at
  `).bind(telegramUserId, chatId, projectId, now).run();
};
