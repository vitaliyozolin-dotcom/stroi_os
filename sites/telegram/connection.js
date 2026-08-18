import { clean } from '../lib/validation.js';
import { parseTelegramBody, telegramRequest, telegramSend } from './transport.js';

const TELEGRAM_CONFIG_PROJECT_ID = '__integration__:telegram';

export const createTelegramConnection = ({ ensureSchema, readSnapshot, reviveTelegramOutbox }) => {
  const telegramChatCandidates = (updates) => {
    const chats = new Map();
    for (const update of updates ?? []) {
      const candidates = [
        update?.message?.chat,
        update?.edited_message?.chat,
        update?.channel_post?.chat,
        update?.edited_channel_post?.chat,
        update?.my_chat_member?.chat,
        update?.chat_member?.chat,
      ];
      for (const chat of candidates) {
        if (!chat || !['group', 'supergroup'].includes(chat.type) || chat.id === undefined || chat.id === null) continue;
        const id = String(chat.id);
        chats.set(id, {
          id,
          title: clean(chat.title, 160) || 'Общий Telegram-чат',
          type: chat.type,
        });
      }
    }
    return [...chats.values()];
  };

  const rememberTelegramChatCandidates = async (db, update) => {
    if (!db) return;
    const candidates = telegramChatCandidates([update]);
    if (!candidates.length) return;
    await ensureSchema(db);
    const observedAt = new Date().toISOString();
    for (const chat of candidates) {
      await db.prepare(`
        INSERT INTO telegram_chat_candidates (chat_id, title, type, observed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          title = excluded.title,
          type = excluded.type,
          observed_at = excluded.observed_at
      `).bind(chat.id, chat.title, chat.type, observedAt).run();
    }
  };

  const readObservedTelegramChats = async (db) => {
    if (!db) return [];
    await ensureSchema(db);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await db.prepare(`
      SELECT chat_id, title, type
      FROM telegram_chat_candidates
      WHERE observed_at >= ?
      ORDER BY observed_at DESC
      LIMIT 20
    `).bind(cutoff).all();
    return (result?.results ?? []).map((row) => ({
      id: clean(row.chat_id, 120),
      title: clean(row.title, 160) || 'Общий Telegram-чат',
      type: clean(row.type, 40) || 'group',
    })).filter((chat) => chat.id);
  };

  const readTelegramBot = async (token) => {
    try {
      const response = await telegramRequest(token, 'getMe');
      const body = await parseTelegramBody(response);
      return response.ok && body?.ok ? body.result : null;
    } catch {
      return null;
    }
  };

  const discoverTelegramChats = async (token) => {
    try {
      const [botResponse, updatesResponse] = await Promise.all([
        telegramRequest(token, 'getMe'),
        telegramRequest(token, 'getUpdates', {
          timeout: 0,
          allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member', 'chat_member'],
        }),
      ]);
      const [botBody, updatesBody] = await Promise.all([
        parseTelegramBody(botResponse),
        parseTelegramBody(updatesResponse),
      ]);
      if (!botResponse.ok || !botBody?.ok) return { ok: false, issue: 'invalid_token', bot: null, candidates: [] };
      if (!updatesResponse.ok || !updatesBody?.ok) return { ok: false, issue: 'updates_unavailable', bot: botBody.result, candidates: [] };
      return {
        ok: true,
        issue: '',
        bot: botBody.result,
        candidates: telegramChatCandidates(updatesBody.result),
      };
    } catch {
      return { ok: false, issue: 'provider_unavailable', bot: null, candidates: [] };
    }
  };

  const readTelegramConfig = async (db) => {
    if (!db) return null;
    await ensureSchema(db);
    const snapshot = await readSnapshot(db, TELEGRAM_CONFIG_PROJECT_ID);
    const telegram = snapshot?.state?.telegram;
    const chatId = clean(telegram?.chatId, 120);
    if (!chatId) return null;
    return {
      chat: {
        id: chatId,
        title: clean(telegram?.chatTitle, 160) || 'Общий Telegram-чат',
        type: clean(telegram?.chatType, 40) || 'group',
      },
      bot: telegram?.bot && typeof telegram.bot === 'object' ? telegram.bot : null,
      verifiedAt: clean(telegram?.verifiedAt, 60),
    };
  };

  const telegramGroupChatAuthorized = async (env, chatId) => {
    const expected = clean(env.TELEGRAM_COMMON_CHAT_ID, 120) || clean(env.TELEGRAM_CHAT_ID, 120);
    if (expected) return String(chatId) === expected;
    const stored = await readTelegramConfig(env.DB);
    return Boolean(stored?.chat?.id && String(chatId) === String(stored.chat.id));
  };

  const writeTelegramConfig = async (db, chat, bot) => {
    if (!db) return;
    await ensureSchema(db);
    const now = new Date().toISOString();
    const stateJson = JSON.stringify({
      version: 1,
      project: { id: TELEGRAM_CONFIG_PROJECT_ID },
      telegram: {
        chatId: clean(chat.id, 120),
        chatTitle: clean(chat.title, 160),
        chatType: clean(chat.type, 40),
        bot: bot ? {
          id: String(bot.id ?? ''),
          username: clean(bot.username, 120),
          name: clean(bot.first_name, 120),
        } : null,
        verifiedAt: now,
      },
    });
    await db.prepare(`
      INSERT INTO project_state (
        project_id, state_json, revision, created_at, updated_at, updated_by, updated_role
      ) VALUES (?, ?, 1, ?, ?, 'telegram-setup', 'management')
      ON CONFLICT(project_id) DO UPDATE SET
        state_json = excluded.state_json,
        revision = project_state.revision + 1,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        updated_role = excluded.updated_role
    `).bind(TELEGRAM_CONFIG_PROJECT_ID, stateJson, now, now).run();
  };

  const verifyAndStoreTelegramChat = async (env, chat, bot) => {
    try {
      const response = await telegramSend(
        env.TELEGRAM_BOT_TOKEN,
        chat.id,
        'ИКИОМА ОС: общий чат подключён.\n\nСюда будут приходить изменения по проектам, этапам, задачам, закупкам и проверкам.',
      );
      if (!response.ok) return { ok: false, issue: 'send_failed' };
      await writeTelegramConfig(env.DB, chat, bot);
      await reviveTelegramOutbox(env.DB, chat.id);
      return { ok: true, issue: '' };
    } catch {
      return { ok: false, issue: 'provider_unavailable' };
    }
  };

  const resolveTelegramConnection = async (env, { discover = true } = {}) => {
    const tokenConfigured = Boolean(env.TELEGRAM_BOT_TOKEN);
    const environmentChatId = clean(env.TELEGRAM_COMMON_CHAT_ID, 120) || clean(env.TELEGRAM_CHAT_ID, 120);
    if (!tokenConfigured) return { tokenConfigured: false, chat: null, bot: null, candidates: [], issue: 'token_missing' };
    if (environmentChatId) return { tokenConfigured: true, chat: { id: environmentChatId, title: 'Общий Telegram-чат', type: 'group' }, bot: null, candidates: [], issue: '' };

    const stored = await readTelegramConfig(env.DB);
    if (stored?.chat) return { tokenConfigured: true, ...stored, candidates: [], issue: '' };
    if (!discover) return { tokenConfigured: true, chat: null, bot: null, candidates: [], issue: 'chat_missing' };

    const observedCandidates = await readObservedTelegramChats(env.DB);
    if (observedCandidates.length) {
      const bot = await readTelegramBot(env.TELEGRAM_BOT_TOKEN);
      if (observedCandidates.length !== 1) return { tokenConfigured: true, chat: null, bot, candidates: observedCandidates, issue: 'chat_ambiguous' };
      const chat = observedCandidates[0];
      const verification = await verifyAndStoreTelegramChat(env, chat, bot);
      if (!verification.ok) return { tokenConfigured: true, chat: null, bot, candidates: observedCandidates, issue: verification.issue };
      return { tokenConfigured: true, chat, bot, candidates: [], issue: '', verifiedAt: new Date().toISOString() };
    }

    const discovered = await discoverTelegramChats(env.TELEGRAM_BOT_TOKEN);
    if (!discovered.ok) return { tokenConfigured: true, chat: null, ...discovered };
    if (discovered.candidates.length !== 1) return {
      tokenConfigured: true,
      chat: null,
      bot: discovered.bot,
      candidates: discovered.candidates,
      issue: discovered.candidates.length ? 'chat_ambiguous' : 'chat_not_found',
    };
    const chat = discovered.candidates[0];
    const verification = await verifyAndStoreTelegramChat(env, chat, discovered.bot);
    if (!verification.ok) return { tokenConfigured: true, chat: null, bot: discovered.bot, candidates: discovered.candidates, issue: verification.issue };
    return { tokenConfigured: true, chat, bot: discovered.bot, candidates: [], issue: '', verifiedAt: new Date().toISOString() };
  };

  return {
    discoverTelegramChats,
    readTelegramBot,
    readTelegramConfig,
    rememberTelegramChatCandidates,
    resolveTelegramConnection,
    telegramGroupChatAuthorized,
    verifyAndStoreTelegramChat,
  };
};
