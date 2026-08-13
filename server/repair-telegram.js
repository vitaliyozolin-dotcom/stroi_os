import { pathToFileURL } from 'node:url';

const TELEGRAM_CONFIG_PROJECT_ID = '__integration__:telegram';
const GROUP_TYPES = new Set(['group', 'supergroup']);

const messageChat = (update) => (
  update?.message?.chat
  ?? update?.edited_message?.chat
  ?? update?.channel_post?.chat
  ?? update?.edited_channel_post?.chat
  ?? update?.my_chat_member?.chat
  ?? update?.chat_member?.chat
  ?? null
);

const updateText = (update) => String(
  update?.message?.text
  ?? update?.edited_message?.text
  ?? update?.channel_post?.text
  ?? update?.edited_channel_post?.text
  ?? '',
).trim();

const normalizeTitle = (value) => String(value ?? '')
  .trim()
  .toLocaleLowerCase('ru')
  .replace(/[^a-zа-яё0-9]+/giu, '');

export const telegramGroupCandidates = (updates) => {
  const candidates = new Map();
  for (const update of updates ?? []) {
    const chat = messageChat(update);
    if (!chat || !GROUP_TYPES.has(chat.type) || chat.id === undefined || chat.id === null) continue;
    const id = String(chat.id);
    const previous = candidates.get(id);
    const updateId = Number(update?.update_id ?? -1);
    if (previous && previous.updateId > updateId) continue;
    candidates.set(id, {
      id,
      title: String(chat.title ?? '').trim() || 'Общий Telegram-чат',
      type: chat.type,
      update,
      updateId,
      text: updateText(update),
    });
  }
  return [...candidates.values()].sort((left, right) => right.updateId - left.updateId);
};

export const selectTelegramGroup = (updates, botUsername = 'ikioma_bot', manualChatId = '') => {
  const candidates = telegramGroupCandidates(updates);
  if (manualChatId) return candidates.find((candidate) => candidate.id === String(manualChatId)) ?? null;
  if (candidates.length === 1) return candidates[0];

  const escapedUsername = String(botUsername).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startCommand = new RegExp(`^/start(?:@${escapedUsername})?(?:\\s|$)`, 'iu');
  const commandCandidates = candidates.filter((candidate) => startCommand.test(candidate.text));
  if (commandCandidates.length === 1) return commandCandidates[0];

  const titleCandidates = candidates.filter((candidate) => {
    const title = normalizeTitle(candidate.title);
    return title === 'икиома' || title === 'ikioma';
  });
  return titleCandidates.length === 1 ? titleCandidates[0] : null;
};

const requiredEnv = (name) => {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`Не задан ${name}`);
  return value;
};

const telegramApi = async (token, method, payload = {}, timeoutMs = 25_000) => {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const description = String(body?.description ?? `HTTP ${response.status}`).slice(0, 300);
    throw new Error(`Telegram ${method}: ${description}`);
  }
  return body.result;
};

const setWebhook = (token, webhookUrl, webhookSecret) => telegramApi(token, 'setWebhook', {
  url: webhookUrl,
  secret_token: webhookSecret,
  allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  drop_pending_updates: false,
});

const collectGroupUpdate = async (token, botUsername) => {
  let updates = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const timeout = attempt === 0 ? 0 : 12;
    const batch = await telegramApi(token, 'getUpdates', {
      timeout,
      allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member', 'chat_member'],
    }, (timeout + 10) * 1000);
    updates = batch ?? [];
    if (telegramGroupCandidates(updates).length) return updates;
    if (attempt === 0) {
      console.log(`Ожидаю команду /start@${botUsername} в группе «ИкиОМА» (до 48 секунд)…`);
    }
  }
  return updates;
};

const saveTelegramChat = async (databaseUrl, chat, bot) => {
  const pgModule = await import('pg');
  const Pool = pgModule.Pool ?? pgModule.default?.Pool;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const now = new Date().toISOString();
  const stateJson = JSON.stringify({
    version: 1,
    project: { id: TELEGRAM_CONFIG_PROJECT_ID },
    telegram: {
      chatId: chat.id,
      chatTitle: chat.title,
      chatType: chat.type,
      bot: {
        id: String(bot.id ?? ''),
        username: String(bot.username ?? ''),
        name: String(bot.first_name ?? ''),
      },
      verifiedAt: now,
    },
  });

  try {
    await pool.query('BEGIN');
    await pool.query(`
      INSERT INTO project_state (
        project_id, state_json, revision, created_at, updated_at, updated_by, updated_role
      ) VALUES ($1, $2, 1, $3, $3, 'telegram-repair', 'management')
      ON CONFLICT (project_id) DO UPDATE SET
        state_json = EXCLUDED.state_json,
        revision = project_state.revision + 1,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by,
        updated_role = EXCLUDED.updated_role
    `, [TELEGRAM_CONFIG_PROJECT_ID, stateJson, now]);
    await pool.query(`
      INSERT INTO telegram_chat_candidates (chat_id, title, type, observed_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (chat_id) DO UPDATE SET
        title = EXCLUDED.title,
        type = EXCLUDED.type,
        observed_at = EXCLUDED.observed_at
    `, [chat.id, chat.title, chat.type, now]);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await pool.end();
  }
};

const replayUpdateThroughWebhook = async (webhookUrl, webhookSecret, update) => {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': webhookSecret,
    },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(20_000),
  });
  if (![200, 202].includes(response.status)) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`Webhook ИКИОМА ОС вернул HTTP ${response.status}: ${body}`);
  }
};

export const runTelegramRepair = async () => {
  const token = requiredEnv('TELEGRAM_BOT_TOKEN');
  const webhookUrl = requiredEnv('TELEGRAM_WEBHOOK_URL');
  const webhookSecret = requiredEnv('TELEGRAM_WEBHOOK_SECRET');
  const databaseUrl = requiredEnv('DATABASE_URL');
  let webhookRestored = false;

  const bot = await telegramApi(token, 'getMe');
  const botUsername = String(bot?.username ?? '').trim();
  if (botUsername !== 'ikioma_bot') throw new Error(`Подключён @${botUsername || 'неизвестный бот'}, нужен @ikioma_bot`);

  console.log('1/5 Бот подтверждён: @ikioma_bot');
  await telegramApi(token, 'deleteWebhook', { drop_pending_updates: false });
  console.log('2/5 Забираю уже отправленную команду из очереди Telegram…');

  try {
    const updates = await collectGroupUpdate(token, botUsername);
    const candidates = telegramGroupCandidates(updates);
    const selected = selectTelegramGroup(
      updates,
      botUsername,
      String(process.env.TELEGRAM_REPAIR_CHAT_ID ?? '').trim(),
    );
    if (!selected) {
      const found = candidates.length
        ? candidates.map((candidate) => `«${candidate.title}» (${candidate.id})`).join(', ')
        : 'ни одной группы';
      throw new Error(`Не удалось однозначно выбрать «ИкиОМА»: найдено ${found}. Повторите команду и запустите восстановление ещё раз.`);
    }

    await saveTelegramChat(databaseUrl, selected, bot);
    console.log(`3/5 Группа сохранена: «${selected.title}»`);

    await setWebhook(token, webhookUrl, webhookSecret);
    webhookRestored = true;
    await replayUpdateThroughWebhook(webhookUrl, webhookSecret, selected.update);
    console.log('4/5 Входящий webhook принят ИКИОМА ОС');

    const confirmation = await telegramApi(token, 'sendMessage', {
      chat_id: selected.id,
      text: '✅ ИКИОМА ОС: общий чат подключён. Входящие команды и исходящие уведомления проверены.',
      disable_web_page_preview: true,
    });
    if (!confirmation?.message_id) throw new Error('Telegram не подтвердил отправку проверочного сообщения');

    const webhookInfo = await telegramApi(token, 'getWebhookInfo');
    if (String(webhookInfo?.url ?? '') !== webhookUrl) throw new Error('Telegram сохранил неверный адрес webhook');
    console.log('5/5 Проверочное сообщение отправлено в группу');
    console.log(`TELEGRAM_READY group="${selected.title}" pending=${Number(webhookInfo?.pending_update_count ?? 0)}`);
  } finally {
    if (!webhookRestored) {
      await setWebhook(token, webhookUrl, webhookSecret).catch((error) => {
        console.error(`Не удалось автоматически вернуть webhook: ${error.message}`);
      });
    }
  }
};

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runTelegramRepair().catch((error) => {
    console.error(`TELEGRAM_REPAIR_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
