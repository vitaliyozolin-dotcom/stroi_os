import { clean } from '../lib/validation.js';
import { telegramSend } from './transport.js';
import { telegramHelp } from './rendering.js';
import { claimTelegramBinding } from './bindings.js';
import { reviveTelegramOutbox } from './outbox.js';

export const createTelegramRegistration = ({ readSnapshot, sha256, mutateProjectFromTelegram }) => {
  const telegramDisplayName = (from) => clean([from?.first_name, from?.last_name].filter(Boolean).join(' '), 160)
    || clean(from?.username, 120)
    || `Telegram ${String(from?.id ?? '')}`;

  const reconcileTelegramUserState = async (env, projectId, user, from, privateChatId, now) => mutateProjectFromTelegram(
    env,
    projectId,
    user.name,
    user.role,
    'telegram.bind',
    `Telegram подключён: ${user.name}`,
    (state) => {
      state.settings.users = (state.settings?.users ?? []).map((item) => item.id === user.id ? {
        ...item,
        telegram: from.username ? `@${clean(from.username, 120)}` : item.telegram,
        telegramChatId: privateChatId,
        telegramBoundAt: now,
      } : item);
      const alreadyRecorded = (state.activity ?? []).some((item) => item.text === 'Подключил личный Telegram к ИКИОМА ОС'
        && item.actor === user.name && item.timestamp === now);
      if (!alreadyRecorded) {
        state.activity = [{
          id: `activity-${crypto.randomUUID()}`,
          timestamp: now,
          actor: user.name,
          text: 'Подключил личный Telegram к ИКИОМА ОС',
          tone: 'neutral',
        }, ...(state.activity ?? [])];
      }
    },
  );

  const bindTelegramUser = async (message, code, env) => {
    const chat = message?.chat;
    const from = message?.from;
    if (chat?.type !== 'private' || !from?.id) {
      if (chat?.id) await telegramSend(env.TELEGRAM_BOT_TOKEN, chat.id, 'Персональную привязку нужно открыть в личном чате с ботом.');
      return;
    }
    const codeHash = await sha256(code);
    const row = await env.DB.prepare(`
      SELECT code_hash, project_id, system_user_id, expires_at, used_at, claim_id
      FROM telegram_link_codes
      WHERE code_hash = ?
    `).bind(codeHash).first();
    if (!row || row.expires_at < new Date().toISOString()) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, chat.id, 'Ссылка недействительна или уже использована. Попросите руководителя выпустить новую в ИКИОМА ОС.');
      return;
    }
    const snapshot = await readSnapshot(env.DB, row.project_id);
    const user = (snapshot?.state?.settings?.users ?? []).find((item) => item.id === row.system_user_id && item.status !== 'disabled');
    if (!snapshot || !user) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, chat.id, 'Участник или проект больше не доступны. Попросите руководителя проверить настройки.');
      return;
    }

    const telegramUserId = String(from.id);
    const privateChatId = String(chat.id);
    const existingBinding = row.used_at ? await env.DB.prepare(`
      SELECT telegram_user_id,private_chat_id,bound_at
      FROM telegram_bindings
      WHERE project_id = ? AND system_user_id = ? AND telegram_user_id = ?
    `).bind(row.project_id, row.system_user_id, telegramUserId).first() : null;
    if (row.used_at && !existingBinding) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, chat.id, 'Ссылка уже использована другим подключением. Попросите руководителя выпустить новую в ИКИОМА ОС.');
      return;
    }

    const now = existingBinding?.bound_at || new Date().toISOString();
    if (!existingBinding) {
      const claimed = await claimTelegramBinding(env.DB, {
        codeHash,
        claimId: crypto.randomUUID(),
        now,
        telegramUserId,
        projectId: row.project_id,
        systemUserId: row.system_user_id,
        privateChatId,
        username: clean(from.username, 120),
        displayName: telegramDisplayName(from),
        role: user.role,
      });
      if (!claimed) {
        await telegramSend(env.TELEGRAM_BOT_TOKEN, chat.id, 'Ссылка уже использована другим подключением. Попросите руководителя выпустить новую в ИКИОМА ОС.');
        return;
      }
    }

    try {
      await reconcileTelegramUserState(env, row.project_id, user, from, privateChatId, now);
    } catch {
      // telegram_bindings — источник истины. Повторный /start безопасно восстановит снимок проекта.
    }
    await telegramSend(
      env.TELEGRAM_BOT_TOKEN,
      privateChatId,
      `Готово, ${user.name}. Вы подключены к проекту «${snapshot.state.project?.name ?? snapshot.state.project?.code}».\n\n${telegramHelp(user.role)}`,
    );
    await reviveTelegramOutbox(env.DB, privateChatId);
  };

  return { bindTelegramUser };
};
