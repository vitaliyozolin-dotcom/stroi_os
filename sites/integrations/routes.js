import { authenticatedIdentity } from '../access-control.js';
import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { clean } from '../lib/validation.js';

const MAX_JSON_BODY_BYTES = 32 * 1024;

const readPayload = async (request) => {
  try {
    return { payload: await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES) };
  } catch (error) {
    const tooLarge = error?.message === 'payload_too_large';
    return { response: json({ ok: false, error: tooLarge ? 'payload_too_large' : 'invalid_json' }, tooLarge ? 413 : 400) };
  }
};

export const createIntegrationHandlers = ({
  integrationStatus,
  resolveTelegramConnection,
  telegramSend,
  reviveTelegramOutbox,
  flushTelegramOutbox,
  readObservedTelegramChats,
  readTelegramBot,
  discoverTelegramChats,
  verifyAndStoreTelegramChat,
}) => {
  const status = async (request, env) => {
    const identity = authenticatedIdentity(request, env);
    if (!identity) return json({ ok: false, error: 'authentication_required' }, 401);
    const current = await integrationStatus(env);
    if (!identity.isOwner) current.telegramCandidates = [];
    return json({ ok: true, integrations: current });
  };

  const test = async (request, env) => {
    const identity = authenticatedIdentity(request, env);
    if (!identity?.isOwner) return json({ ok: false, error: 'owner_required' }, 403);
    const parsed = await readPayload(request);
    if (parsed.response) return parsed.response;
    const channel = clean(parsed.payload?.channel, 30);
    const message = clean(parsed.payload?.message, 500) || 'Тестовое уведомление ИКИОМА ОС';
    const current = await integrationStatus(env);
    if (channel === 'email') {
      const to = clean(parsed.payload?.to, 240);
      if (!current.email) return json({ ok: false, error: 'email_not_configured' }, 409);
      if (!/^\S+@\S+\.\S+$/.test(to)) return json({ ok: false, error: 'invalid_recipient' }, 422);
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: 'ИКИОМА ОС: тест уведомлений', html: `<p>${message.replace(/[<>&]/g, '')}</p>` }),
        });
        if (!response.ok) return json({ ok: false, error: 'provider_error' }, 502);
        return json({ ok: true, channel: 'email' });
      } catch {
        return json({ ok: false, error: 'provider_unavailable' }, 502);
      }
    }
    if (channel === 'telegram') {
      if (!current.telegram) return json({ ok: false, error: current.telegramIssue || 'telegram_not_configured' }, 409);
      try {
        const connection = await resolveTelegramConnection(env, { discover: false });
        const response = await telegramSend(env.TELEGRAM_BOT_TOKEN, connection.chat?.id, message);
        if (!response.ok) return json({ ok: false, error: 'provider_error' }, 502);
        await reviveTelegramOutbox(env.DB, connection.chat?.id);
        await flushTelegramOutbox(env);
        return json({ ok: true, channel: 'telegram' });
      } catch {
        return json({ ok: false, error: 'provider_unavailable' }, 502);
      }
    }
    return json({ ok: false, error: 'unsupported_channel' }, 422);
  };

  const telegramChatSelect = async (request, env) => {
    const identity = authenticatedIdentity(request, env);
    if (!identity?.isOwner) return json({ ok: false, error: 'owner_required' }, 403);
    if (!env.TELEGRAM_BOT_TOKEN || !env.DB) return json({ ok: false, error: 'telegram_not_configured' }, 409);
    const parsed = await readPayload(request);
    if (parsed.response) return parsed.response;
    const chatId = clean(parsed.payload?.chatId, 120);
    if (!chatId) return json({ ok: false, error: 'invalid_chat' }, 422);

    const observedCandidates = await readObservedTelegramChats(env.DB);
    let chat = observedCandidates.find((candidate) => candidate.id === chatId);
    let bot = await readTelegramBot(env.TELEGRAM_BOT_TOKEN);
    if (!chat) {
      const discovered = await discoverTelegramChats(env.TELEGRAM_BOT_TOKEN);
      if (!discovered.ok) return json({ ok: false, error: discovered.issue || 'provider_unavailable' }, 502);
      chat = discovered.candidates.find((candidate) => candidate.id === chatId);
      bot = discovered.bot;
    }
    if (!chat) return json({ ok: false, error: 'chat_not_found' }, 404);

    const verification = await verifyAndStoreTelegramChat(env, chat, bot);
    if (!verification.ok) return json({ ok: false, error: verification.issue || 'provider_error' }, 502);
    return json({ ok: true, chat: { title: chat.title, type: chat.type } });
  };

  return { status, test, telegramChatSelect };
};
