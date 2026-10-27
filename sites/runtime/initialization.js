import { clean } from '../lib/validation.js';

const BATTLE_SCHEMA_VERSION = 17;
export const BATTLE_RESET_KEY = 'battle_v17_reset';
const BATTLE_SCHEMA_KEY = 'battle_schema_version';
let schemaPromise;
let battleReadyPromise;

const ensureTelegramClaimColumn = async (db) => {
  try {
    await db.prepare('ALTER TABLE telegram_link_codes ADD COLUMN claim_id TEXT').run();
  } catch (error) {
    if (!/duplicate column|already exists/i.test(String(error?.message || error))) throw error;
  }
};

export const ensureSchema = async (db) => {
  if (!schemaPromise) {
    schemaPromise = Promise.all([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS project_state (
          project_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          updated_role TEXT NOT NULL
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          actor TEXT NOT NULL,
          role TEXT NOT NULL,
          action TEXT NOT NULL,
          summary TEXT NOT NULL,
          state_bytes INTEGER NOT NULL
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS lead_inbox (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          name TEXT NOT NULL,
          phone TEXT NOT NULL,
          email TEXT,
          source TEXT NOT NULL,
          message TEXT,
          status TEXT NOT NULL
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS public_lead_rate_limits (
          key TEXT NOT NULL,
          window_start TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (key, window_start)
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS developer_feedback (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          created_by TEXT NOT NULL,
          page TEXT NOT NULL,
          category TEXT NOT NULL,
          title TEXT NOT NULL,
          details TEXT NOT NULL,
          status TEXT NOT NULL
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_link_codes (
          code_hash TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          system_user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          claim_id TEXT
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_bindings (
          telegram_user_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          system_user_id TEXT NOT NULL,
          private_chat_id TEXT NOT NULL,
          username TEXT,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL,
          bound_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (telegram_user_id, project_id)
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_chat_projects (
          chat_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT NOT NULL
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_user_chat_projects (
          telegram_user_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (telegram_user_id, chat_id)
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_chat_candidates (
          chat_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          type TEXT NOT NULL,
          observed_at TEXT NOT NULL
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_drafts (
          id TEXT PRIMARY KEY,
          telegram_user_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_updates (
          update_id TEXT PRIMARY KEY,
          received_at TEXT NOT NULL,
          processed_at TEXT,
          status TEXT NOT NULL,
          error TEXT
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS telegram_outbox (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          text TEXT NOT NULL,
          options_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS system_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `).run(),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS data_reset_backups (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          record_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          reason TEXT NOT NULL
        )
      `).run(),
    ]).then(() => ensureTelegramClaimColumn(db)).then(() => Promise.all([
      db.prepare(`
        CREATE INDEX IF NOT EXISTS audit_log_project_revision
        ON audit_log (project_id, revision DESC)
      `).run(),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS telegram_bindings_project_user
        ON telegram_bindings (project_id, system_user_id)
      `).run(),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS telegram_user_chat_projects_project
        ON telegram_user_chat_projects (project_id)
      `).run(),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS telegram_outbox_status_created
        ON telegram_outbox (status, created_at)
      `).run(),
      db.prepare(`
        CREATE INDEX IF NOT EXISTS data_reset_backups_created_at
        ON data_reset_backups (created_at DESC)
      `).run(),
    ])).then(() => db.prepare(`
      INSERT INTO system_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).bind(BATTLE_SCHEMA_KEY, String(BATTLE_SCHEMA_VERSION), new Date().toISOString()).run()).catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  await schemaPromise;
};

export const battleReadiness = async (env) => {
  const buildSha = clean(env.BUILD_SHA, 64) || 'unknown';
  if (!env.DB) {
    return {
      ok: false,
      database: false,
      schemaVersion: BATTLE_SCHEMA_VERSION,
      schemaReady: false,
      battleReady: false,
      buildSha,
    };
  }
  try {
    const [battleMarker, schemaMarker] = await Promise.all([
      env.DB.prepare(`
        SELECT value FROM system_meta WHERE key = ?
      `).bind(BATTLE_RESET_KEY).first(),
      env.DB.prepare(`
        SELECT value FROM system_meta WHERE key = ?
      `).bind(BATTLE_SCHEMA_KEY).first(),
    ]);
    const battleReady = battleMarker?.value === 'done';
    const schemaReady = schemaMarker?.value === String(BATTLE_SCHEMA_VERSION);
    return {
      ok: battleReady && schemaReady,
      database: true,
      schemaVersion: BATTLE_SCHEMA_VERSION,
      schemaReady,
      battleReady,
      buildSha,
    };
  } catch {
    return {
      ok: false,
      database: false,
      schemaVersion: BATTLE_SCHEMA_VERSION,
      schemaReady: false,
      battleReady: false,
      buildSha,
    };
  }
};

export const ensureBattleReady = async (env) => {
  if (!battleReadyPromise) {
    battleReadyPromise = (async () => {
      if (!env.DB) throw new Error('storage_unavailable');
      await ensureSchema(env.DB);
      const readiness = await battleReadiness(env);
      if (!readiness.ok) throw new Error('battle_manual_initialization_required');
    })().catch((error) => {
      battleReadyPromise = undefined;
      throw error;
    });
  }
  await battleReadyPromise;
};

export const initializeBattleRuntime = async (env) => ensureBattleReady(env);
