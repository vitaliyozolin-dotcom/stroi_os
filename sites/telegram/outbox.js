import { clean } from '../lib/validation.js';
import { telegramSend } from './transport.js';
import { qualityRequestStillNeeded } from '../automations/project-coordinator.js';

const TELEGRAM_OUTBOX_LEASE_MS = 120_000;
const TELEGRAM_OUTBOX_RETRY_MS = 30_000;

const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export const queueTelegramMessage = async (db, chatId, text, options = {}, stableId = '') => {
  const id = clean(stableId, 180) || `telegram-outbox-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO telegram_outbox (
      id, chat_id, text, options_json, status, attempts, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).bind(id, String(chatId), text, JSON.stringify(options ?? {}), now, now).run();
  return id;
};

export const telegramOutboxRetryReady = (row, now = Date.now()) => {
  if (row.status === 'pending') return true;
  // A crashed sender may already have delivered. Never replay an uncertain send blindly.
  if (row.status !== 'failed') return false;
  const updatedAt = Date.parse(clean(row.updated_at, 80));
  if (!Number.isFinite(updatedAt)) return true;
  if (row.status === 'failed') return now - updatedAt >= TELEGRAM_OUTBOX_RETRY_MS;
  return false;
};

export const claimTelegramOutbox = async (db, row) => {
  if (!row || ['sent', 'canceled', 'uncertain', 'dead'].includes(row.status) || !telegramOutboxRetryReady(row)) return null;
  const lease = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE telegram_outbox
    SET status = 'sending', attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status = ? AND updated_at = ? AND attempts = ?
  `).bind(lease, row.id, row.status, row.updated_at, Number(row.attempts)).run();
  return changes(result) === 1
    ? { ...row, status: 'sending', attempts: Number(row.attempts) + 1, updated_at: lease }
    : null;
};

export const finishTelegramOutbox = async (db, claimed, status, error = '') => {
  const result = await db.prepare(`
    UPDATE telegram_outbox
    SET status = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'sending' AND updated_at = ?
  `).bind(status, clean(error, 300) || null, new Date().toISOString(), claimed.id, claimed.updated_at).run();
  return changes(result) === 1;
};

export const reviveTelegramOutbox = async (db, chatId) => {
  if (!db || !chatId) return;
  await db.prepare(`
    UPDATE telegram_outbox
    SET status = 'failed', attempts = 0, last_error = 'retry_after_reconnect', updated_at = '1970-01-01T00:00:00.000Z'
    WHERE chat_id = ? AND status = 'dead'
  `).bind(String(chatId)).run();
};

export const deliverTelegramOutbox = async (env, row) => {
  const claimed = await claimTelegramOutbox(env.DB, row);
  if (!claimed) return false;
  let options = {};
  try { options = JSON.parse(claimed.options_json || '{}'); } catch { options = {}; }
  let sendStarted = false;
  try {
    const qualityRequest = options._qualityRequest;
    delete options._qualityRequest;
    delete options._deliveryReceipt;
    if (qualityRequest) {
      const snapshot = await env.DB.prepare('SELECT state_json FROM project_state WHERE project_id = ?').bind(qualityRequest.projectId).first();
      const state = snapshot?.state_json ? JSON.parse(snapshot.state_json) : null;
      if (!qualityRequestStillNeeded(state, qualityRequest.checkpointId)) {
        await finishTelegramOutbox(env.DB, claimed, 'canceled', 'quality_request_resolved');
        return false;
      }
    }
    sendStarted = true;
    const response = await telegramSend(env.TELEGRAM_BOT_TOKEN, claimed.chat_id, claimed.text, options);
    const receipt = await response.clone().json().catch(() => null);
    if (receipt?.ok === false) throw new Error(`telegram_send_failed:400:${receipt.description || 'rejected'}`);
    await finishTelegramOutbox(env.DB, claimed, 'sent');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'telegram_send_failed';
    const terminal = /^telegram_send_failed:(?:400|401|403|404):/u.test(message);
    const uncertain = sendStarted && !/^telegram_send_failed:\d{3}:/u.test(message);
    await finishTelegramOutbox(env.DB, claimed, terminal ? 'dead' : uncertain ? 'uncertain' : 'failed', uncertain ? 'delivery_unconfirmed: verify before retry' : message);
    return false;
  }
};

export const telegramDurableSend = async (env, chatId, text, options = {}, stableId = '', waitForDelivery = true) => {
  if (!env.DB) return telegramSend(env.TELEGRAM_BOT_TOKEN, chatId, text, options);
  const id = await queueTelegramMessage(env.DB, chatId, text, options, stableId);
  const row = await env.DB.prepare(`
    SELECT id, chat_id, text, options_json, status, attempts, created_at, updated_at
    FROM telegram_outbox
    WHERE id = ?
  `).bind(id).first();
  if (row?.status === 'sent') return true;
  if (!waitForDelivery) {
    const delivery = deliverTelegramOutbox(env, row).catch(() => null);
    if (typeof env.WAIT_UNTIL === 'function') env.WAIT_UNTIL(delivery);
    else void delivery;
    return true;
  }
  return deliverTelegramOutbox(env, row);
};

export const flushTelegramOutbox = async (env, limit = 10, ensureSchema = async () => {}) => {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return { attempted: 0, delivered: 0 };
  await ensureSchema(env.DB);
  await env.DB.prepare(`UPDATE telegram_outbox SET status = 'uncertain', last_error = 'delivery_unconfirmed: expired sender lease', updated_at = ? WHERE status = 'sending' AND updated_at <= ?`).bind(new Date().toISOString(), new Date(Date.now() - TELEGRAM_OUTBOX_LEASE_MS).toISOString()).run();
  const pendingQuota = Math.max(1, Math.ceil(limit * 0.8));
  const pendingResult = await env.DB.prepare(`
    SELECT id, chat_id, text, options_json, status, attempts, created_at, updated_at
    FROM telegram_outbox
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(pendingQuota).all();
  const retryQuota = Math.max(1, limit - (pendingResult?.results?.length ?? 0));
  const failedBefore = new Date(Date.now() - TELEGRAM_OUTBOX_RETRY_MS).toISOString();
  const retryResult = await env.DB.prepare(`
    SELECT id, chat_id, text, options_json, status, attempts, created_at, updated_at
    FROM telegram_outbox
    WHERE status = 'failed' AND updated_at <= ?
    ORDER BY updated_at ASC
    LIMIT ?
  `).bind(failedBefore, retryQuota).all();
  const candidates = [
    ...(pendingResult?.results ?? []),
    ...(retryResult?.results ?? []),
  ].slice(0, limit);
  let attempted = 0;
  let delivered = 0;
  for (const row of candidates) {
    if (!telegramOutboxRetryReady(row)) continue;
    attempted += 1;
    if (await deliverTelegramOutbox(env, row)) delivered += 1;
  }
  return { attempted, delivered };
};
