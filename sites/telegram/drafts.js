import { addDays } from '../lib/date.js';
import { clean } from '../lib/validation.js';

const TELEGRAM_DRAFT_LEASE_MS = 300_000;
const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
};

const shortId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);

export const createTelegramDraft = async (db, telegramUserId, chatId, projectId, kind, payload, sourceMessageId = '') => {
  const sourceKey = clean(sourceMessageId, 120);
  const id = sourceKey
    ? (await sha256(`telegram-draft:${telegramUserId}:${chatId}:${kind}:${sourceKey}`)).slice(0, 16)
    : shortId();
  const now = new Date();
  await db.prepare(`
    INSERT INTO telegram_drafts (
      id, telegram_user_id, chat_id, project_id, kind, payload_json, status, created_at, expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).bind(id, telegramUserId, chatId, projectId, kind, JSON.stringify(payload), now.toISOString(), addDays(now, 1).toISOString(), now.toISOString()).run();
  const row = await db.prepare(`
    SELECT id, telegram_user_id, chat_id, project_id, kind, payload_json, status, created_at, expires_at, updated_at
    FROM telegram_drafts
    WHERE id = ? AND telegram_user_id = ? AND chat_id = ? AND kind = ?
  `).bind(id, telegramUserId, chatId, kind).first();
  if (!row) throw new Error('draft_create_failed');
  try {
    return { ...row, payload: JSON.parse(row.payload_json) };
  } catch {
    throw new Error('draft_create_failed');
  }
};

export const readTelegramDraft = async (db, id, telegramUserId) => {
  let row = await db.prepare(`
    SELECT id, telegram_user_id, chat_id, project_id, kind, payload_json, status, created_at, expires_at, updated_at
    FROM telegram_drafts
    WHERE id = ? AND telegram_user_id = ?
  `).bind(id, telegramUserId).first();
  if (row?.status === 'processing') {
    const updatedAt = Date.parse(clean(row.updated_at, 80));
    const stale = !Number.isFinite(updatedAt) || Date.now() - updatedAt > TELEGRAM_DRAFT_LEASE_MS;
    if (stale) {
      const reclaimed = await db.prepare(`
        UPDATE telegram_drafts
        SET status = 'draft', updated_at = ?
        WHERE id = ? AND telegram_user_id = ? AND status = 'processing' AND updated_at = ?
      `).bind(new Date().toISOString(), id, telegramUserId, row.updated_at).run();
      if (changes(reclaimed) === 1) {
        row = await db.prepare(`
          SELECT id, telegram_user_id, chat_id, project_id, kind, payload_json, status, created_at, expires_at, updated_at
          FROM telegram_drafts
          WHERE id = ? AND telegram_user_id = ?
        `).bind(id, telegramUserId).first();
      }
    }
  }
  if (!row || row.status !== 'draft' || row.expires_at < new Date().toISOString()) return null;
  try {
    return { ...row, payload: JSON.parse(row.payload_json) };
  } catch {
    return null;
  }
};

export const updateTelegramDraft = async (db, draft, payload, status = 'draft') => {
  const expectedStatus = status === 'draft' ? 'draft' : 'processing';
  const result = await db.prepare(`
    UPDATE telegram_drafts
    SET payload_json = ?, status = ?, updated_at = ?
    WHERE id = ? AND status = ? AND updated_at = ?
  `).bind(JSON.stringify(payload), status, new Date().toISOString(), draft.id, expectedStatus, draft.updated_at).run();
  if (changes(result) !== 1) throw new Error('draft_state_conflict');
};

export const claimTelegramDraft = async (db, draft) => {
  const lease = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE telegram_drafts
    SET status = 'processing', updated_at = ?
    WHERE id = ? AND telegram_user_id = ? AND chat_id = ? AND status = 'draft' AND updated_at = ?
  `).bind(lease, draft.id, draft.telegram_user_id, draft.chat_id, draft.updated_at).run();
  return changes(result) === 1 ? lease : null;
};

export const readClaimedTelegramDraft = async (db, draft, lease) => {
  const row = await db.prepare(`
    SELECT id, telegram_user_id, chat_id, project_id, kind, payload_json, status, created_at, expires_at, updated_at
    FROM telegram_drafts
    WHERE id = ? AND telegram_user_id = ? AND chat_id = ? AND status = 'processing' AND updated_at = ?
  `).bind(draft.id, draft.telegram_user_id, draft.chat_id, lease).first();
  if (!row) throw new Error('draft_state_conflict');
  try {
    return { ...row, payload: JSON.parse(row.payload_json) };
  } catch {
    throw new Error('draft_state_conflict');
  }
};

export const assertTelegramDraftLease = async (db, draft) => {
  const row = await db.prepare(`
    SELECT id
    FROM telegram_drafts
    WHERE id = ? AND telegram_user_id = ? AND chat_id = ? AND status = 'processing' AND updated_at = ?
  `).bind(draft.id, draft.telegram_user_id, draft.chat_id, draft.updated_at).first();
  if (!row) throw new Error('draft_state_conflict');
};

export const saveClaimedTelegramDraftPayload = async (db, draft, payload) => {
  const updatedAt = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE telegram_drafts
    SET payload_json = ?, updated_at = ?
    WHERE id = ? AND status = 'processing' AND updated_at = ?
  `).bind(JSON.stringify(payload), updatedAt, draft.id, draft.updated_at).run();
  if (changes(result) !== 1) throw new Error('draft_state_conflict');
  return { ...draft, payload, payload_json: JSON.stringify(payload), updated_at: updatedAt };
};

export const releaseTelegramDraft = async (db, draft) => {
  await db.prepare(`
    UPDATE telegram_drafts
    SET status = 'draft', updated_at = ?
    WHERE id = ? AND status = 'processing' AND updated_at = ?
  `).bind(new Date().toISOString(), draft.id, draft.updated_at).run();
};
