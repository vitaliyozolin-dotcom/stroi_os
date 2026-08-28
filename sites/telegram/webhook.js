import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { constantTimeEqual } from '../lib/secret.js';
import { clean } from '../lib/validation.js';

const MAX_TELEGRAM_UPDATE_BYTES = 1024 * 1024;

export const createTelegramWebhookHandler = ({
  ensureSchema,
  rememberTelegramChatCandidates,
  flushTelegramOutbox,
  claimTelegramUpdate,
  readTelegramUpdateStatus,
  processTelegramUpdate,
  completeTelegramUpdate,
  failTelegramUpdate,
}) => async (request, env, context) => {
  const suppliedSecret = clean(request.headers.get('x-telegram-bot-api-secret-token'), 256);
  const expectedSecret = clean(env.TELEGRAM_WEBHOOK_SECRET, 256);
  if (!expectedSecret || !constantTimeEqual(suppliedSecret, expectedSecret)) {
    return json({ ok: false, error: 'webhook_authorization_required' }, 403);
  }
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'telegram_not_configured' }, 409);
  let update;
  try {
    update = await readJsonBodyLimited(request, MAX_TELEGRAM_UPDATE_BYTES);
  } catch (error) {
    const tooLarge = error?.message === 'payload_too_large';
    return json({ ok: false, error: tooLarge ? 'payload_too_large' : 'invalid_json' }, tooLarge ? 413 : 400);
  }
  const updateId = clean(String(update?.update_id ?? ''), 80);
  if (!updateId) return json({ ok: false, error: 'invalid_update' }, 422);
  await ensureSchema(env.DB);
  await rememberTelegramChatCandidates(env.DB, update);
  context.waitUntil(flushTelegramOutbox(env).catch(() => null));
  const updateLease = await claimTelegramUpdate(env.DB, updateId);
  if (!updateLease) {
    if (await readTelegramUpdateStatus(env.DB, updateId) === 'done') return json({ ok: true, duplicate: true });
    return json({ ok: false, error: 'telegram_update_busy' }, 503);
  }
  try {
    await processTelegramUpdate(update, env);
    await completeTelegramUpdate(env.DB, updateId, updateLease);
    return json({ ok: true, accepted: true });
  } catch (error) {
    await failTelegramUpdate(env.DB, updateId, updateLease, error);
    // Telegram повторит webhook после non-2xx. Детерминированные draft/source IDs
    // не позволяют повторной доставке создать вторую бизнес-запись.
    return json({ ok: false, error: 'telegram_update_failed' }, 503);
  }
};
