import { clean } from '../lib/validation.js';
import { telegramCheckedRequest, telegramMessageText, telegramRequest } from './transport.js';
import { telegramDurableSend } from './outbox.js';

export const telegramAnswerCallback = async (token, callbackQueryId, text = '', showAlert = false) => {
  try {
    return await telegramCheckedRequest(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    });
  } catch {
    // A stale callback acknowledgement must not block the idempotent action or
    // the visible chat confirmation that follows it.
    return null;
  }
};

export const telegramEditMessage = async (token, chatId, messageId, text, replyMarkup) => {
  try {
    return await telegramCheckedRequest(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: telegramMessageText(text),
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  } catch (error) {
    if (error instanceof Error && /message is not modified/iu.test(error.message)) return null;
    throw error;
  }
};

export const telegramConfirmVisible = async (env, chatId, messageId, text, replyMarkup) => {
  try {
    await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, replyMarkup);
    return 'edited';
  } catch {
    const options = replyMarkup ? { reply_markup: replyMarkup } : {};
    return telegramDurableVisibility(env, chatId, text, options, `telegram-confirm:${chatId}:${messageId}`);
  }
};

export const telegramDurableVisibility = async (env, chatId, text, options, stableId) => {
  try {
    const sent = await telegramDurableSend(env, chatId, text, options, stableId);
    if (sent) return 'sent';
    if (!env.DB) return 'undelivered';
    const row = await env.DB.prepare(`
      SELECT status
      FROM telegram_outbox
      WHERE id = ?
    `).bind(clean(stableId, 180)).first();
    return row && row.status !== 'dead' ? 'queued' : 'undelivered';
  } catch {
    return 'undelivered';
  }
};

export const requireTelegramVisibility = (status) => {
  if (status === 'undelivered') throw new Error('telegram_confirmation_unavailable');
};

export const telegramSendPhoto = (token, chatId, photo, caption, options = {}) => telegramRequest(token, 'sendPhoto', {
  chat_id: chatId,
  photo,
  caption: telegramMessageText(caption, 1000),
  ...options,
});
