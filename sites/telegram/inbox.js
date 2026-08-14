import { clean } from '../lib/validation.js';

export const TELEGRAM_UPDATE_LEASE_MS = 360_000;

const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export const claimTelegramUpdate = async (db, updateId, {
  now = new Date(),
  processingTtlMs = TELEGRAM_UPDATE_LEASE_MS,
} = {}) => {
  const claimedAt = now.toISOString();
  const inserted = await db.prepare(`
    INSERT INTO telegram_updates (update_id, received_at, processed_at, status, error)
    VALUES (?, ?, NULL, 'processing', NULL)
    ON CONFLICT(update_id) DO NOTHING
  `).bind(updateId, claimedAt).run();
  if (changes(inserted) === 1) return claimedAt;

  const existing = await db.prepare(`
    SELECT status, received_at
    FROM telegram_updates
    WHERE update_id = ?
  `).bind(updateId).first();
  if (!existing || existing.status === 'done') return null;
  if (existing.status === 'processing') {
    const receivedAt = Date.parse(clean(existing.received_at, 80));
    if (Number.isFinite(receivedAt) && now.getTime() - receivedAt <= processingTtlMs) return null;
    const reclaimed = await db.prepare(`
      UPDATE telegram_updates
      SET received_at = ?, processed_at = NULL, status = 'processing', error = NULL
      WHERE update_id = ? AND status = 'processing' AND received_at = ?
    `).bind(claimedAt, updateId, existing.received_at).run();
    return changes(reclaimed) === 1 ? claimedAt : null;
  }
  if (existing.status === 'error') {
    const retried = await db.prepare(`
      UPDATE telegram_updates
      SET received_at = ?, processed_at = NULL, status = 'processing', error = NULL
      WHERE update_id = ? AND status = 'error'
    `).bind(claimedAt, updateId).run();
    return changes(retried) === 1 ? claimedAt : null;
  }
  return null;
};

export const readTelegramUpdateStatus = async (db, updateId) => {
  const row = await db.prepare(`
    SELECT status
    FROM telegram_updates
    WHERE update_id = ?
  `).bind(updateId).first();
  return clean(row?.status, 40);
};

export const completeTelegramUpdate = async (db, updateId, lease, { now = new Date() } = {}) => {
  const result = await db.prepare(`
    UPDATE telegram_updates
    SET status = 'done', processed_at = ?, error = NULL
    WHERE update_id = ? AND status = 'processing' AND received_at = ?
  `).bind(now.toISOString(), updateId, lease).run();
  return changes(result) === 1;
};

export const failTelegramUpdate = async (db, updateId, lease, error, { now = new Date() } = {}) => {
  const result = await db.prepare(`
    UPDATE telegram_updates
    SET status = 'error', processed_at = ?, error = ?
    WHERE update_id = ? AND status = 'processing' AND received_at = ?
  `).bind(
    now.toISOString(),
    clean(error instanceof Error ? error.message : error || 'processing_failed', 300),
    updateId,
    lease,
  ).run();
  return changes(result) === 1;
};
