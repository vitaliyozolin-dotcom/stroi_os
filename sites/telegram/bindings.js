const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

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

export const claimTelegramBinding = async (db, {
  codeHash,
  claimId,
  now,
  telegramUserId,
  projectId,
  systemUserId,
  privateChatId,
  username,
  displayName,
  role,
}) => {
  const results = await db.batch([
    db.prepare(`
      UPDATE telegram_link_codes
      SET used_at = ?, claim_id = ?
      WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?
    `).bind(now, claimId, codeHash, now),
    db.prepare(`
      DELETE FROM telegram_user_chat_projects
      WHERE project_id = ?
        AND telegram_user_id IN (
          SELECT telegram_user_id FROM telegram_bindings
          WHERE project_id = ? AND system_user_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM telegram_link_codes WHERE code_hash = ? AND claim_id = ?
        )
    `).bind(projectId, projectId, systemUserId, codeHash, claimId),
    db.prepare(`
      DELETE FROM telegram_bindings
      WHERE project_id = ? AND system_user_id = ?
        AND EXISTS (
          SELECT 1 FROM telegram_link_codes WHERE code_hash = ? AND claim_id = ?
        )
    `).bind(projectId, systemUserId, codeHash, claimId),
    db.prepare(`
      INSERT INTO telegram_bindings (
        telegram_user_id, project_id, system_user_id, private_chat_id,
        username, display_name, role, bound_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM telegram_link_codes WHERE code_hash = ? AND claim_id = ?
      )
      ON CONFLICT(telegram_user_id, project_id) DO UPDATE SET
        system_user_id = excluded.system_user_id,
        private_chat_id = excluded.private_chat_id,
        username = excluded.username,
        display_name = excluded.display_name,
        role = excluded.role,
        bound_at = excluded.bound_at,
        updated_at = excluded.updated_at
    `).bind(
      telegramUserId, projectId, systemUserId, privateChatId,
      username, displayName, role, now, now, codeHash, claimId,
    ),
    db.prepare(`
      INSERT INTO telegram_user_chat_projects (telegram_user_id, chat_id, project_id, updated_at)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM telegram_link_codes WHERE code_hash = ? AND claim_id = ?
      )
      ON CONFLICT(telegram_user_id, chat_id) DO UPDATE SET
        project_id = excluded.project_id,
        updated_at = excluded.updated_at
    `).bind(telegramUserId, privateChatId, projectId, now, codeHash, claimId),
  ]);
  return changes(results?.[0]) === 1 && changes(results?.[3]) === 1;
};

export const unlinkTelegramBinding = async (db, projectId, systemUserId) => {
  const existing = await db.prepare(`
    SELECT telegram_user_id,private_chat_id
    FROM telegram_bindings WHERE project_id = ? AND system_user_id = ?
  `).bind(projectId, systemUserId).all();
  const results = await db.batch([
    db.prepare(`
      DELETE FROM telegram_user_chat_projects
      WHERE project_id = ?
        AND telegram_user_id IN (
          SELECT telegram_user_id FROM telegram_bindings
          WHERE project_id = ? AND system_user_id = ?
        )
    `).bind(projectId, projectId, systemUserId),
    db.prepare(`
      DELETE FROM telegram_link_codes
      WHERE project_id = ? AND system_user_id = ? AND used_at IS NULL
    `).bind(projectId, systemUserId),
    db.prepare(`
      DELETE FROM telegram_bindings WHERE project_id = ? AND system_user_id = ?
    `).bind(projectId, systemUserId),
  ]);
  return { removed: changes(results?.[2]), bindings: existing?.results ?? [] };
};
