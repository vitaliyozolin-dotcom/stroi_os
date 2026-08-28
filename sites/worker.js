import {
  authenticatedIdentity,
  projectIdentity,
} from './access-control.js';
import { addDays, dateKey } from './lib/date.js';
import { applyBattleAutomations } from './automations/battle.js';
import { createFileHandlers } from './files/routes.js';
import { createDeveloperFeedbackHandler } from './feedback/routes.js';
import { createProjectReadHandlers } from './projects/routes.js';
import { createProjectWriteHandler } from './projects/write.js';
import { createSessionHandler } from './access/session.js';
import { createAccessUsersHandler } from './access/users.js';
import { createCameraHandlers } from './integrations/camera.js';
import { createNotificationService, deepLink, notificationEvent } from './integrations/notifications.js';
import { createTelegramAccessHandlers } from './integrations/telegram-access.js';
import { createTelegramBootstrapHandler } from './integrations/telegram-bootstrap.js';
import { createIntegrationHandlers } from './integrations/routes.js';
import { createIntegrationStatus } from './integrations/status.js';
import {
  claimPublicLeadRateLimit as claimPublicLeadRateLimitModule,
  createLeadHandlers,
} from './leads/routes.js';
import { createApiHandler } from './routes/api.js';
import { json } from './lib/http.js';
import {
  readJsonBodyLimited,
  requestWithBodyLimit,
} from './lib/request-body.js';
import { claimUploadAdmission } from './lib/upload-admission.js';
import {
  clean,
  safeFileName,
  validProjectId,
} from './lib/validation.js';
import {
  flushTelegramOutbox as flushTelegramOutboxModule,
  reviveTelegramOutbox,
  telegramDurableSend,
} from './telegram/outbox.js';
import {
  claimTelegramUpdate as claimTelegramUpdateModule,
  completeTelegramUpdate,
  failTelegramUpdate,
  readTelegramUpdateStatus,
} from './telegram/inbox.js';
import {
  parseTelegramBody,
  telegramApiUrl,
  telegramCheckedRequest,
  telegramRequest,
  telegramSend,
  telegramTransportHeaders,
} from './telegram/transport.js';
import {
  assertTelegramDraftLease,
  claimTelegramDraft as claimTelegramDraftModule,
  createTelegramDraft as createTelegramDraftModule,
  readClaimedTelegramDraft,
  readTelegramDraft,
  releaseTelegramDraft as releaseTelegramDraftModule,
  saveClaimedTelegramDraftPayload,
  updateTelegramDraft as updateTelegramDraftModule,
} from './telegram/drafts.js';
import {
  bindingForTelegramProject as bindingForTelegramProjectModule,
  bindingsForTelegramUser as bindingsForTelegramUserModule,
  bindingForTelegramUser as bindingForTelegramUserModule,
  claimTelegramBinding,
  saveTelegramProjectSelection,
  selectTelegramBinding,
} from './telegram/bindings.js';
import {
  commandFromText,
  naturalTelegramCommand,
  naturalTelegramIntent,
  parseTelegramExpense,
  telegramCommandSuggestion,
  telegramCommandTargetsBot,
} from './telegram/commands.js';
import { createTelegramConnection } from './telegram/connection.js';
import { createTelegramProjectStore } from './telegram/project-store.js';
import { createTelegramWebhookHandler } from './telegram/webhook.js';
import { createTelegramReadCommands } from './telegram/read-commands.js';
import { createTelegramWriteDrafts } from './telegram/write-drafts.js';
import {
  renderExpenseDraft,
  renderFileDraft,
  renderTaskDraft,
  taskActionMarkup,
  taskStatusLabel,
  telegramHelp,
  telegramTaskActionKey,
} from './telegram/rendering.js';

const MAX_STATE_BYTES = 6_000_000;
const MAX_JSON_BODY_BYTES = 32 * 1024;
const BATTLE_SCHEMA_VERSION = 17;
const BATTLE_RESET_KEY = 'battle_v17_reset';
const BATTLE_SCHEMA_KEY = 'battle_schema_version';
const TELEGRAM_MUTATION_NOOP = Symbol('telegram_mutation_noop');
let schemaPromise;
let battleReadyPromise;

const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export { claimUploadAdmission, requestWithBodyLimit };
export {
  commandFromText,
  naturalTelegramCommand,
  parseTelegramExpense,
  telegramCommandTargetsBot,
  telegramTaskActionKey,
};

const ensureTelegramClaimColumn = async (db) => {
  try {
    await db.prepare('ALTER TABLE telegram_link_codes ADD COLUMN claim_id TEXT').run();
  } catch (error) {
    if (!/duplicate column|already exists/i.test(String(error?.message || error))) throw error;
  }
};

const ensureSchema = async (db) => {
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

const ensureBattleReady = async (env) => {
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

const readSnapshot = async (db, projectId) => {
  const row = await db.prepare(`
    SELECT project_id, state_json, revision, updated_at, updated_by, updated_role
    FROM project_state
    WHERE project_id = ?
  `).bind(projectId).first();
  if (!row) return null;

  return {
    projectId: row.project_id,
    state: JSON.parse(row.state_json),
    revision: Number(row.revision),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    updatedRole: row.updated_role,
  };
};

const {
  qualityPhotoUpload: handleQualityPhotoUpload,
  qualityPhotoFile: handleQualityPhotoFile,
  documentUpload: handleDocumentUpload,
  documentFile: handleDocumentFile,
  fieldReportFile: handleFieldReportFile,
} = createFileHandlers({ ensureSchema, readSnapshot });

const {
  discoverTelegramChats,
  readObservedTelegramChats,
  readTelegramBot,
  readTelegramConfig,
  rememberTelegramChatCandidates,
  resolveTelegramConnection,
  telegramGroupChatAuthorized,
  verifyAndStoreTelegramChat,
} = createTelegramConnection({ ensureSchema, readSnapshot, reviveTelegramOutbox });

const { getState: handleGetState, audit: handleAudit, projects: handleProjects } = createProjectReadHandlers({ ensureSchema, readSnapshot });
const handleSession = createSessionHandler({ ensureSchema });
const handleAccessUsers = createAccessUsersHandler({ ensureSchema, readSnapshot });
const { status: handleCameraStatus, view: handleCameraView } = createCameraHandlers({ ensureSchema, readSnapshot });


export const flushTelegramOutbox = (env, limit = 10) => flushTelegramOutboxModule(env, limit, ensureSchema);

const telegramAnswerCallback = async (token, callbackQueryId, text = '', showAlert = false) => {
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

const telegramEditMessage = async (token, chatId, messageId, text, replyMarkup) => {
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

const telegramConfirmVisible = async (env, chatId, messageId, text, replyMarkup) => {
  try {
    await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, text, replyMarkup);
    return 'edited';
  } catch {
    const options = replyMarkup ? { reply_markup: replyMarkup } : {};
    return telegramDurableVisibility(env, chatId, text, options, `telegram-confirm:${chatId}:${messageId}`);
  }
};

const telegramDurableVisibility = async (env, chatId, text, options, stableId) => {
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

const requireTelegramVisibility = (status) => {
  if (status === 'undelivered') throw new Error('telegram_confirmation_unavailable');
};

const telegramSendPhoto = (token, chatId, photo, caption, options = {}) => telegramRequest(token, 'sendPhoto', {
  chat_id: chatId,
  photo,
  caption: telegramMessageText(caption, 1000),
  ...options,
});

const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
};

const { buildPlan: buildNotificationPlan, dispatch: dispatchNotifications } = createNotificationService({
  resolveTelegramConnection,
  sha256,
});

const {
  listSnapshots: listProjectSnapshots,
  mutate: mutateProjectFromTelegram,
} = createTelegramProjectStore({ ensureSchema, readSnapshot, changes, mutationNoop: TELEGRAM_MUTATION_NOOP });

const bindingForTelegramProject = (db, telegramUserId, projectId) => (
  bindingForTelegramProjectModule(db, telegramUserId, projectId, ensureSchema)
);

const bindingsForTelegramUser = (db, telegramUserId) => (
  bindingsForTelegramUserModule(db, telegramUserId, ensureSchema)
);

const bindingForTelegramUser = (db, telegramUserId, chatId = '') => (
  bindingForTelegramUserModule(db, telegramUserId, chatId, ensureSchema)
);

export { selectTelegramBinding };

export const createTelegramDraft = createTelegramDraftModule;
export const updateTelegramDraft = updateTelegramDraftModule;
export const claimTelegramDraft = claimTelegramDraftModule;
export const releaseTelegramDraft = releaseTelegramDraftModule;

const runClaimedTelegramDraft = async (callback, draft, env, action) => {
  const lease = await claimTelegramDraft(env.DB, draft);
  if (!lease) {
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Черновик уже обрабатывается или закрыт.', true);
    return false;
  }
  let claimedDraft = null;
  try {
    claimedDraft = await readClaimedTelegramDraft(env.DB, draft, lease);
    await action(claimedDraft);
    return true;
  } catch (error) {
    await releaseTelegramDraft(env.DB, claimedDraft ?? { ...draft, updated_at: lease });
    throw error;
  }
};

const telegramDisplayName = (from) => clean([from?.first_name, from?.last_name].filter(Boolean).join(' '), 160)
  || clean(from?.username, 120)
  || `Telegram ${String(from?.id ?? '')}`;

const categoryFromDocument = (name, caption) => {
  const source = `${clean(name, 240)} ${clean(caption, 500)}`.toLocaleLowerCase('ru');
  if (source.includes('договор')) return ['contract', 'Договор'];
  if (source.includes('акт')) return ['act', 'Акт'];
  if (source.includes('упд')) return ['upd', 'УПД'];
  if (source.includes('наклад') || /\bтн\b/.test(source)) return ['waybill', 'ТН'];
  if (source.includes('счёт') || source.includes('счет')) return ['invoice', 'Счёт'];
  if (source.includes('специф')) return ['specification', 'Спецификация'];
  return ['other', 'Прочее'];
};

const telegramFileToR2 = async (env, projectId, fileId, fileName, mimeType, uploadedBy, draftId) => {
  const metadataResponse = await telegramRequest(env.TELEGRAM_BOT_TOKEN, 'getFile', { file_id: fileId });
  const metadataBody = await parseTelegramBody(metadataResponse);
  if (!metadataResponse.ok || !metadataBody?.ok || !metadataBody.result?.file_path) throw new Error('telegram_file_unavailable');
  const declaredSize = Number(metadataBody.result.file_size) || 0;
  if (declaredSize > MAX_FILE_BYTES) throw new Error('telegram_file_too_large');
  const releaseUpload = claimUploadAdmission();
  if (!releaseUpload) throw new Error('upload_busy');
  try {
    const sourceResponse = await fetch(telegramApiUrl(`/file/bot${env.TELEGRAM_BOT_TOKEN}/${metadataBody.result.file_path}`), {
      headers: telegramTransportHeaders(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!sourceResponse.ok || !sourceResponse.body) throw new Error('telegram_file_unavailable');
    const safeName = safeFileName(fileName);
    const stableDraftId = clean(draftId, 80) || crypto.randomUUID();
    const key = `${projectId}/telegram/${stableDraftId}-${safeName}`;
    const uploadedAt = new Date().toISOString();
    await env.BUCKET.put(key, sourceResponse.body, {
      maxBytes: MAX_FILE_BYTES,
      httpMetadata: { contentType: clean(mimeType, 120) || sourceResponse.headers.get('content-type') || 'application/octet-stream' },
      customMetadata: {
        projectId,
        originalName: safeName,
        uploadedBy: clean(uploadedBy, 160),
        uploadedAt,
        source: 'telegram',
      },
    });
    return {
      id: `attachment-telegram-${stableDraftId}`,
      key,
      name: safeName,
      mimeType: clean(mimeType, 120) || sourceResponse.headers.get('content-type') || 'application/octet-stream',
      sizeBytes: declaredSize || Number(sourceResponse.headers.get('content-length')) || 0,
      uploadedAt,
      uploadedBy: clean(uploadedBy, 160),
      source: 'telegram',
    };
  } finally {
    releaseUpload();
  }
};

export const resolveTelegramDraftFile = async (state, draft, loadAttachment) => {
  const isDocument = draft?.kind === 'document';
  const saved = isDocument
    ? (state?.documents ?? []).find((item) => item.sourceDraftId === draft?.id)
    : (state?.fieldReports ?? []).find((item) => item.sourceDraftId === draft?.id);
  if (!saved) return { existing: false, attachment: await loadAttachment(), saved: null };

  const attachment = isDocument
    ? {
      id: `attachment-telegram-${draft.id}`,
      key: clean(saved.fileKey, 500),
      name: clean(saved.fileName, 240) || clean(saved.name, 240) || clean(draft.payload?.fileName, 240) || 'Файл Telegram',
      mimeType: clean(saved.mimeType, 120) || clean(draft.payload?.mimeType, 120) || 'application/octet-stream',
      sizeBytes: Number(saved.sizeBytes) || 0,
      uploadedAt: clean(saved.uploadedAt, 80),
      uploadedBy: clean(saved.uploadedBy, 160),
      source: 'telegram',
    }
    : saved.attachments?.[0] ?? {
      id: `attachment-telegram-${draft.id}`,
      key: '',
      name: clean(draft.payload?.fileName, 240) || 'Файл Telegram',
      mimeType: clean(draft.payload?.mimeType, 120) || 'application/octet-stream',
      sizeBytes: 0,
      uploadedAt: clean(saved.createdAt, 80),
      uploadedBy: clean(saved.author, 160),
      source: 'telegram',
    };
  return { existing: true, attachment, saved };
};

const telegramOrigin = (env) => clean(env.APP_PUBLIC_URL, 500) || 'https://stroios-work-2026.ozolin.chatgpt.site';

const telegramBotUsername = async (env) => {
  const fromEnv = clean(env.TELEGRAM_BOT_USERNAME, 120).replace(/^@/u, '');
  if (fromEnv) return fromEnv;
  try {
    const stored = await readTelegramConfig(env.DB);
    const configured = clean(stored?.bot?.username, 120).replace(/^@/u, '');
    if (configured) return configured;
  } catch {
    // Имя бота не должно зависеть от доступности служебной записи или Telegram getMe.
  }
  return 'ikioma_bot';
};

const {
  link: handleTelegramLink,
  unlink: handleTelegramUnlink,
} = createTelegramAccessHandlers({ ensureSchema, readSnapshot, telegramBotUsername, mutateProjectFromTelegram });

export const telegramMessageMentionsBot = (message, botUsername) => {
  const expected = `@${clean(botUsername, 120).replace(/^@/u, '').toLocaleLowerCase('en-US')}`;
  if (expected === '@') return false;
  const text = clean(message?.text, 3000);
  if (new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'iu').test(text)) return true;
  return (message?.entities ?? []).some((entity) => {
    if (entity?.type !== 'mention') return false;
    return text.slice(Number(entity.offset) || 0, (Number(entity.offset) || 0) + (Number(entity.length) || 0)).toLocaleLowerCase('en-US') === expected;
  });
};

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

const telegramReadCommands = createTelegramReadCommands({ readSnapshot, telegramSendPhoto });
export const { projectForBinding } = telegramReadCommands;
const telegramWriteDrafts = createTelegramWriteDrafts({
  createDraft: createTelegramDraft,
  parseExpense: parseTelegramExpense,
  projectForBinding,
  renderExpenseDraft,
  renderTaskDraft,
});


const telegramProjectsForBindings = async (env, bindings) => {
  const projects = [];
  for (const item of bindings.slice(0, 12)) {
    const snapshot = await readSnapshot(env.DB, item.project_id);
    if (snapshot) projects.push({ id: item.project_id, name: snapshot.state.project?.name ?? snapshot.state.project?.code ?? item.project_id });
  }
  return projects;
};

const telegramSelectProject = async (message, binding, env, options = {}) => {
  const bindings = options.bindings ?? await bindingsForTelegramUser(env.DB, String(message.from.id));
  if (!bindings.length) return;
  const projects = await telegramProjectsForBindings(env, bindings);
  if (projects.length === 1 && !options.pending) {
    await saveTelegramProjectSelection(env.DB, String(message.from.id), String(message.chat.id), projects[0].id);
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, `Текущий объект: ${projects[0].name}`);
    return;
  }
  const current = projects.find((item) => item.id === binding?.project_id);
  const draft = await createTelegramDraft(
    env.DB,
    String(message.from.id),
    String(message.chat.id),
    binding?.project_id ?? projects[0]?.id,
    'project',
    { projects, pending: options.pending ?? null },
    String(message.message_id ?? ''),
  );
  const prompt = options.prompt
    || [current ? `Сейчас выбран: ${current.name}` : '', 'Выберите объект для этого чата:'].filter(Boolean).join('\n\n');
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, prompt, {
    reply_markup: {
      inline_keyboard: projects.map((item, index) => [{
        text: `${item.id === current?.id ? '✓ ' : ''}${item.name}`,
        callback_data: `ps|${draft.id}|${index}`,
      }]),
    },
  });
};

const telegramAttachmentDraft = async (message, binding, env) => {
  const { snapshot } = await projectForBinding(env, binding);
  const caption = clean(message.caption, 1200);
  const captionCommand = commandFromText(caption);
  const isPrivate = message.chat?.type === 'private';
  if (!isPrivate && !telegramCommandTargetsBot(captionCommand, await telegramBotUsername(env))) return;
  if (!isPrivate && !['doc', 'report'].includes(captionCommand?.name)) return;
  const document = message.document;
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
  const voice = message.voice;
  const source = document ?? photo ?? voice;
  if (!source?.file_id) return;
  const kind = captionCommand?.name === 'doc' || (document && captionCommand?.name !== 'report') ? 'document' : 'field_report';
  const fallbackName = document?.file_name
    || (voice ? `Голосовой отчёт ${dateKey()}.ogg` : `Фотоотчёт ${dateKey()}.jpg`);
  const [category, typeLabel] = categoryFromDocument(fallbackName, caption);
  const note = clean(captionCommand?.body || caption, 1000);
  const draft = await createTelegramDraft(env.DB, String(message.from.id), String(message.chat.id), binding.project_id, kind, {
    projectName: snapshot.state.project?.name ?? snapshot.state.project?.code ?? binding.project_id,
    telegramFileId: source.file_id,
    fileName: fallbackName,
    mimeType: clean(document?.mime_type || voice?.mime_type || (photo ? 'image/jpeg' : ''), 120),
    fileSize: Number(document?.file_size || voice?.file_size || photo?.file_size) || 0,
    note,
    category,
    typeLabel,
    telegramMessageId: String(message.message_id ?? ''),
  }, String(message.message_id ?? ''));
  const card = renderFileDraft(draft);
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, card.text, { reply_markup: card.replyMarkup });
};

const telegramAttachmentPayload = (message) => ({
  message_id: message.message_id,
  caption: clean(message.caption, 1200),
  chat: { id: message.chat.id, type: message.chat.type },
  document: message.document ?? null,
  photo: message.photo ?? null,
  voice: message.voice ?? null,
});

const TELEGRAM_WRITE_COMMANDS = new Set(['task', 'note', 'expense']);

const telegramHandleCommand = async (message, binding, command, env, options = {}) => {
  const bindings = options.bindings ?? await bindingsForTelegramUser(env.DB, String(message.from.id));
  if (command.name === 'start') {
    const role = binding?.role ?? bindings[0]?.role ?? 'foreman';
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
      bindings.length ? `Telegram подключён. Доступно проектов: ${bindings.length}.` : 'Telegram пока не связан с пользователем ИКИОМА ОС.',
      '',
      telegramHelp(role),
    ].join('\n'));
    if (bindings.length > 1) await telegramSelectProject(message, binding, env, { bindings });
    return;
  }
  if (command.name === 'help') {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, telegramHelp(binding?.role ?? bindings[0]?.role ?? 'foreman'));
    return;
  }
  if (command.name === 'project') return telegramSelectProject(message, binding, env, { bindings });
  if (!TELEGRAM_COMMAND_NAMES.includes(command.name)) {
    const suggestion = telegramCommandSuggestion(command.name);
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
      `Команда /${command.name} не распознана.`,
      suggestion ? `Возможно, вы имели в виду /${suggestion}.` : null,
      'Ничего не записано в ИКИОМА ОС.',
      '',
      'Отправьте /help, чтобы увидеть все команды.',
    ].filter(Boolean).join('\n'));
    return;
  }
  if (bindings.length > 1 && TELEGRAM_WRITE_COMMANDS.has(command.name) && !options.projectConfirmed) {
    await telegramSelectProject(message, binding, env, {
      bindings,
      pending: { type: 'command', command, sourceMessageId: String(message.message_id ?? '') },
      prompt: 'К какому проекту относится это действие?',
    });
    return;
  }
  if (!binding) {
    await telegramSelectProject(message, binding, env, {
      bindings,
      pending: { type: 'command', command, sourceMessageId: String(message.message_id ?? '') },
      prompt: `Выберите проект для команды /${command.name}:`,
    });
    return;
  }
  if (command.name === 'task') return telegramWriteDrafts.task(message, binding, command.body, env);
  if (command.name === 'tasks') return telegramReadCommands.tasks(message, binding, env);
  if (command.name === 'stages') return telegramReadCommands.stages(message, binding, env);
  if (command.name === 'done') return telegramReadCommands.completedTasks(message, binding, env);
  if (command.name === 'finance') return telegramReadCommands.finance(message, binding, env);
  if (command.name === 'expense') return telegramWriteDrafts.expense(message, binding, command.body, env);
  if (command.name === 'status') return telegramReadCommands.projectStatus(message, binding, env);
  if (command.name === 'note') return telegramWriteDrafts.note(message, binding, command.body, env);
  if (command.name === 'camera') return telegramReadCommands.camera(message, binding, env);
  if (command.name === 'doc') {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Пришлите файл в личный чат с ботом. В общем чате приложите к документу подпись /doc. Бот покажет категорию и попросит подтверждение.');
    return;
  }
  if (command.name === 'report') {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Пришлите фото или голосовое сообщение в личный чат. В общем чате добавьте подпись /report и комментарий. Запись попадёт в дневник объекта только после подтверждения.');
    return;
  }
};

const telegramHandleMessage = async (message, env) => {
  if (!message?.chat?.id || !message?.from?.id || message.from.is_bot) return;
  const command = commandFromText(message.text);
  const isPrivate = message.chat.type === 'private';
  const botUsername = isPrivate ? '' : await telegramBotUsername(env);
  if (!isPrivate && !telegramCommandTargetsBot(command, botUsername)) return;
  if (!isPrivate && !await telegramGroupChatAuthorized(env, message.chat.id)) {
    const addressed = Boolean(command) || telegramMessageMentionsBot(message, botUsername);
    if (addressed) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Этот чат не подключён к ИКИОМА ОС. Попросите руководителя выбрать и подтвердить общий Telegram-чат в настройках ОС.');
    }
    return;
  }
  if (command?.name === 'start' && command.body) {
    await bindTelegramUser(message, command.body, env);
    return;
  }

  const rawText = clean(message.text, 3000);
  let mentioned = false;
  if (!command && !isPrivate) {
    mentioned = telegramMessageMentionsBot(message, botUsername);
  }
  const replyAuthor = message.reply_to_message?.from;
  const repliedToBot = Boolean(
    replyAuthor?.is_bot
    && clean(replyAuthor.username, 120).replace(/^@/u, '').toLocaleLowerCase('en-US') === botUsername.toLocaleLowerCase('en-US'),
  );
  const addressedToBot = isPrivate || Boolean(command) || mentioned || repliedToBot;
  const bindings = await bindingsForTelegramUser(env.DB, String(message.from.id));
  const binding = await bindingForTelegramUser(env.DB, String(message.from.id), String(message.chat.id));

  if (!bindings.length) {
    if (command?.name === 'help' || command?.name === 'start') {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, telegramHelp('management'));
    }
    if (addressedToBot && command?.name !== 'help') {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
        'Сообщение не записано в ИКИОМА ОС.',
        'Ваш Telegram ещё не связан с пользователем системы.',
        '',
        'Руководитель может выпустить персональную ссылку: ИКИОМА ОС → Настройки → Доступы.',
        'Справка по доступным действиям: /help',
      ].join('\n'));
    }
    return;
  }

  if (message.document || message.photo || message.voice) {
    const captionCommand = commandFromText(message.caption);
    const acceptedAttachment = isPrivate || (
      telegramCommandTargetsBot(captionCommand, botUsername)
      && ['doc', 'report'].includes(captionCommand?.name)
    );
    if (!acceptedAttachment) return;
    if (bindings.length > 1) {
      await telegramSelectProject(message, binding, env, {
        bindings,
        pending: { type: 'attachment', message: telegramAttachmentPayload(message) },
        prompt: 'К какому проекту относится этот файл или отчёт?',
      });
      return;
    }
    await telegramAttachmentDraft(message, binding, env);
    return;
  }
  if (command) {
    await telegramHandleCommand(message, binding, command, env, { bindings });
    return;
  }
  if (addressedToBot) {
    const addressedText = rawText
      .replace(botUsername ? new RegExp(`@${botUsername}\\b`, 'giu') : /$^/, '')
      .trim();
    const naturalCommand = naturalTelegramCommand(addressedText);
    if (naturalCommand) {
      await telegramHandleCommand(message, binding, naturalCommand, env, { bindings });
      return;
    }
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
      'Я не понял, что нужно сделать.',
      'Ничего не записано в ИКИОМА ОС.',
      '',
      'Переформулируйте сообщение или отправьте /help.',
    ].join('\n'));
  }
};

const telegramConfirmTask = async (callback, draft, binding, env) => {
  const access = await projectForBinding(env, binding);
  const { snapshot } = access;
  let { user } = access;
  if (user.role !== 'management' || draft.kind !== 'task') throw new Error('action_denied');
  let assignee = (snapshot.state.settings?.users ?? []).find((item) => item.id === draft.payload.assigneeId && item.status !== 'disabled' && item.role !== 'client');
  if (!assignee) throw new Error('assignee_missing');
  const now = new Date().toISOString();
  const taskId = `task-telegram-${draft.id}`;
  const task = {
    id: taskId,
    title: clean(draft.payload.title, 500),
    status: 'todo',
    priority: draft.payload.priority,
    assigneeId: assignee.id,
    assigneeName: assignee.name,
    createdBy: user.name,
    createdAt: now,
    updatedAt: now,
    dueDate: draft.payload.dueDate,
    originalDueDate: draft.payload.dueDate,
    rescheduleCount: 0,
    attachments: [],
    sourceDraftId: draft.id,
    history: [{
      id: `task-history-${crypto.randomUUID()}`,
      timestamp: now,
      actor: user.name,
      kind: 'created',
      text: `Создал задачу через Telegram и назначил ${assignee.name}`,
    }],
  };
  let taskCreated = false;
  await assertTelegramDraftLease(env.DB, draft);
  const mutation = await mutateProjectFromTelegram(
    env,
    draft.project_id,
    user.name,
    user.role,
    'telegram.task.create',
    `Создана задача «${task.title}» · ответственный ${assignee.name}`,
    (state) => {
      if ((state.tasks ?? []).some((item) => item.id === taskId || item.sourceDraftId === draft.id)) {
        taskCreated = false;
        return TELEGRAM_MUTATION_NOOP;
      }
      const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
      if (!currentUser || currentUser.role !== 'management') throw new Error('action_denied');
      const currentAssignee = (state.settings?.users ?? []).find((item) => item.id === draft.payload.assigneeId && item.status !== 'disabled' && item.role !== 'client');
      if (!currentAssignee) throw new Error('assignee_missing');
      user = currentUser;
      assignee = currentAssignee;
      task.assigneeName = currentAssignee.name;
      task.createdBy = currentUser.name;
      task.history[0].actor = currentUser.name;
      task.history[0].text = `Создал задачу через Telegram и назначил ${currentAssignee.name}`;
      taskCreated = true;
      state.tasks = [task, ...(state.tasks ?? [])];
      state.activity = [{
        id: `activity-${crypto.randomUUID()}`,
        timestamp: now,
        actor: user.name,
        text: `Создана задача «${task.title}» через Telegram · ответственный ${assignee.name}`,
        tone: 'neutral',
      }, ...(state.activity ?? [])];
    },
  );
  const confirmedTask = (mutation.state.tasks ?? []).find((item) => item.id === taskId || item.sourceDraftId === draft.id) ?? task;
  const recoveryEvents = mutation.state.settings?.notifications?.events?.taskAssigned
    ? [notificationEvent(`Задача: «${confirmedTask.title}» → ${confirmedTask.assigneeName}, срок ${confirmedTask.dueDate}`, 'tasks', confirmedTask.id, confirmedTask.assigneeId)]
    : [];
  await dispatchNotifications(
    mutation.previous,
    mutation.state,
    env,
    user.name,
    telegramOrigin(env),
    `Создана задача «${confirmedTask.title}»`,
    `telegram-draft:${draft.id}`,
    null,
    recoveryEvents,
  );
  const visibility = await telegramConfirmVisible(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    `Задача создана\n\n${confirmedTask.title}\nОтветственный: ${confirmedTask.assigneeName}\nСрок: ${confirmedTask.dueDate}\n\n${deepLink(telegramOrigin(env), draft.project_id, 'tasks', confirmedTask.id)}`,
  );
  requireTelegramVisibility(visibility);
  await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
};

const telegramConfirmNote = async (callback, draft, binding, env) => {
  const access = await projectForBinding(env, binding);
  let { user } = access;
  if (draft.kind !== 'note') throw new Error('action_denied');
  const note = clean(draft.payload.note, 2400);
  if (!note) throw new Error('invalid_note');
  const now = new Date().toISOString();
  const report = {
    id: `field-report-telegram-${draft.id}`,
    createdAt: now,
    author: user.name,
    note,
    source: 'telegram',
    clientVisible: false,
    telegramMessageId: draft.payload.telegramMessageId,
    attachments: [],
    sourceDraftId: draft.id,
  };
  let noteCreated = false;
  await assertTelegramDraftLease(env.DB, draft);
  const mutation = await mutateProjectFromTelegram(
    env,
    draft.project_id,
    user.name,
    user.role,
    'telegram.note.create',
    `Добавлена запись в дневник объекта · ${user.name}`,
    (state) => {
      if ((state.fieldReports ?? []).some((item) => item.id === report.id || item.sourceDraftId === draft.id)) {
        noteCreated = false;
        return TELEGRAM_MUTATION_NOOP;
      }
      const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
      if (!currentUser) throw new Error('action_denied');
      user = currentUser;
      report.author = currentUser.name;
      noteCreated = true;
      state.fieldReports = [report, ...(state.fieldReports ?? [])];
      state.activity = [{
        id: `activity-${crypto.randomUUID()}`,
        timestamp: now,
        actor: user.name,
        text: 'Добавил запись в дневник объекта через Telegram',
        tone: 'neutral',
      }, ...(state.activity ?? [])];
    },
  );
  await dispatchNotifications(
    mutation.previous,
    mutation.state,
    env,
    user.name,
    telegramOrigin(env),
    'Добавлена запись в дневник объекта',
    `telegram-draft:${draft.id}`,
  );
  const visibility = await telegramConfirmVisible(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    `Запись сохранена в дневнике объекта\n\n${note}\n\n${deepLink(telegramOrigin(env), draft.project_id, 'project')}`,
  );
  requireTelegramVisibility(visibility);
  await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
};

const telegramConfirmExpense = async (callback, draft, binding, env) => {
  const access = await projectForBinding(env, binding);
  const { snapshot } = access;
  let { user } = access;
  if (user.role !== 'management' || draft.kind !== 'expense') throw new Error('action_denied');
  const amount = Number(draft.payload.amount);
  let budgetLine = (snapshot.state.budgetLines ?? []).find((item) => item.id === draft.payload.budgetLineId);
  let counterparty = (snapshot.state.counterparties ?? []).find((item) => item.id === draft.payload.counterpartyId && item.status !== 'blocked');
  const stageId = clean(draft.payload.stageId, 100);
  let stage = (snapshot.state.stages ?? []).find((item) => item.id === stageId);
  if (!Number.isFinite(amount) || amount <= 0 || !budgetLine || !counterparty || !stage || !budgetLine.stageIds?.includes(stageId)) throw new Error('expense_details_missing');
  const now = new Date().toISOString();
  const entryId = `finance-telegram-${draft.id}`;
  const entry = {
    id: entryId,
    kind: 'expense',
    status: 'committed',
    amount,
    date: dateKey(),
    stageId,
    budgetLineId: budgetLine.id,
    counterparty: counterparty.name,
    counterpartyId: counterparty.id,
    description: clean(draft.payload.description, 500),
    sourceDraftId: draft.id,
  };
  let expenseCreated = false;
  await assertTelegramDraftLease(env.DB, draft);
  const mutation = await mutateProjectFromTelegram(
    env,
    draft.project_id,
    user.name,
    user.role,
    'telegram.expense.create',
    `Добавлен расход ${Math.round(amount).toLocaleString('ru-RU')} ₽ · ${entry.description}`,
    (state) => {
      if ((state.financeEntries ?? []).some((item) => item.id === entryId || item.sourceDraftId === draft.id)) {
        expenseCreated = false;
        return TELEGRAM_MUTATION_NOOP;
      }
      const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
      if (!currentUser || currentUser.role !== 'management') throw new Error('action_denied');
      const currentBudgetLine = (state.budgetLines ?? []).find((item) => item.id === draft.payload.budgetLineId);
      const currentCounterparty = (state.counterparties ?? []).find((item) => item.id === draft.payload.counterpartyId && item.status !== 'blocked');
      const currentStage = (state.stages ?? []).find((item) => item.id === stageId);
      if (!currentBudgetLine || !currentCounterparty || !currentStage || !currentBudgetLine.stageIds?.includes(stageId)) throw new Error('expense_details_missing');
      budgetLine = currentBudgetLine;
      counterparty = currentCounterparty;
      stage = currentStage;
      user = currentUser;
      entry.budgetLineId = currentBudgetLine.id;
      entry.counterparty = currentCounterparty.name;
      entry.counterpartyId = currentCounterparty.id;
      expenseCreated = true;
      const currentCommitted = (state.financeEntries ?? [])
        .filter((item) => item.kind === 'expense' && item.budgetLineId === budgetLine.id)
        .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      state.budgetLines = (state.budgetLines ?? []).map((item) => item.id === budgetLine.id
        ? { ...item, forecast: Math.max(Number(item.forecast) || 0, currentCommitted + amount) }
        : item);
      state.financeEntries = [entry, ...(state.financeEntries ?? [])];
      state.activity = [{
        id: `activity-${crypto.randomUUID()}`,
        timestamp: now,
        actor: user.name,
        text: `Добавлен расход ${Math.round(amount).toLocaleString('ru-RU')} ₽ · ${entry.description}`,
        tone: 'neutral',
      }, ...(state.activity ?? [])];
    },
  );
  await dispatchNotifications(
    mutation.previous,
    mutation.state,
    env,
    user.name,
    telegramOrigin(env),
    `Добавлен расход «${entry.description}»`,
    `telegram-draft:${draft.id}`,
  );
  const visibility = await telegramConfirmVisible(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    [
      'Расход сохранён как обязательство',
      '',
      `${amount.toLocaleString('ru-RU')} ₽ · ${entry.description}`,
      `Статья: ${budgetLine.name}`,
      `Этап: ${stage.name}`,
      `Контрагент: ${counterparty.name}`,
      '',
      'Оплата и приёмка не зафиксированы.',
      deepLink(telegramOrigin(env), draft.project_id, 'finance', entryId),
    ].join('\n'),
  );
  requireTelegramVisibility(visibility);
  await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
};

const telegramConfirmFile = async (callback, draft, binding, env) => {
  const access = await projectForBinding(env, binding);
  const { snapshot } = access;
  let { user } = access;
  await assertTelegramDraftLease(env.DB, draft);
  const resolvedFile = await resolveTelegramDraftFile(snapshot.state, draft, () => {
    if (!env.BUCKET) throw new Error('storage_unavailable');
    return telegramFileToR2(
      env,
      draft.project_id,
      draft.payload.telegramFileId,
      draft.payload.fileName,
      draft.payload.mimeType,
      user.name,
      draft.id,
    );
  });
  const { attachment } = resolvedFile;
  const now = new Date().toISOString();
  const isDocument = draft.kind === 'document';
  const summary = isDocument ? `Загружен документ «${attachment.name}» через Telegram` : `Добавлен фотоотчёт через Telegram · ${user.name}`;
  let fileCreated = false;
  const mutation = resolvedFile.existing ? null : await mutateProjectFromTelegram(
    env,
    draft.project_id,
    user.name,
    user.role,
    isDocument ? 'telegram.document.create' : 'telegram.field_report.create',
    summary,
    (state) => {
      const existing = isDocument
        ? (state.documents ?? []).some((item) => item.sourceDraftId === draft.id)
        : (state.fieldReports ?? []).some((item) => item.sourceDraftId === draft.id);
      if (existing) {
        fileCreated = false;
        return TELEGRAM_MUTATION_NOOP;
      }
      const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
      if (!currentUser) throw new Error('action_denied');
      user = currentUser;
      fileCreated = true;
      if (isDocument) {
        const document = {
          id: `document-telegram-${draft.id}`,
          name: attachment.name.replace(/\.[^.]+$/, ''),
          type: draft.payload.typeLabel,
          category: draft.payload.category,
          updatedAt: now,
          documentDate: dateKey(),
          clientVisible: false,
          status: 'current',
          direction: 'internal',
          storageLocation: `ИКИОМА ОС / ${state.project?.code ?? draft.project_id} / Документы`,
          fileKey: attachment.key,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          uploadedAt: attachment.uploadedAt,
          uploadedBy: user.name,
          sourceDraftId: draft.id,
        };
        state.documents = [document, ...(state.documents ?? [])];
      } else {
        const report = {
          id: `field-report-telegram-${draft.id}`,
          createdAt: now,
          author: user.name,
          note: clean(draft.payload.note, 1000) || (attachment.mimeType.startsWith('audio/') ? 'Голосовой отчёт без расшифровки' : 'Фотоотчёт без комментария'),
          source: 'telegram',
          clientVisible: false,
          telegramMessageId: draft.payload.telegramMessageId,
          attachments: [attachment],
          sourceDraftId: draft.id,
        };
        state.fieldReports = [report, ...(state.fieldReports ?? [])];
      }
      state.activity = [{
        id: `activity-${crypto.randomUUID()}`,
        timestamp: now,
        actor: user.name,
        text: summary,
        tone: 'neutral',
      }, ...(state.activity ?? [])];
    },
  );
  const notificationMutation = mutation ?? {
    previous: snapshot.state,
    state: snapshot.state,
    revision: snapshot.revision,
  };
  await dispatchNotifications(
    notificationMutation.previous,
    notificationMutation.state,
    env,
    user.name,
    telegramOrigin(env),
    summary,
    `telegram-draft:${draft.id}`,
  );
  const visibility = await telegramConfirmVisible(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    `${isDocument ? 'Документ сохранён' : 'Запись добавлена в дневник объекта'}\n\n${attachment.name}\nАвтор: ${user.name}\n\n${deepLink(telegramOrigin(env), draft.project_id, 'project')}`,
  );
  requireTelegramVisibility(visibility);
  await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
};

const telegramChangeTaskStatus = async (callback, binding, taskId, action, env) => {
  const access = await projectForBinding(env, binding);
  const { snapshot } = access;
  let { user } = access;
  let task = (snapshot.state.tasks ?? []).find((item) => item.id === taskId);
  if (!task || (user.role !== 'management' && task.assigneeId !== user.id)) throw new Error('action_denied');
  const status = ({ ip: 'in_progress', review: 'review', wait: 'waiting', done: 'done' })[action];
  if (!status || (status === 'done' && user.role !== 'management')) throw new Error('action_denied');
  const now = new Date().toISOString();
  let statusChanged = false;
  const mutation = await mutateProjectFromTelegram(
    env,
    binding.project_id,
    user.name,
    user.role,
    'telegram.task.status',
    `Задача «${task.title}» → ${taskStatusLabel(status)}`,
    (state) => {
      const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
      const currentTask = (state.tasks ?? []).find((item) => item.id === taskId);
      if (!currentUser || !currentTask || (currentUser.role !== 'management' && currentTask.assigneeId !== currentUser.id)) throw new Error('action_denied');
      if (status === 'done' && currentUser.role !== 'management') throw new Error('action_denied');
      user = currentUser;
      task = currentTask;
      if ((currentTask.history ?? []).some((event) => event.sourceTelegramCallbackId === callback.id)) {
        statusChanged = false;
        return TELEGRAM_MUTATION_NOOP;
      }
      if (currentTask.status === status) {
        statusChanged = false;
        return TELEGRAM_MUTATION_NOOP;
      }
      statusChanged = true;
      state.tasks = (state.tasks ?? []).map((item) => item.id === currentTask.id ? {
        ...item,
        status,
        updatedAt: now,
        completedAt: status === 'done' ? now : item.completedAt,
        history: [{
          id: `task-history-${crypto.randomUUID()}`,
          timestamp: now,
          actor: user.name,
          kind: status === 'done' ? 'completed' : 'status',
          text: `Изменил статус через Telegram: ${taskStatusLabel(status)}`,
          sourceTelegramCallbackId: callback.id,
        }, ...(item.history ?? [])],
      } : item);
      state.activity = [{
        id: `activity-${crypto.randomUUID()}`,
        timestamp: now,
        actor: user.name,
        text: `Задача «${task.title}» → ${taskStatusLabel(status)}`,
        tone: status === 'done' ? 'positive' : status === 'waiting' ? 'warning' : 'neutral',
      }, ...(state.activity ?? [])];
    },
  );
  const committedTask = (mutation.state.tasks ?? []).find((item) => item.id === taskId) ?? task;
  const actionCommitted = statusChanged || (committedTask.history ?? []).some((event) => event.sourceTelegramCallbackId === callback.id);
  if (actionCommitted && committedTask.status === status) {
    const recoveryEvents = mutation.state.settings?.notifications?.events?.taskAssigned
      && ['waiting', 'review', 'done'].includes(status)
      ? [notificationEvent(`Задача: «${committedTask.title}» → ${taskStatusLabel(status)}`, 'tasks', committedTask.id, committedTask.assigneeId)]
      : [];
    await dispatchNotifications(
      mutation.previous,
      mutation.state,
      env,
      user.name,
      telegramOrigin(env),
      `Обновлена задача «${committedTask.title}»`,
      `telegram-task-status:${callback.id}`,
      null,
      recoveryEvents,
    );
  }
  const visibility = await telegramDurableVisibility(
    env,
    callback.message.chat.id,
    `Задача «${committedTask.title}» теперь: ${taskStatusLabel(committedTask.status)}.\n${deepLink(telegramOrigin(env), binding.project_id, 'tasks', committedTask.id)}`,
    committedTask.status === 'done' ? {} : { reply_markup: taskActionMarkup(binding.project_id, committedTask.id, user.role) },
    `telegram-task-status-confirm:${callback.id}`,
  );
  requireTelegramVisibility(visibility);
  await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, `Статус: ${taskStatusLabel(committedTask.status)}`);
};

const telegramHandleCallback = async (callback, env) => {
  if (!callback?.id || !callback?.from?.id || !callback?.message?.chat?.id) return;
  const parts = clean(callback.data, 200).split('|');
  const action = parts[0];
  const telegramUserId = String(callback.from.id);
  const chatId = String(callback.message.chat.id);
  if (callback.message.chat.type !== 'private' && !await telegramGroupChatAuthorized(env, chatId)) {
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Этот чат не подключён к ИКИОМА ОС.', true);
    return;
  }
  const bindings = await bindingsForTelegramUser(env.DB, telegramUserId);
  if (!bindings.length) {
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сначала подключите личный Telegram в ИКИОМА ОС.', true);
    return;
  }
  if (action === 'ts') {
    const taskMatches = [];
    for (const item of bindings) {
      const snapshot = await readSnapshot(env.DB, item.project_id);
      for (const task of snapshot?.state?.tasks ?? []) {
        if (telegramTaskActionKey(item.project_id, task.id) === parts[1]) {
          taskMatches.push({ binding: item, taskId: task.id });
        }
      }
    }
    if (taskMatches.length !== 1) throw new Error('action_denied');
    await telegramChangeTaskStatus(callback, taskMatches[0].binding, taskMatches[0].taskId, parts[2], env);
    return;
  }
  const draft = await readTelegramDraft(env.DB, parts[1], telegramUserId);
  if (!draft) {
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Черновик уже закрыт или устарел.', true);
    return;
  }
  if (String(draft.chat_id) !== chatId) throw new Error('action_denied');
  if (action === 'ps') {
    const requestedProject = draft.payload.projects?.[Number(parts[2])];
    if (!requestedProject) throw new Error('project_not_found');
    await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
      await assertTelegramDraftLease(env.DB, claimedDraft);
      const lockedProject = claimedDraft.payload.selectedProjectId
        ? claimedDraft.payload.projects?.find((item) => item.id === claimedDraft.payload.selectedProjectId)
        : null;
      const project = lockedProject ?? requestedProject;
      const selectedBinding = bindings.find((item) => item.project_id === project.id);
      if (!selectedBinding) throw new Error('action_denied');
      if (!claimedDraft.payload.selectedProjectId) {
        claimedDraft.payload = {
          ...claimedDraft.payload,
          selectedProjectId: project.id,
          selectedProjectName: project.name,
        };
        Object.assign(claimedDraft, await saveClaimedTelegramDraftPayload(env.DB, claimedDraft, claimedDraft.payload));
      }
      await saveTelegramProjectSelection(env.DB, telegramUserId, chatId, project.id);
      const pending = claimedDraft.payload.pending;
      if (pending?.type === 'command') {
        await telegramHandleCommand({
          chat: callback.message.chat,
          from: callback.from,
          message_id: pending.sourceMessageId || callback.message.message_id,
        }, selectedBinding, pending.command, env, { bindings, projectConfirmed: true });
      } else if (pending?.type === 'attachment' && pending.message) {
        await telegramAttachmentDraft({ ...pending.message, chat: callback.message.chat, from: callback.from }, selectedBinding, env);
      }
      // Selection remains resumable until the child draft/card is created.
      // If Telegram or storage fails above, runClaimed releases it for retry.
      await updateTelegramDraft(env.DB, claimedDraft, claimedDraft.payload, 'confirmed');
      await telegramConfirmVisible(env, callback.message.chat.id, callback.message.message_id, `Проект выбран: ${project.name}`);
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
    });
    return;
  }
  const binding = await bindingForTelegramProject(env.DB, telegramUserId, draft.project_id);
  if (!binding) throw new Error('action_denied');
  if (action === 'tx' || action === 'fx' || action === 'nx' || action === 'xx') {
    await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
      await updateTelegramDraft(env.DB, claimedDraft, claimedDraft.payload, 'canceled');
      await telegramConfirmVisible(env, callback.message.chat.id, callback.message.message_id, 'Черновик отменён.');
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
    });
    return;
  }
  if (action === 'tc') {
    await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Создаю задачу…');
      await telegramConfirmTask(callback, claimedDraft, binding, env);
    });
    return;
  }
  if (action === 'fc') {
    await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сохраняю файл…');
      await telegramConfirmFile(callback, claimedDraft, binding, env);
    });
    return;
  }
  if (action === 'nc') {
    await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сохраняю запись…');
      await telegramConfirmNote(callback, claimedDraft, binding, env);
    });
    return;
  }
  if (action === 'xc') {
    await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
      if (!claimedDraft.payload.budgetLineId || !claimedDraft.payload.stageId || !claimedDraft.payload.counterpartyId) {
        throw new Error('expense_details_missing');
      }
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сохраняю расход…');
      await telegramConfirmExpense(callback, claimedDraft, binding, env);
    });
    return;
  }
  if (action === 'eb' || action === 'ec' || action === 'es') {
    await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
      const options = action === 'eb'
        ? claimedDraft.payload.budgetLines
        : action === 'ec'
          ? claimedDraft.payload.counterparties
          : claimedDraft.payload.stages;
      const selected = options?.[Number(parts[2])];
      if (!selected) throw new Error('expense_details_missing');
      if (action === 'eb') {
        claimedDraft.payload.budgetLineId = selected.id;
        claimedDraft.payload.stageId = selected.stageIds?.length === 1 ? selected.stageIds[0] : '';
      } else if (action === 'ec') {
        claimedDraft.payload.counterpartyId = selected.id;
      } else {
        const budgetLine = claimedDraft.payload.budgetLines?.find((item) => item.id === claimedDraft.payload.budgetLineId);
        if (!budgetLine?.stageIds?.includes(selected.id)) throw new Error('action_denied');
        claimedDraft.payload.stageId = selected.id;
      }
      const editingDraft = await saveClaimedTelegramDraftPayload(env.DB, claimedDraft, claimedDraft.payload);
      try {
        const card = renderExpenseDraft(editingDraft);
        await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, callback.message.chat.id, callback.message.message_id, card.text, card.replyMarkup);
        await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
      } finally {
        await releaseTelegramDraft(env.DB, editingDraft);
      }
    });
    return;
  }
  if (action === 'ta' || action === 'td') {
    await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
      const snapshot = await readSnapshot(env.DB, claimedDraft.project_id);
      if (!snapshot) throw new Error('project_not_found');
      if (action === 'ta') {
        const users = (snapshot.state.settings?.users ?? []).filter((user) => user.status !== 'disabled' && user.role !== 'client').slice(0, 8);
        const assignee = users[Number(parts[2])];
        if (assignee) claimedDraft.payload.assigneeId = assignee.id;
      } else {
        const offset = Number(parts[2]);
        if (![0, 1, 3, 7].includes(offset)) throw new Error('invalid_due_date');
        claimedDraft.payload.dueOffset = offset;
        claimedDraft.payload.dueDate = dateKey(addDays(new Date(), offset));
      }
      const editingDraft = await saveClaimedTelegramDraftPayload(env.DB, claimedDraft, claimedDraft.payload);
      try {
        const card = renderTaskDraft(editingDraft, snapshot.state);
        await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, callback.message.chat.id, callback.message.message_id, card.text, card.replyMarkup);
        await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
      } finally {
        await releaseTelegramDraft(env.DB, editingDraft);
      }
    });
    return;
  }
};

const processTelegramUpdate = async (update, env) => {
  try {
    if (update.callback_query) return await telegramHandleCallback(update.callback_query, env);
    if (update.message) return await telegramHandleMessage(update.message, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'processing_failed';
    const handledErrors = new Set([
      'access_disabled',
      'action_denied',
      'assignee_missing',
      'draft_state_conflict',
      'expense_details_missing',
      'invalid_due_date',
      'invalid_note',
      'payload_too_large',
      'project_not_found',
      'storage_unavailable',
      'telegram_file_too_large',
      'telegram_file_unavailable',
    ]);
    const terminalTelegramError = /^telegram_[^:]+_failed:(?:400|401|403|404):/u.test(message);
    if (!handledErrors.has(message) && !terminalTelegramError) throw error;
    const userText = message === 'telegram_file_too_large'
      ? 'Файл больше 20 МБ и не может быть сохранён.'
      : message === 'storage_unavailable'
        ? 'Хранилище проекта временно недоступно.'
        : message === 'expense_details_missing'
          ? 'Для расхода нужно выбрать статью бюджета, этап и контрагента.'
          : message === 'assignee_missing'
            ? 'Выбранный ответственный больше недоступен. Выберите другого участника.'
            : message === 'draft_state_conflict'
              ? 'Черновик уже обрабатывается или был изменён. Откройте актуальную карточку.'
              : message === 'project_not_found' || message === 'access_disabled'
                ? 'Проект или доступ к нему больше недоступен.'
                : message === 'payload_too_large'
                  ? 'Данные слишком велики для сохранения.'
                  : message === 'telegram_file_unavailable'
                    ? 'Telegram не смог передать файл. Ничего не сохранено — отправьте файл ещё раз.'
                    : terminalTelegramError
                      ? 'Telegram отклонил ответ бота. Ничего нового не записано; повторите команду или откройте /help.'
        : message === 'action_denied'
          ? 'Для этого действия недостаточно прав.'
          : 'Не удалось выполнить действие. Повторите через минуту.';
    if (update.callback_query?.id) {
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, update.callback_query.id, userText, true);
      if (update.callback_query.message?.chat?.id) {
        await telegramDurableSend(
          env,
          update.callback_query.message.chat.id,
          userText,
          {},
          `telegram-error:${clean(update.update_id ?? update.callback_query.id, 100)}:${update.callback_query.message.chat.id}`,
        );
      }
    } else if (update.message?.chat?.id) {
      await telegramDurableSend(
        env,
        update.message.chat.id,
        userText,
        {},
        `telegram-error:${clean(update.update_id ?? update.message.message_id, 100)}:${update.message.chat.id}`,
      );
    }
    return { handled: true, error: message };
  }
};

export const claimTelegramUpdate = claimTelegramUpdateModule;

const handleTelegramUpdate = createTelegramWebhookHandler({
  ensureSchema,
  rememberTelegramChatCandidates,
  flushTelegramOutbox,
  claimTelegramUpdate,
  readTelegramUpdateStatus,
  processTelegramUpdate,
  completeTelegramUpdate,
  failTelegramUpdate,
});


const integrationStatus = createIntegrationStatus({ ensureSchema, resolveTelegramConnection });

const {
  status: handleIntegrationStatus,
  test: handleIntegrationTest,
  telegramChatSelect: handleTelegramChatSelect,
} = createIntegrationHandlers({
  integrationStatus,
  resolveTelegramConnection,
  telegramSend,
  reviveTelegramOutbox,
  flushTelegramOutbox,
  readObservedTelegramChats,
  readTelegramBot,
  discoverTelegramChats,
  verifyAndStoreTelegramChat,
});

const handleTelegramBootstrap = createTelegramBootstrapHandler({
  ensureSchema,
  changes,
  resolveTelegramConnection,
  telegramRequest,
  telegramSend,
  parseTelegramBody,
  telegramOrigin,
});

const {
  inbox: handleLeadInbox,
  publicLead: handlePublicLead,
} = createLeadHandlers({
  ensureSchema,
  readSnapshot,
  resolveTelegramConnection,
  telegramSend,
  deepLink,
});

export const claimPublicLeadRateLimit = (...args) => claimPublicLeadRateLimitModule(...args);

const handleDeveloperFeedback = createDeveloperFeedbackHandler({ ensureSchema, readSnapshot });

const handlePutState = createProjectWriteHandler({
  ensureSchema,
  readSnapshot,
  changes,
  applyAutomations: applyBattleAutomations,
  buildNotificationPlan,
  dispatchNotifications,
});

const handleApi = createApiHandler({
  session: handleSession,
  accessUsers: handleAccessUsers,
  getState: handleGetState,
  putState: handlePutState,
  projects: handleProjects,
  integrationStatus: handleIntegrationStatus,
  integrationTest: handleIntegrationTest,
  telegramChatSelect: handleTelegramChatSelect,
  telegramLink: handleTelegramLink,
  telegramUnlink: handleTelegramUnlink,
  telegramBootstrap: handleTelegramBootstrap,
  telegramUpdate: handleTelegramUpdate,
  cameraStatus: handleCameraStatus,
  cameraView: handleCameraView,
  qualityPhotoUpload: handleQualityPhotoUpload,
  qualityPhotoFile: handleQualityPhotoFile,
  documentUpload: handleDocumentUpload,
  documentFile: handleDocumentFile,
  fieldReportFile: handleFieldReportFile,
  leadInbox: handleLeadInbox,
  publicLead: handlePublicLead,
  developerFeedback: handleDeveloperFeedback,
  audit: handleAudit,
});

const serveSpa = async (request, env) => {
  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status !== 404 || request.method !== 'GET') return assetResponse;

  const url = new URL(request.url);
  if (url.pathname.includes('.')) return assetResponse;

  url.pathname = '/index.html';
  return env.ASSETS.fetch(new Request(url, request));
};

export default {
  async fetch(request, env, context) {
    const requestEnv = context?.waitUntil
      ? { ...env, WAIT_UNTIL: (promise) => context.waitUntil(promise) }
      : env;
    const url = new URL(request.url);
    if ((url.pathname === '/api/readiness' || url.pathname === '/api/health') && request.method === 'GET') {
      const readiness = await battleReadiness(requestEnv);
      return json(readiness, readiness.ok ? 200 : 503);
    }
    try {
      await ensureBattleReady(requestEnv);
      if (requestEnv.DB && requestEnv.TELEGRAM_BOT_TOKEN && context?.waitUntil) {
        context.waitUntil(flushTelegramOutbox(requestEnv).catch(() => null));
      }
      if (url.pathname.startsWith('/api/')) return handleApi(request, requestEnv, context);
      return serveSpa(request, requestEnv);
    } catch {
      if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'battle_initialization_failed' }, 503);
      return new Response('ИКИОМА ОС временно завершает подготовку рабочего пространства. Обновите страницу через минуту.', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
  },
  async scheduled(_controller, env, context) {
    const scheduledEnv = context?.waitUntil
      ? { ...env, WAIT_UNTIL: (promise) => context.waitUntil(promise) }
      : env;
    await ensureBattleReady(scheduledEnv);
    context.waitUntil(flushTelegramOutbox(scheduledEnv));
  },
};
