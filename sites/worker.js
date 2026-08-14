import {
  authenticatedIdentity,
  mergeStateForRole,
  projectIdentity,
  stateForRole,
} from './access-control.js';
import { addCalendarDays, addDays, dateKey, isoDate } from './lib/date.js';
import { json, publicLeadResponse } from './lib/http.js';
import {
  clean,
  detectRasterImageType,
  documentMimeType,
  normalizeClientAddress,
  rasterImageMimeType,
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
  saveTelegramProjectSelection,
  selectTelegramBinding,
} from './telegram/bindings.js';

const MAX_STATE_BYTES = 6_000_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_QUALITY_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 256 * 1024;
const MAX_JSON_BODY_BYTES = 32 * 1024;
const MAX_TELEGRAM_UPDATE_BYTES = 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 2;
const TELEGRAM_CONFIG_PROJECT_ID = '__integration__:telegram';
const BATTLE_SCHEMA_VERSION = 17;
const BATTLE_RESET_KEY = 'battle_v17_reset';
const BATTLE_SCHEMA_KEY = 'battle_schema_version';
const PUBLIC_LEAD_PROJECT_ID = 'ikioma-sales';
const PUBLIC_LEAD_ORIGINS = new Set(['https://ikioma.ru', 'https://www.ikioma.ru']);
const PUBLIC_LEAD_CLIENT_LIMIT = 5;
const PUBLIC_LEAD_RATE_WINDOW_MS = 60_000;
const PUBLIC_LEAD_BODY_LIMIT = 32 * 1024;
const TELEGRAM_MUTATION_NOOP = Symbol('telegram_mutation_noop');
let schemaPromise;
let battleReadyPromise;
let activeUploads = 0;

const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

const readStreamPrefix = async (stream, limit = 512) => {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const kept = chunk.subarray(0, Math.max(0, limit - size));
      chunks.push(kept);
      size += kept.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  const prefix = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return prefix;
};

const drainReader = async (reader) => {
  try {
    while (!(await reader.read()).done) { /* Отбрасываем остаток без буферизации. */ }
  } catch {
    // Соединение могло закрыться после раннего ответа 413.
  }
};

const readJsonBodyLimited = async (request, limit) => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('payload_too_large');
  if (!request.body) throw new Error('invalid_json');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    size += chunk.byteLength;
    if (size > limit) {
      void drainReader(reader);
      throw new Error('payload_too_large');
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error('invalid_json');
  }
};

export const requestWithBodyLimit = (request, limit) => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('payload_too_large');
  if (!request.body) return request;
  const reader = request.body.getReader();
  let size = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        size += chunk.byteLength;
        if (size > limit) {
          void drainReader(reader);
          controller.error(new Error('payload_too_large'));
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      void drainReader(reader);
      return undefined;
    },
  });
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    duplex: 'half',
  });
};

const readFormDataLimited = async (request, limit) => requestWithBodyLimit(request, limit).formData();

export const claimUploadAdmission = () => {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) return null;
  activeUploads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads = Math.max(0, activeUploads - 1);
  };
};

const protectedFileHeaders = (filename, fallbackName, { inlineMime = '' } = {}) => {
  const safeName = safeFileName(filename || fallbackName);
  const fallback = safeName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || fallbackName;
  const disposition = inlineMime ? 'inline' : 'attachment';
  return new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Type': inlineMime || 'application/octet-stream',
    'Content-Disposition': `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Content-Security-Policy': "sandbox; default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
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
          used_at TEXT
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
    ]).then(() => Promise.all([
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

const handleGetState = async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
  if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);

  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    if (!snapshot) return json({ ok: false, error: 'not_found' }, 404);
    const identity = projectIdentity(request, env, snapshot.state);
    if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
    return json({ ok: true, snapshot: { ...snapshot, state: stateForRole(snapshot.state, identity), updatedRole: identity.role } });
  } catch {
    return json({ ok: false, error: 'storage_error' }, 500);
  }
};

const notificationStatusLabels = {
  ordered: 'заказано',
  in_transit: 'в пути',
  delivered: 'доставлено',
  accepted: 'принято',
  blocked: 'заблокировано',
  rework: 'доработка',
  waiting: 'ожидает',
  review: 'на проверке',
  done: 'выполнено',
};

const activeAutomationUser = (state, preferredName = '') => {
  const users = (state.settings?.users ?? []).filter((user) => user.status === 'active');
  const preferred = clean(preferredName, 120).toLocaleLowerCase('ru');
  return users.find((user) => clean(user.name, 120).toLocaleLowerCase('ru') === preferred)
    ?? users.find((user) => user.role === 'foreman')
    ?? users.find((user) => user.role === 'management')
    ?? { id: 'user-owner', name: 'Виталий Озолин', role: 'management', status: 'active' };
};

const applyBattleAutomations = (previous, next, actor) => {
  if (!previous || next.project?.status === 'workspace') return next;
  next.tasks = Array.isArray(next.tasks) ? next.tasks : [];
  next.activity = Array.isArray(next.activity) ? next.activity : [];
  const now = new Date().toISOString();
  const tomorrow = isoDate(addCalendarDays(new Date(), 1));
  const automated = [];

  const ensureTask = ({ id, title, description, dueDate, priority, assignee, links }) => {
    const existing = next.tasks.find((task) => task.id === id);
    if (existing) {
      if (['done', 'canceled'].includes(existing.status)) {
        existing.status = 'todo';
        existing.completedAt = undefined;
        existing.completionNote = undefined;
        existing.updatedAt = now;
        existing.dueDate = dueDate || tomorrow;
        existing.rescheduleCount = Number(existing.rescheduleCount ?? 0) + 1;
        existing.history = [
          ...(existing.history ?? []),
          {
            id: crypto.randomUUID(),
            timestamp: now,
            actor: 'ИКИОМА ОС',
            kind: 'reopened',
            text: `Автоматически переоткрыта после нового события · ${actor}`,
          },
        ];
        automated.push(`Переоткрыта задача «${title}»`);
      }
      return;
    }
    next.tasks.unshift({
      id,
      title,
      description,
      status: 'todo',
      priority,
      assigneeId: assignee.id,
      assigneeName: assignee.name,
      createdBy: 'ИКИОМА ОС',
      createdAt: now,
      updatedAt: now,
      dueDate: dueDate || tomorrow,
      originalDueDate: dueDate || tomorrow,
      rescheduleCount: 0,
      ...links,
      history: [{
        id: crypto.randomUUID(),
        timestamp: now,
        actor: 'ИКИОМА ОС',
        kind: 'created',
        text: `Создана автоматически после изменения · ${actor}`,
      }],
    });
    automated.push(`Создана задача «${title}»`);
  };

  const beforeCheckpoints = new Map((previous.checkpoints ?? []).map((item) => [item.id, item]));
  for (const checkpoint of next.checkpoints ?? []) {
    const before = beforeCheckpoints.get(checkpoint.id);
    if (checkpoint.status !== 'rework' || before?.status === 'rework') continue;
    const stage = (next.stages ?? []).find((item) => item.id === checkpoint.stageId);
    const assignee = activeAutomationUser(next, checkpoint.assignee || stage?.responsible);
    ensureTask({
      id: `auto-quality-${checkpoint.id}`,
      title: `Устранить замечание: ${checkpoint.title}`,
      description: checkpoint.note || `Проверка качества возвращена на доработку${checkpoint.zone ? ` · ${checkpoint.zone}` : ''}.`,
      dueDate: tomorrow,
      priority: 'high',
      assignee,
      links: { stageId: checkpoint.stageId, checkpointId: checkpoint.id },
    });
  }

  const beforeSupply = new Map((previous.procurement ?? []).map((item) => [item.id, item]));
  for (const item of next.procurement ?? []) {
    const before = beforeSupply.get(item.id);
    if (!item.risk || before?.risk === item.risk) continue;
    const assignee = activeAutomationUser(next, item.owner);
    ensureTask({
      id: `auto-supply-${item.id}`,
      title: `Снять риск поставки: ${item.item}`,
      description: item.risk,
      dueDate: item.neededBy || tomorrow,
      priority: 'high',
      assignee,
      links: { stageId: item.stageId, procurementItemId: item.id },
    });
  }

  const beforeStages = new Map((previous.stages ?? []).map((item) => [item.id, item]));
  for (const stage of next.stages ?? []) {
    const before = beforeStages.get(stage.id);
    if (stage.status !== 'in_progress' || before?.status === 'in_progress') continue;
    const assignee = activeAutomationUser(next, stage.responsible);
    if (!(next.checkpoints ?? []).some((checkpoint) => checkpoint.stageId === stage.id)) {
      const reviewer = (next.settings?.users ?? []).find((user) => user.status === 'active' && user.role === 'management')
        ?? activeAutomationUser(next, '');
      next.checkpoints = Array.isArray(next.checkpoints) ? next.checkpoints : [];
      next.checkpoints.push({
        id: `auto-checkpoint-${stage.id}`,
        stageId: stage.id,
        title: `Фотофиксация: ${stage.shortName || stage.name}`,
        zone: 'Весь этап',
        status: 'pending',
        requiredShots: [
          'Общий вид зоны',
          'Средний план работы',
          'Крупный план узла',
          'Замер с читаемым прибором',
          'Маркировка материала',
          'Результат испытания',
          'Итог после устранения замечаний',
        ],
        photos: [],
        assignee: assignee.name,
        reviewer: reviewer.name,
        clientVisible: false,
      });
      automated.push(`Создана контрольная точка «${stage.shortName || stage.name}»`);
    }
    ensureTask({
      id: `auto-stage-${stage.id}`,
      title: `Вести этап: ${stage.name}`,
      description: `Контролировать ход этапа, сроки, фотофиксацию и закрывающие документы.`,
      dueDate: stage.forecastEnd || stage.planEnd || tomorrow,
      priority: 'normal',
      assignee,
      links: { stageId: stage.id },
    });
  }

  if (automated.length) {
    next.activity.unshift({
      id: crypto.randomUUID(),
      timestamp: now,
      actor: 'ИКИОМА ОС',
      text: automated.join('. '),
      tone: 'neutral',
    });
  }
  return next;
};

const notificationEvent = (text, page, entityId, recipientId) => ({ text, page, entityId, recipientId });

const notificationEvents = (previous, next) => {
  if (!previous) return [];
  const enabled = next.settings?.notifications?.events ?? {};
  const events = [];
  const beforeCheckpoints = new Map((previous.checkpoints ?? []).map((item) => [item.id, item]));
  for (const item of next.checkpoints ?? []) {
    const before = beforeCheckpoints.get(item.id);
    if (enabled.qualityRework && item.status === 'rework' && before?.status !== 'rework') events.push(notificationEvent(`Качество: «${item.title}» возвращено на доработку`, 'quality', item.id));
    if (enabled.qualityRework && item.status === 'accepted' && before?.status !== 'accepted') events.push(notificationEvent(`Качество: «${item.title}» принято`, 'quality', item.id));
  }
  const beforeSupply = new Map((previous.procurement ?? []).map((item) => [item.id, item]));
  for (const item of next.procurement ?? []) {
    const before = beforeSupply.get(item.id);
    if (enabled.supplyRisk && item.risk && before?.risk !== item.risk) events.push(notificationEvent(`Снабжение: «${item.item}» — ${item.risk}`, 'procurement', item.id));
    if (enabled.supplyRisk && before && before.status !== item.status && ['ordered', 'in_transit', 'delivered', 'accepted'].includes(item.status)) events.push(notificationEvent(`Снабжение: «${item.item}» → ${notificationStatusLabels[item.status] ?? item.status}`, 'procurement', item.id));
  }
  const beforeFinance = new Map((previous.financeEntries ?? []).map((item) => [item.id, item]));
  for (const item of next.financeEntries ?? []) {
    const before = beforeFinance.get(item.id);
    if (enabled.financeApproval && item.kind === 'expense' && item.status === 'accepted' && before?.status !== 'accepted') events.push(notificationEvent(`Финансы: принято «${item.description}», ${item.amount} ₽`, 'finance', item.id));
    if (enabled.financeApproval && item.kind === 'expense' && Number(item.paidAmount) > Number(before?.paidAmount ?? 0)) events.push(notificationEvent(`Финансы: оплачено «${item.description}», всего ${Number(item.paidAmount)} ₽`, 'finance', item.id));
    if (enabled.financeApproval && item.kind === 'income' && Number(item.paidAmount) > Number(before?.paidAmount ?? 0)) events.push(notificationEvent(`Финансы: получено «${item.description}», всего ${Number(item.paidAmount)} ₽`, 'finance', item.id));
  }
  const beforeStages = new Map((previous.stages ?? []).map((item) => [item.id, item]));
  for (const item of next.stages ?? []) {
    const before = beforeStages.get(item.id);
    if (enabled.scheduleDelay && item.forecastEnd > item.planEnd && before?.forecastEnd !== item.forecastEnd) events.push(notificationEvent(`График: «${item.name}», прогноз ${item.forecastEnd} позже плана ${item.planEnd}`, 'schedule', item.id));
    if (enabled.scheduleDelay && before && before.status !== item.status && ['blocked', 'accepted', 'rework'].includes(item.status)) events.push(notificationEvent(`Этап: «${item.name}» → ${notificationStatusLabels[item.status] ?? item.status}`, 'schedule', item.id));
  }
  const beforeLeads = new Set((previous.leads ?? []).map((item) => item.id));
  for (const item of next.leads ?? []) if (enabled.leadWithoutAction && !beforeLeads.has(item.id)) events.push(notificationEvent(`CRM: новая заявка ${item.name}${clean(item.nextAction) ? `, далее: ${clean(item.nextAction)}` : ' без следующего действия'}`, 'marketing', item.id));
  const beforeTasks = new Map((previous.tasks ?? []).map((item) => [item.id, item]));
  const today = new Date().toISOString().slice(0, 10);
  for (const item of next.tasks ?? []) {
    const before = beforeTasks.get(item.id);
    if (enabled.taskAssigned && (!before || before.assigneeId !== item.assigneeId)) events.push(notificationEvent(`Задача: «${item.title}» → ${item.assigneeName}, срок ${item.dueDate}`, 'tasks', item.id, item.assigneeId));
    if (enabled.taskAssigned && before && before.dueDate !== item.dueDate) events.push(notificationEvent(`Срок задачи «${item.title}» перенесён: ${before.dueDate} → ${item.dueDate}`, 'tasks', item.id, item.assigneeId));
    if (enabled.taskAssigned && before && before.status !== item.status && ['waiting', 'review', 'done'].includes(item.status)) events.push(notificationEvent(`Задача: «${item.title}» → ${notificationStatusLabels[item.status] ?? item.status}`, 'tasks', item.id, item.assigneeId));
    if (enabled.taskOverdue && item.dueDate < today && !['done', 'canceled'].includes(item.status) && (!before || before.dueDate >= today || ['done', 'canceled'].includes(before.status))) events.push(notificationEvent(`Просрочена задача: «${item.title}», ответственный ${item.assigneeName}`, 'tasks', item.id, item.assigneeId));
  }
  const beforeDocuments = new Map((previous.documents ?? []).map((item) => [item.id, item]));
  for (const item of next.documents ?? []) {
    const before = beforeDocuments.get(item.id);
    if (before && before.status !== 'signed' && item.status === 'signed') events.push(notificationEvent(`Документ подписан: «${item.name}»`, 'project', item.id));
  }
  return events.slice(0, 8);
};

const deepLink = (origin, projectId, page, entityId) => {
  const url = new URL('/', origin);
  url.searchParams.set('projectId', projectId);
  url.searchParams.set('page', page);
  if (entityId) url.searchParams.set('entity', entityId);
  return url.toString();
};

export const flushTelegramOutbox = (env, limit = 10) => flushTelegramOutboxModule(env, limit, ensureSchema);

const telegramChatCandidates = (updates) => {
  const chats = new Map();
  for (const update of updates ?? []) {
    const candidates = [
      update?.message?.chat,
      update?.edited_message?.chat,
      update?.channel_post?.chat,
      update?.edited_channel_post?.chat,
      update?.my_chat_member?.chat,
      update?.chat_member?.chat,
    ];
    for (const chat of candidates) {
      if (!chat || !['group', 'supergroup'].includes(chat.type) || chat.id === undefined || chat.id === null) continue;
      const id = String(chat.id);
      chats.set(id, {
        id,
        title: clean(chat.title, 160) || 'Общий Telegram-чат',
        type: chat.type,
      });
    }
  }
  return [...chats.values()];
};

const rememberTelegramChatCandidates = async (db, update) => {
  if (!db) return;
  const candidates = telegramChatCandidates([update]);
  if (!candidates.length) return;
  await ensureSchema(db);
  const observedAt = new Date().toISOString();
  for (const chat of candidates) {
    await db.prepare(`
      INSERT INTO telegram_chat_candidates (chat_id, title, type, observed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        title = excluded.title,
        type = excluded.type,
        observed_at = excluded.observed_at
    `).bind(chat.id, chat.title, chat.type, observedAt).run();
  }
};

const readObservedTelegramChats = async (db) => {
  if (!db) return [];
  await ensureSchema(db);
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(`
    SELECT chat_id, title, type
    FROM telegram_chat_candidates
    WHERE observed_at >= ?
    ORDER BY observed_at DESC
    LIMIT 20
  `).bind(cutoff).all();
  return (result?.results ?? []).map((row) => ({
    id: clean(row.chat_id, 120),
    title: clean(row.title, 160) || 'Общий Telegram-чат',
    type: clean(row.type, 40) || 'group',
  })).filter((chat) => chat.id);
};

const readTelegramBot = async (token) => {
  try {
    const response = await telegramRequest(token, 'getMe');
    const body = await parseTelegramBody(response);
    return response.ok && body?.ok ? body.result : null;
  } catch {
    return null;
  }
};

const discoverTelegramChats = async (token) => {
  try {
    const [botResponse, updatesResponse] = await Promise.all([
      telegramRequest(token, 'getMe'),
      telegramRequest(token, 'getUpdates', {
        timeout: 0,
        allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member', 'chat_member'],
      }),
    ]);
    const [botBody, updatesBody] = await Promise.all([
      parseTelegramBody(botResponse),
      parseTelegramBody(updatesResponse),
    ]);
    if (!botResponse.ok || !botBody?.ok) return { ok: false, issue: 'invalid_token', bot: null, candidates: [] };
    if (!updatesResponse.ok || !updatesBody?.ok) return { ok: false, issue: 'updates_unavailable', bot: botBody.result, candidates: [] };
    return {
      ok: true,
      issue: '',
      bot: botBody.result,
      candidates: telegramChatCandidates(updatesBody.result),
    };
  } catch {
    return { ok: false, issue: 'provider_unavailable', bot: null, candidates: [] };
  }
};

const readTelegramConfig = async (db) => {
  if (!db) return null;
  await ensureSchema(db);
  const snapshot = await readSnapshot(db, TELEGRAM_CONFIG_PROJECT_ID);
  const telegram = snapshot?.state?.telegram;
  const chatId = clean(telegram?.chatId, 120);
  if (!chatId) return null;
  return {
    chat: {
      id: chatId,
      title: clean(telegram?.chatTitle, 160) || 'Общий Telegram-чат',
      type: clean(telegram?.chatType, 40) || 'group',
    },
    bot: telegram?.bot && typeof telegram.bot === 'object' ? telegram.bot : null,
    verifiedAt: clean(telegram?.verifiedAt, 60),
  };
};

const telegramGroupChatAuthorized = async (env, chatId) => {
  const expected = clean(env.TELEGRAM_COMMON_CHAT_ID, 120) || clean(env.TELEGRAM_CHAT_ID, 120);
  if (expected) return String(chatId) === expected;
  const stored = await readTelegramConfig(env.DB);
  return Boolean(stored?.chat?.id && String(chatId) === String(stored.chat.id));
};

const writeTelegramConfig = async (db, chat, bot) => {
  if (!db) return;
  await ensureSchema(db);
  const now = new Date().toISOString();
  const stateJson = JSON.stringify({
    version: 1,
    project: { id: TELEGRAM_CONFIG_PROJECT_ID },
    telegram: {
      chatId: clean(chat.id, 120),
      chatTitle: clean(chat.title, 160),
      chatType: clean(chat.type, 40),
      bot: bot ? {
        id: String(bot.id ?? ''),
        username: clean(bot.username, 120),
        name: clean(bot.first_name, 120),
      } : null,
      verifiedAt: now,
    },
  });
  await db.prepare(`
    INSERT INTO project_state (
      project_id, state_json, revision, created_at, updated_at, updated_by, updated_role
    ) VALUES (?, ?, 1, ?, ?, 'telegram-setup', 'management')
    ON CONFLICT(project_id) DO UPDATE SET
      state_json = excluded.state_json,
      revision = project_state.revision + 1,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by,
      updated_role = excluded.updated_role
  `).bind(TELEGRAM_CONFIG_PROJECT_ID, stateJson, now, now).run();
};

const verifyAndStoreTelegramChat = async (env, chat, bot) => {
  try {
    const response = await telegramSend(
      env.TELEGRAM_BOT_TOKEN,
      chat.id,
      'ИКИОМА ОС: общий чат подключён.\n\nСюда будут приходить изменения по проектам, этапам, задачам, закупкам и проверкам.',
    );
    if (!response.ok) return { ok: false, issue: 'send_failed' };
    await writeTelegramConfig(env.DB, chat, bot);
    await reviveTelegramOutbox(env.DB, chat.id);
    return { ok: true, issue: '' };
  } catch {
    return { ok: false, issue: 'provider_unavailable' };
  }
};

const resolveTelegramConnection = async (env, { discover = true } = {}) => {
  const tokenConfigured = Boolean(env.TELEGRAM_BOT_TOKEN);
  const environmentChatId = clean(env.TELEGRAM_COMMON_CHAT_ID, 120) || clean(env.TELEGRAM_CHAT_ID, 120);
  if (!tokenConfigured) return { tokenConfigured: false, chat: null, bot: null, candidates: [], issue: 'token_missing' };
  if (environmentChatId) {
    return {
      tokenConfigured: true,
      chat: { id: environmentChatId, title: 'Общий Telegram-чат', type: 'group' },
      bot: null,
      candidates: [],
      issue: '',
    };
  }

  const stored = await readTelegramConfig(env.DB);
  if (stored?.chat) return { tokenConfigured: true, ...stored, candidates: [], issue: '' };
  if (!discover) return { tokenConfigured: true, chat: null, bot: null, candidates: [], issue: 'chat_missing' };

  const observedCandidates = await readObservedTelegramChats(env.DB);
  if (observedCandidates.length) {
    const bot = await readTelegramBot(env.TELEGRAM_BOT_TOKEN);
    if (observedCandidates.length !== 1) {
      return {
        tokenConfigured: true,
        chat: null,
        bot,
        candidates: observedCandidates,
        issue: 'chat_ambiguous',
      };
    }
    const chat = observedCandidates[0];
    const verification = await verifyAndStoreTelegramChat(env, chat, bot);
    if (!verification.ok) {
      return {
        tokenConfigured: true,
        chat: null,
        bot,
        candidates: observedCandidates,
        issue: verification.issue,
      };
    }
    return { tokenConfigured: true, chat, bot, candidates: [], issue: '', verifiedAt: new Date().toISOString() };
  }

  const discovered = await discoverTelegramChats(env.TELEGRAM_BOT_TOKEN);
  if (!discovered.ok) return { tokenConfigured: true, chat: null, ...discovered };
  if (discovered.candidates.length !== 1) {
    return {
      tokenConfigured: true,
      chat: null,
      bot: discovered.bot,
      candidates: discovered.candidates,
      issue: discovered.candidates.length ? 'chat_ambiguous' : 'chat_not_found',
    };
  }

  const chat = discovered.candidates[0];
  const verification = await verifyAndStoreTelegramChat(env, chat, discovered.bot);
  if (!verification.ok) {
    return {
      tokenConfigured: true,
      chat: null,
      bot: discovered.bot,
      candidates: discovered.candidates,
      issue: verification.issue,
    };
  }
  return { tokenConfigured: true, chat, bot: discovered.bot, candidates: [], issue: '', verifiedAt: new Date().toISOString() };
};

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

const shortId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 16);

const parseTaskDate = (text) => {
  const source = clean(text, 2000).toLocaleLowerCase('ru');
  const now = new Date();
  if (/\bсегодня\b/.test(source)) return dateKey(now);
  if (/\bпослезавтра\b/.test(source)) return dateKey(addDays(now, 2));
  if (/\bзавтра\b/.test(source)) return dateKey(addDays(now, 1));
  const afterDays = source.match(/через\s+(\d{1,2})\s+(?:дн|день|дня|дней)/);
  if (afterDays) return dateKey(addDays(now, Math.min(90, Number(afterDays[1]))));
  const iso = source.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const short = source.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}))?\b/);
  if (short) {
    const year = Number(short[3]) || now.getUTCFullYear();
    const candidate = new Date(Date.UTC(year, Number(short[2]) - 1, Number(short[1]), 12));
    if (!short[3] && candidate < addDays(now, -1)) candidate.setUTCFullYear(year + 1);
    return dateKey(candidate);
  }
  const weekdays = new Map([
    ['воскресенье', 0],
    ['понедельник', 1],
    ['вторник', 2],
    ['среду', 3],
    ['четверг', 4],
    ['пятницу', 5],
    ['субботу', 6],
  ]);
  for (const [word, weekday] of weekdays) {
    if (!source.includes(word)) continue;
    let delta = (weekday - now.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    return dateKey(addDays(now, delta));
  }
  return dateKey(addDays(now, 1));
};

const taskPriorityFromText = (text) => {
  const source = clean(text, 2000).toLocaleLowerCase('ru');
  if (/\b(авария|критично|критическая|немедленно)\b/.test(source)) return 'critical';
  if (/\b(срочно|важно|высокий приоритет)\b/.test(source)) return 'high';
  if (/\b(не срочно|низкий приоритет)\b/.test(source)) return 'low';
  return 'normal';
};

const listProjectSnapshots = async (db) => {
  await ensureSchema(db);
  const result = await db.prepare(`
    SELECT project_id, state_json, revision, updated_at
    FROM project_state
    WHERE substr(project_id, 1, 2) != '__'
    ORDER BY updated_at DESC
    LIMIT 100
  `).all();
  return (result?.results ?? []).flatMap((row) => {
    try {
      const state = JSON.parse(row.state_json);
      return state?.project?.id && state.project.status !== 'workspace'
        ? [{ projectId: row.project_id, state, revision: Number(row.revision), updatedAt: row.updated_at }]
        : [];
    } catch {
      return [];
    }
  });
};

const mutateProjectFromTelegram = async (env, projectId, actor, role, action, summary, mutate) => {
  await ensureSchema(env.DB);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await readSnapshot(env.DB, projectId);
    if (!snapshot) throw new Error('project_not_found');
    const previous = snapshot.state;
    const next = JSON.parse(JSON.stringify(previous));
    const resultState = await mutate(next);
    if (resultState === TELEGRAM_MUTATION_NOOP) {
      return { previous, state: previous, revision: snapshot.revision, updatedAt: snapshot.updatedAt, changed: false };
    }
    const state = resultState ?? next;
    const stateJson = JSON.stringify(state);
    const stateBytes = new TextEncoder().encode(stateJson).byteLength;
    if (stateBytes > MAX_STATE_BYTES) throw new Error('payload_too_large');
    const now = new Date().toISOString();
    const nextRevision = snapshot.revision + 1;
    const result = await env.DB.prepare(`
      UPDATE project_state
      SET state_json = ?, revision = ?, updated_at = ?, updated_by = ?, updated_role = ?
      WHERE project_id = ? AND revision = ?
    `).bind(stateJson, nextRevision, now, actor, role, projectId, snapshot.revision).run();
    if (changes(result) !== 1) continue;
    try {
      await env.DB.prepare(`
        INSERT INTO audit_log (
          id, project_id, revision, created_at, actor, role, action, summary, state_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), projectId, nextRevision, now, actor, role, action, summary, stateBytes).run();
    } catch {
      // Основное состояние уже сохранено.
    }
    return { previous, state, revision: nextRevision, updatedAt: now, changed: true };
  }
  throw new Error('revision_conflict');
};

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

const TELEGRAM_COMMAND_NAMES = [
  'task', 'tasks', 'stages', 'done', 'finance', 'expense', 'status',
  'note', 'report', 'doc', 'camera', 'project', 'help',
];

const telegramCommandDistance = (left, right) => {
  const a = clean(left, 40).toLocaleLowerCase('en-US');
  const b = clean(right, 40).toLocaleLowerCase('en-US');
  const matrix = Array.from({ length: a.length + 1 }, (_, row) => (
    Array.from({ length: b.length + 1 }, (_, column) => row ? (column ? 0 : row) : column)
  ));
  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost,
      );
      if (
        row > 1
        && column > 1
        && a[row - 1] === b[column - 2]
        && a[row - 2] === b[column - 1]
      ) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
};

const telegramCommandSuggestion = (value) => {
  const name = clean(value, 40).toLocaleLowerCase('en-US');
  if (!name) return '';
  const ranked = TELEGRAM_COMMAND_NAMES
    .map((candidate) => ({ candidate, distance: telegramCommandDistance(name, candidate) }))
    .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate));
  return ranked[0]?.distance <= 1 ? ranked[0].candidate : '';
};

export const commandFromText = (value) => {
  const text = clean(value, 3000);
  const match = text.match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  return match ? {
    name: match[1].toLocaleLowerCase('en-US'),
    target: clean(match[2], 120).toLocaleLowerCase('en-US'),
    body: clean(match[3], 2400),
  } : null;
};

export const telegramCommandTargetsBot = (command, botUsername) => !command?.target
  || command.target === clean(botUsername, 120).replace(/^@/u, '').toLocaleLowerCase('en-US');

const taskAssigneeFromText = (state, text) => {
  const source = clean(text, 2400).toLocaleLowerCase('ru');
  const users = (state.settings?.users ?? []).filter((user) => user.status !== 'disabled' && user.role !== 'client');
  return users.find((user) => {
    const telegram = clean(user.telegram, 120).replace(/^@/, '').toLocaleLowerCase('en-US');
    const firstName = clean(user.name, 120).split(/\s+/)[0]?.toLocaleLowerCase('ru');
    return (telegram && source.includes(`@${telegram}`)) || (firstName && new RegExp(`(^|\\s)${firstName}(\\s|$)`, 'iu').test(source));
  }) ?? null;
};

const renderTaskDraft = (draft, state) => {
  const payload = draft.payload;
  const assignee = (state.settings?.users ?? []).find((user) => user.id === payload.assigneeId);
  const priorityLabels = { low: 'низкий', normal: 'обычный', high: 'высокий', critical: 'критический' };
  const users = (state.settings?.users ?? []).filter((user) => user.status !== 'disabled' && user.role !== 'client').slice(0, 8);
  const rows = [];
  for (let index = 0; index < users.length; index += 2) {
    rows.push(users.slice(index, index + 2).map((user) => ({
      text: `${user.id === payload.assigneeId ? '✓ ' : ''}${user.name}`,
      callback_data: `ta|${draft.id}|${users.indexOf(user)}`,
    })));
  }
  rows.push([
    { text: payload.dueOffset === 0 ? '✓ Сегодня' : 'Сегодня', callback_data: `td|${draft.id}|0` },
    { text: payload.dueOffset === 1 ? '✓ Завтра' : 'Завтра', callback_data: `td|${draft.id}|1` },
    { text: payload.dueOffset === 3 ? '✓ +3 дня' : '+3 дня', callback_data: `td|${draft.id}|3` },
    { text: payload.dueOffset === 7 ? '✓ +7 дней' : '+7 дней', callback_data: `td|${draft.id}|7` },
  ]);
  rows.push([
    { text: 'Создать задачу', callback_data: `tc|${draft.id}` },
    { text: 'Отмена', callback_data: `tx|${draft.id}` },
  ]);
  return {
    text: [
      'Черновик задачи',
      '',
      `Проект: ${payload.projectName}`,
      `Что: ${payload.title}`,
      `Ответственный: ${assignee?.name ?? 'выберите ниже'}`,
      `Срок: ${payload.dueDate}`,
      `Приоритет: ${priorityLabels[payload.priority] ?? payload.priority}`,
      '',
      'ИКИОМА ОС ничего не сохранит, пока вы не нажмёте «Создать задачу».',
    ].join('\n'),
    replyMarkup: { inline_keyboard: rows },
    users,
  };
};

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

const renderFileDraft = (draft) => {
  const payload = draft.payload;
  const isDocument = draft.kind === 'document';
  return {
    text: [
      isDocument ? 'Черновик документа' : 'Черновик записи в дневник объекта',
      '',
      `Проект: ${payload.projectName}`,
      `Файл: ${payload.fileName}`,
      isDocument ? `Категория: ${payload.typeLabel}` : `Комментарий: ${payload.note || 'без комментария'}`,
      '',
      'Файл будет перенесён в защищённое хранилище ИКИОМА ОС только после подтверждения.',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [[
        { text: isDocument ? 'Сохранить документ' : 'Добавить в дневник', callback_data: `fc|${draft.id}` },
        { text: 'Отмена', callback_data: `fx|${draft.id}` },
      ]],
    },
  };
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

const telegramHelp = (role = 'foreman') => [
  'ИКИОМА ОС · что понимает бот',
  '',
  '🟢 ТОЛЬКО ПОКАЗЫВАЕТ — в ОС ничего не меняет',
  '/status — сводка по объекту',
  '/tasks — открытые задачи',
  '/stages — этапы и сроки',
  '/done — выполненные задачи',
  role === 'management' ? '/finance — расходы, доходы и баланс' : null,
  '/camera — камера объекта',
  '/project — выбранный объект',
  '',
  '🟡 ЗАПИШЕТ ТОЛЬКО ПОСЛЕ ВАШЕГО ПОДТВЕРЖДЕНИЯ',
  role === 'management' ? '/task текст — черновик новой задачи' : null,
  role === 'management' ? '/expense сумма описание — черновик расхода' : null,
  '/note текст — черновик записи в дневник объекта',
  'Фото или голос + подпись /report — черновик фотоотчёта',
  'Документ + подпись /doc — черновик документа',
  '',
  '⚪ НЕ ЗАПИСЫВАЕТ',
  '• обычную переписку в общем чате;',
  '• сообщения непривязанных участников;',
  '• текст, который бот не смог понять.',
  '',
  'В общем чате обращайтесь к @ikioma_bot, отвечайте на сообщение бота или используйте команду. В личном чате можно писать без упоминания.',
  'Если свободная фраза с @ikioma_bot не получает ответа, в Telegram включён Privacy Mode: используйте /expense@ikioma_bot, /note@ikioma_bot, /task@ikioma_bot или отключите Privacy Mode через @BotFather.',
  'Если команда написана с ошибкой или смысл неясен, бот ответит «ничего не записано» и предложит подсказку. Молчание никогда не означает сохранение.',
  '',
  '/help — показать эту памятку',
].filter(Boolean).join('\n');

const taskStatusLabel = (status) => ({
  todo: 'к выполнению',
  in_progress: 'в работе',
  waiting: 'ожидает',
  review: 'на проверке',
  done: 'выполнено',
  canceled: 'отменено',
}[status] ?? status);

export const telegramTaskActionKey = (projectId, taskId) => {
  let hash = 0xcbf29ce484222325n;
  for (const character of `${clean(projectId, 100)}\u0000${clean(taskId, 160)}`) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

const taskActionMarkup = (projectId, taskId, role) => {
  const actionKey = telegramTaskActionKey(projectId, taskId);
  return ({
  inline_keyboard: role === 'management'
    ? [[
      { text: 'В работу', callback_data: `ts|${actionKey}|ip` },
      { text: 'Выполнено', callback_data: `ts|${actionKey}|done` },
      { text: 'Есть проблема', callback_data: `ts|${actionKey}|wait` },
    ]]
    : [[
      { text: 'Принял', callback_data: `ts|${actionKey}|ip` },
      { text: 'На проверку', callback_data: `ts|${actionKey}|review` },
      { text: 'Есть проблема', callback_data: `ts|${actionKey}|wait` },
    ]],
  });
};

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

const handleTelegramLink = async (request, env) => {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'telegram_not_configured' }, 409);
  let payload;
  try { payload = await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES); } catch (error) {
    return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400);
  }
  const projectId = clean(payload?.projectId, 100);
  const userId = clean(payload?.userId, 100);
  if (!validProjectId(projectId) || !userId) return json({ ok: false, error: 'invalid_link_target' }, 422);

  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity || identity.role !== 'management') return json({ ok: false, error: 'project_access_denied' }, 403);
    const user = (snapshot.state.settings?.users ?? []).find((item) => clean(item.id, 100) === userId && item.status !== 'disabled');
    if (!user) return json({ ok: false, error: 'user_not_found' }, 404);
    const username = await telegramBotUsername(env);
    if (!username) return json({ ok: false, error: 'telegram_bot_unavailable' }, 502);

    const code = `${shortId()}${shortId()}`;
    const codeHash = await sha256(code);
    const now = new Date();
    const expiresAt = addDays(now, 1).toISOString();
    await env.DB.prepare(`
      INSERT INTO telegram_link_codes (
        code_hash, project_id, system_user_id, created_at, expires_at, used_at
      ) VALUES (?, ?, ?, ?, ?, NULL)
    `).bind(codeHash, projectId, userId, now.toISOString(), expiresAt).run();
    return json({
      ok: true,
      url: `https://t.me/${username}?start=${code}`,
      expiresAt,
      user: { id: user.id, name: user.name },
    }, 201);
  } catch {
    return json({ ok: false, error: 'telegram_link_failed' }, 500);
  }
};

const bindTelegramUser = async (message, code, env) => {
  const chat = message?.chat;
  const from = message?.from;
  if (chat?.type !== 'private' || !from?.id) {
    if (chat?.id) await telegramSend(env.TELEGRAM_BOT_TOKEN, chat.id, 'Персональную привязку нужно открыть в личном чате с ботом.');
    return;
  }
  const codeHash = await sha256(code);
  const row = await env.DB.prepare(`
    SELECT code_hash, project_id, system_user_id, expires_at, used_at
    FROM telegram_link_codes
    WHERE code_hash = ?
  `).bind(codeHash).first();
  if (!row || row.used_at || row.expires_at < new Date().toISOString()) {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, chat.id, 'Ссылка недействительна или уже использована. Попросите руководителя выпустить новую в ИКИОМА ОС.');
    return;
  }
  const snapshot = await readSnapshot(env.DB, row.project_id);
  const user = (snapshot?.state?.settings?.users ?? []).find((item) => item.id === row.system_user_id && item.status !== 'disabled');
  if (!snapshot || !user) {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, chat.id, 'Участник или проект больше не доступны. Попросите руководителя проверить настройки.');
    return;
  }

  const now = new Date().toISOString();
  const linkClaim = await env.DB.prepare(`
    UPDATE telegram_link_codes
    SET used_at = ?
    WHERE code_hash = ? AND used_at IS NULL AND expires_at >= ?
  `).bind(now, codeHash, now).run();
  if (changes(linkClaim) !== 1) {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, chat.id, 'Ссылка уже использована другим подключением. Попросите руководителя выпустить новую в ИКИОМА ОС.');
    return;
  }
  const telegramUserId = String(from.id);
  const privateChatId = String(chat.id);
  await env.DB.prepare(`
    INSERT INTO telegram_bindings (
      telegram_user_id, project_id, system_user_id, private_chat_id,
      username, display_name, role, bound_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_user_id, project_id) DO UPDATE SET
      system_user_id = excluded.system_user_id,
      private_chat_id = excluded.private_chat_id,
      username = excluded.username,
      display_name = excluded.display_name,
      role = excluded.role,
      updated_at = excluded.updated_at
  `).bind(
    telegramUserId,
    row.project_id,
    row.system_user_id,
    privateChatId,
    clean(from.username, 120),
    telegramDisplayName(from),
    user.role,
    now,
    now,
  ).run();
  await saveTelegramProjectSelection(env.DB, telegramUserId, privateChatId, row.project_id);

  await mutateProjectFromTelegram(
    env,
    row.project_id,
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
      state.activity = [{
        id: `activity-${crypto.randomUUID()}`,
        timestamp: now,
        actor: user.name,
        text: 'Подключил личный Telegram к ИКИОМА ОС',
        tone: 'neutral',
      }, ...(state.activity ?? [])];
    },
  );
  await telegramSend(
    env.TELEGRAM_BOT_TOKEN,
    privateChatId,
    `Готово, ${user.name}. Вы подключены к проекту «${snapshot.state.project?.name ?? snapshot.state.project?.code}».\n\n${telegramHelp(user.role)}`,
  );
  await reviveTelegramOutbox(env.DB, privateChatId);
};

const projectForBinding = async (env, binding) => {
  const snapshot = await readSnapshot(env.DB, binding.project_id);
  if (!snapshot) throw new Error('project_not_found');
  const user = (snapshot.state.settings?.users ?? []).find((item) => item.id === binding.system_user_id);
  if (!user || user.status === 'disabled') throw new Error('access_disabled');
  return { snapshot, user };
};

const telegramTaskDraft = async (message, binding, body, env) => {
  const { snapshot, user } = await projectForBinding(env, binding);
  if (user.role !== 'management') {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Ставить задачи через Telegram может роль «Управление». Свои задачи доступны по /tasks.');
    return;
  }
  if (!clean(body, 2400)) {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Напишите после команды саму задачу. Например:\n/task Илья, проверить геометрию свай завтра срочно');
    return;
  }
  const assignee = taskAssigneeFromText(snapshot.state, body)
    ?? (snapshot.state.settings?.users ?? []).find((item) => item.id === binding.system_user_id)
    ?? (snapshot.state.settings?.users ?? []).find((item) => item.role !== 'client' && item.status !== 'disabled');
  const dueDate = parseTaskDate(body);
  const dueOffset = Math.max(0, Math.round((new Date(`${dueDate}T12:00:00Z`).getTime() - new Date(`${dateKey()}T12:00:00Z`).getTime()) / 86_400_000));
  const draft = await createTelegramDraft(env.DB, String(message.from.id), String(message.chat.id), binding.project_id, 'task', {
    title: clean(body, 500),
    projectName: snapshot.state.project?.name ?? snapshot.state.project?.code ?? binding.project_id,
    assigneeId: assignee?.id ?? '',
    dueDate,
    dueOffset: [0, 1, 3, 7].includes(dueOffset) ? dueOffset : -1,
    priority: taskPriorityFromText(body),
  }, String(message.message_id ?? ''));
  const card = renderTaskDraft(draft, snapshot.state);
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, card.text, { reply_markup: card.replyMarkup });
};

const telegramTasks = async (message, binding, env) => {
  const { snapshot, user } = await projectForBinding(env, binding);
  const tasks = (snapshot.state.tasks ?? [])
    .filter((item) => !['done', 'canceled'].includes(item.status))
    .filter((item) => user.role === 'management' || item.assigneeId === user.id)
    .sort((a, b) => clean(a.dueDate, 20).localeCompare(clean(b.dueDate, 20)))
    .slice(0, 10);
  const title = user.role === 'management' ? 'Открытые задачи проекта' : 'Ваши открытые задачи';
  const text = tasks.length
    ? `${title} · ${snapshot.state.project?.code ?? ''}\n\n${tasks.map((item) => `• ${item.dueDate} · ${taskStatusLabel(item.status)}\n  ${item.title}${user.role === 'management' ? ` — ${item.assigneeName}` : ''}\n  ${deepLink(telegramOrigin(env), binding.project_id, 'tasks', item.id)}`).join('\n\n')}`
    : `${title}: сейчас ничего открытого.`;
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, text);
};

const telegramStages = async (message, binding, env) => {
  const { snapshot } = await projectForBinding(env, binding);
  const stages = (snapshot.state.stages ?? []).slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  const labels = { not_ready: 'ещё не готов', ready: 'готов к запуску', in_progress: 'в работе', blocked: 'заблокирован', awaiting_inspection: 'на проверке', accepted: 'принят', rework: 'доработка' };
  const text = stages.length
    ? `Этапы · ${snapshot.state.project?.code ?? ''}\n\n${stages.map((item) => `• ${item.name} — ${labels[item.status] ?? item.status}\n  срок: ${item.forecastEnd ?? item.planEnd ?? 'не указан'}`).join('\n\n')}`
    : 'Этапы проекта пока не созданы.';
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, text);
};

const telegramCompletedTasks = async (message, binding, env) => {
  const { snapshot, user } = await projectForBinding(env, binding);
  const tasks = (snapshot.state.tasks ?? [])
    .filter((item) => item.status === 'done')
    .filter((item) => user.role === 'management' || item.assigneeId === user.id)
    .sort((a, b) => clean(b.updatedAt ?? b.createdAt, 40).localeCompare(clean(a.updatedAt ?? a.createdAt, 40)))
    .slice(0, 10);
  const text = tasks.length
    ? `Последние выполненные задачи · ${snapshot.state.project?.code ?? ''}\n\n${tasks.map((item) => `• ${item.title}\n  ${item.assigneeName} · ${new Date(item.updatedAt ?? item.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`).join('\n\n')}`
    : 'Выполненных задач пока нет.';
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, text);
};

const telegramFinance = async (message, binding, env) => {
  const { snapshot, user } = await projectForBinding(env, binding);
  if (user.role !== 'management') {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Финансовая сводка доступна только роли «Управление».');
    return;
  }
  const entries = snapshot.state.financeEntries ?? [];
  const expenses = entries.filter((item) => item.kind === 'expense');
  const incomes = entries.filter((item) => item.kind === 'income');
  const committed = expenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const paid = expenses.reduce((sum, item) => sum + (Number(item.paidAmount) || 0), 0);
  const expectedIncome = incomes.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const received = incomes.reduce((sum, item) => sum + (Number(item.paidAmount) || 0), 0);
  const money = (value) => `${Math.round(value).toLocaleString('ru-RU')} ₽`;
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
    `Финансы · ${snapshot.state.project?.code ?? ''}`,
    '',
    `Расходы: обязательства ${money(committed)} · оплачено ${money(paid)}`,
    `Доходы: ожидается ${money(expectedIncome)} · получено ${money(received)}`,
    `Денежный баланс: ${money(received - paid)}`,
    '',
    deepLink(telegramOrigin(env), binding.project_id, 'finance'),
  ].join('\n'));
};

const expenseSelectionFromDescription = (options, description) => {
  const source = clean(description, 500).toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const matched = options.find((item) => {
    const name = clean(item.name, 200).toLocaleLowerCase('ru').replace(/ё/g, 'е');
    return name.length >= 4 && source.includes(name);
  });
  return matched?.id ?? (options.length === 1 ? options[0].id : '');
};

const renderExpenseDraft = (draft) => {
  const payload = draft.payload;
  const budgetLine = payload.budgetLines?.find((item) => item.id === payload.budgetLineId);
  const stage = payload.stages?.find((item) => item.id === payload.stageId);
  const counterparty = payload.counterparties?.find((item) => item.id === payload.counterpartyId);
  const rows = [];
  for (let index = 0; index < (payload.budgetLines ?? []).length; index += 1) {
    const item = payload.budgetLines[index];
    rows.push([{ text: `${item.id === payload.budgetLineId ? '✓ ' : ''}Статья: ${item.name}`, callback_data: `eb|${draft.id}|${index}` }]);
  }
  for (let index = 0; index < (payload.counterparties ?? []).length; index += 2) {
    rows.push(payload.counterparties.slice(index, index + 2).map((item) => ({
      text: `${item.id === payload.counterpartyId ? '✓ ' : ''}${item.name}`,
      callback_data: `ec|${draft.id}|${payload.counterparties.indexOf(item)}`,
    })));
  }
  const allowedStages = (payload.stages ?? []).filter((item) => budgetLine?.stageIds?.includes(item.id));
  if (allowedStages.length > 1) {
    for (let index = 0; index < allowedStages.length; index += 2) {
      rows.push(allowedStages.slice(index, index + 2).map((item) => ({
        text: `${item.id === payload.stageId ? '✓ ' : ''}Этап: ${item.name}`,
        callback_data: `es|${draft.id}|${payload.stages.indexOf(item)}`,
      })));
    }
  }
  rows.push([
    { text: 'Сохранить расход', callback_data: `xc|${draft.id}` },
    { text: 'Отмена', callback_data: `xx|${draft.id}` },
  ]);
  return {
    text: [
      'Черновик расхода',
      '',
      `Проект: ${payload.projectName}`,
      `Сумма: ${Number(payload.amount).toLocaleString('ru-RU')} ₽`,
      `Основание: ${payload.description}`,
      `Статья: ${budgetLine?.name ?? 'выберите ниже'}`,
      `Этап: ${stage?.name ?? (budgetLine ? 'выберите ниже' : 'сначала выберите статью')}`,
      `Контрагент: ${counterparty?.name ?? (payload.counterparties?.length ? 'выберите ниже' : 'сначала добавьте в ИКИОМА ОС')}`,
      '',
      'Это обязательство. Оплата и приёмка не фиксируются автоматически.',
      'В ИКИОМА ОС ничего не изменится, пока вы не нажмёте «Сохранить расход».',
    ].join('\n'),
    replyMarkup: { inline_keyboard: rows },
  };
};

const telegramExpenseDraft = async (message, binding, body, env) => {
  const { snapshot, user } = await projectForBinding(env, binding);
  if (user.role !== 'management') {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Добавлять расходы через Telegram может только роль «Управление».');
    return;
  }
  const expense = parseTelegramExpense(body);
  if (!expense) {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
      'Не удалось определить сумму и основание расхода.',
      'Ничего не записано в ИКИОМА ОС.',
      '',
      'Пример: /expense 6000 пробное бурение',
    ].join('\n'));
    return;
  }
  const budgetLines = (snapshot.state.budgetLines ?? []).slice(0, 12).map((item) => ({
    id: item.id,
    name: item.name,
    stageIds: item.stageIds ?? [],
  }));
  const stages = (snapshot.state.stages ?? []).map((item) => ({ id: item.id, name: item.name }));
  const counterparties = (snapshot.state.counterparties ?? [])
    .filter((item) => item.status !== 'blocked')
    .slice(0, 12)
    .map((item) => ({ id: item.id, name: item.name }));
  const budgetLineId = expenseSelectionFromDescription(budgetLines, expense.description);
  const selectedBudgetLine = budgetLines.find((item) => item.id === budgetLineId);
  const draft = await createTelegramDraft(env.DB, String(message.from.id), String(message.chat.id), binding.project_id, 'expense', {
    ...expense,
    projectName: snapshot.state.project?.name ?? snapshot.state.project?.code ?? binding.project_id,
    budgetLines,
    stages,
    counterparties,
    budgetLineId,
    stageId: selectedBudgetLine?.stageIds?.length === 1 ? selectedBudgetLine.stageIds[0] : '',
    counterpartyId: expenseSelectionFromDescription(counterparties, expense.description),
  }, String(message.message_id ?? ''));
  const card = renderExpenseDraft(draft);
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, card.text, { reply_markup: card.replyMarkup });
};

export const parseTelegramExpense = (value) => {
  const source = clean(value, 2400).replace(/\u00a0/gu, ' ').trim();
  const amountMatch = source.match(/\d[\d ]*(?:[.,]\d{1,2})?/u);
  if (!amountMatch || amountMatch.index === undefined) return null;
  const amount = Number(amountMatch[0].replace(/\s+/gu, '').replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return null;
  const before = source.slice(0, amountMatch.index);
  const after = source.slice(amountMatch.index + amountMatch[0].length)
    .replace(/^\s*(?:₽|руб(?:\.?|ля|лей)?|р\.)\s*/iu, ' ');
  const description = clean(`${before} ${after}`.replace(/^\s*(?:на|за)\s+/iu, '').replace(/^[\s:—-]+|[\s:—-]+$/gu, ''), 500);
  return description ? { amount, description } : null;
};

export const naturalTelegramCommand = (value) => {
  const source = clean(value, 3000).trim();
  const text = source.toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const writeIntent = source.match(/^(?:запиши(?:\s+в\s+ос)?|зафиксируй|добавь)\s+([а-яё]+)(?=\s|[:—-]|$)\s*[:—-]?\s*([\s\S]*)$/iu);
  if (writeIntent) {
    const token = writeIntent[1].toLocaleLowerCase('ru').replace(/ё/g, 'е');
    const expenseWords = ['расход', 'расхода', 'расходу', 'расходы', 'расходов', 'затрата', 'затрату', 'затраты', 'трата', 'трату', 'траты', 'оплата', 'оплату'];
    const likelyExpense = expenseWords.some((word) => telegramCommandDistance(token, word) <= 1);
    if (likelyExpense) return { name: 'expense', body: clean(writeIntent[2], 2400) };
  }
  const note = source.match(/^(?:запомни|зафиксируй|запиши(?:\s+в\s+ос)?|добавь\s+заметку)\s*[:—-]?\s*([\s\S]+)$/iu);
  if (note?.[1]) return { name: 'note', body: clean(note[1], 2400) };
  if (/(этап|этапы|стадии|ход работ)/u.test(text)) return { name: 'stages', body: '' };
  if (/(выполненн|завершенн|сделанн).{0,20}(задач|работ)|что (сделано|выполнено)/u.test(text)) return { name: 'done', body: '' };
  if (/(расход|доход|финанс|деньг|оплачен|получен)/u.test(text)) return { name: 'finance', body: '' };
  if (/(задач|дела).{0,20}(открыт|текущ|актив)|что делать/u.test(text)) return { name: 'tasks', body: '' };
  if (/(статус|состояние|что на объекте)/u.test(text)) return { name: 'status', body: '' };
  return null;
};

const naturalTelegramIntent = (value) => naturalTelegramCommand(value)?.name ?? '';

const telegramProjectStatus = async (message, binding, env) => {
  const { snapshot } = await projectForBinding(env, binding);
  const state = snapshot.state;
  const today = dateKey();
  const activeStages = (state.stages ?? []).filter((item) => ['in_progress', 'blocked', 'awaiting_inspection', 'rework'].includes(item.status));
  const openTasks = (state.tasks ?? []).filter((item) => !['done', 'canceled'].includes(item.status));
  const overdue = openTasks.filter((item) => clean(item.dueDate, 20) < today);
  const riskySupply = (state.procurement ?? []).filter((item) => item.risk || ['need', 'rfq'].includes(item.status));
  const accepted = (state.financeEntries ?? []).reduce((sum, item) => sum + (Number(item.acceptedAmount) || 0), 0);
  const paid = (state.financeEntries ?? []).reduce((sum, item) => sum + (Number(item.paidAmount) || 0), 0);
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
    `Статус · ${state.project?.name ?? state.project?.code}`,
    '',
    `Работы сейчас: ${activeStages.length ? activeStages.map((item) => item.name).join(', ') : 'активных этапов нет'}`,
    `Задачи: ${openTasks.length} открыто · ${overdue.length} просрочено`,
    `Снабжение: ${riskySupply.length} требуют внимания`,
    `Принято / оплачено: ${accepted.toLocaleString('ru-RU')} ₽ / ${paid.toLocaleString('ru-RU')} ₽`,
    `Прогноз сдачи: ${state.project?.forecastDate ?? 'не указан'}`,
    '',
    deepLink(telegramOrigin(env), binding.project_id, 'overview'),
  ].join('\n'));
};

const telegramCamera = async (message, binding, env) => {
  const { snapshot } = await projectForBinding(env, binding);
  const caption = `Камера · ${snapshot.state.project?.name ?? snapshot.state.project?.code}\n${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`;
  if (env.CAMERA_SNAPSHOT_URL) {
    const response = await telegramSendPhoto(env.TELEGRAM_BOT_TOKEN, message.chat.id, env.CAMERA_SNAPSHOT_URL, caption);
    if (response.ok) return;
  }
  if (env.CAMERA_VIEW_URL) {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, `${caption}\n\nПрямой эфир доступен по кнопке:`, {
      reply_markup: { inline_keyboard: [[{ text: 'Открыть камеру', url: deepLink(telegramOrigin(env), binding.project_id, 'client', 'camera') }]] },
    });
    return;
  }
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Камера ещё не установлена. Команда уже готова и заработает после подключения оборудования.');
};

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

const telegramNoteDraft = async (message, binding, body, env) => {
  const { snapshot, user } = await projectForBinding(env, binding);
  const note = clean(body, 2400);
  if (!note) {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Напишите после команды, что нужно запомнить. Например:\n/note Панели привезут в пятницу после 14:00');
    return;
  }
  const draft = await createTelegramDraft(
    env.DB,
    String(message.from.id),
    String(message.chat.id),
    binding.project_id,
    'note',
    {
      note,
      telegramMessageId: String(message.message_id ?? ''),
    },
    String(message.message_id ?? ''),
  );
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
    'Черновик записи в дневник объекта',
    '',
    note,
    '',
    `Проект: ${snapshot.state.project?.name ?? snapshot.state.project?.code}`,
    `Автор: ${user.name}`,
    '',
    'Пока вы не нажмёте «Сохранить запись», в ИКИОМА ОС ничего не изменится.',
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Сохранить запись', callback_data: `nc|${draft.id}` },
        { text: 'Отмена', callback_data: `nx|${draft.id}` },
      ]],
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
  if (command.name === 'task') return telegramTaskDraft(message, binding, command.body, env);
  if (command.name === 'tasks') return telegramTasks(message, binding, env);
  if (command.name === 'stages') return telegramStages(message, binding, env);
  if (command.name === 'done') return telegramCompletedTasks(message, binding, env);
  if (command.name === 'finance') return telegramFinance(message, binding, env);
  if (command.name === 'expense') return telegramExpenseDraft(message, binding, command.body, env);
  if (command.name === 'status') return telegramProjectStatus(message, binding, env);
  if (command.name === 'note') return telegramNoteDraft(message, binding, command.body, env);
  if (command.name === 'camera') return telegramCamera(message, binding, env);
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

const handleTelegramUpdate = async (request, env, context) => {
  const suppliedSecret = clean(request.headers.get('x-telegram-bot-api-secret-token'), 256);
  const expectedSecret = clean(env.TELEGRAM_WEBHOOK_SECRET, 256);
  if (!expectedSecret || suppliedSecret !== expectedSecret) return json({ ok: false, error: 'webhook_authorization_required' }, 403);
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'telegram_not_configured' }, 409);
  let update;
  try { update = await readJsonBodyLimited(request, MAX_TELEGRAM_UPDATE_BYTES); } catch (error) {
    return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400);
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

const buildNotificationPlan = async (previous, next, env, actor, origin, summary, eventKey = '', recoveryEvents = []) => {
  let events = notificationEvents(previous, next);
  if (!events.length && Array.isArray(recoveryEvents) && recoveryEvents.length) events = recoveryEvents.slice(0, 8);
  const channels = next.settings?.notifications?.channels ?? {};
  const allActivity = next.settings?.notifications?.events?.projectActivity !== false;
  if (!events.length && allActivity && clean(summary, 300)) events = [notificationEvent(clean(summary, 300), 'overview')];
  if (!events.length) return { channels, message: '', deliveries: [] };
  const lines = events.map((event) => `• ${event.text}\n  ${deepLink(origin, next.project.id, event.page, event.entityId)}`);
  const message = `ИКИОМА ОС · ${next.project?.code ?? 'проект'}\nИзменил: ${actor}\n\n${lines.join('\n')}`;
  const deliveryKey = clean(eventKey, 120) || clean(next.activity?.[0]?.id, 120) || crypto.randomUUID();
  const deliveries = [];
  const telegramConnection = channels.telegram && env.TELEGRAM_BOT_TOKEN
    ? await resolveTelegramConnection(env, { discover: false })
    : null;
  const commonChatId = clean(telegramConnection?.chat?.id, 120);
  if (channels.telegram && env.TELEGRAM_BOT_TOKEN && commonChatId) deliveries.push({
    chatId: commonChatId,
    text: message,
    options: {},
    stableId: `telegram-notification-${(await sha256(`${next.project.id}:${deliveryKey}:${commonChatId}`)).slice(0, 40)}`,
  });
  if (channels.telegram && env.TELEGRAM_BOT_TOKEN) {
    const users = new Map((next.settings?.users ?? []).map((user) => [clean(user.id, 100), user]));
    const directByChat = new Map();
    for (const event of events) {
      if (!event.recipientId) continue;
      const user = users.get(clean(event.recipientId, 100));
      let chatId = clean(user?.telegramChatId, 120);
      if (!chatId && env.DB && user?.id) {
        const binding = await env.DB.prepare(`
          SELECT private_chat_id
          FROM telegram_bindings
          WHERE project_id = ? AND system_user_id = ?
          ORDER BY updated_at DESC
          LIMIT 1
        `).bind(next.project.id, user.id).first();
        chatId = clean(binding?.private_chat_id, 120);
      }
      if (!chatId || user?.status === 'disabled') continue;
      const personalEvents = directByChat.get(chatId) ?? [];
      personalEvents.push({ ...event, role: user.role });
      directByChat.set(chatId, personalEvents);
    }
    for (const [chatId, personalEvents] of directByChat) {
      const personalText = `ИКИОМА ОС · ${next.project?.code ?? 'проект'}\nУведомление по вашим задачам\n\n${personalEvents.map((event) => `• ${event.text}\n  ${deepLink(origin, next.project.id, event.page, event.entityId)}`).join('\n')}`;
      const taskEvent = personalEvents.length === 1 && personalEvents[0].page === 'tasks' && personalEvents[0].entityId
        ? personalEvents[0]
        : null;
      deliveries.push({
        chatId,
        text: personalText,
        options: taskEvent ? { reply_markup: taskActionMarkup(next.project.id, taskEvent.entityId, taskEvent.role) } : {},
        stableId: `telegram-personal-${(await sha256(`${next.project.id}:${deliveryKey}:${chatId}`)).slice(0, 40)}`,
      });
    }
  }
  return { channels, message, deliveries };
};

const dispatchNotifications = async (previous, next, env, actor, origin, summary, eventKey = '', preparedPlan = null, recoveryEvents = []) => {
  const plan = preparedPlan ?? await buildNotificationPlan(previous, next, env, actor, origin, summary, eventKey, recoveryEvents);
  if (!plan.message) return;
  const durableTasks = plan.deliveries.map((delivery) => telegramDurableSend(
    env,
    delivery.chatId,
    delivery.text,
    delivery.options,
    delivery.stableId,
    false,
  ));
  const bestEffortTasks = [];
  const { channels, message } = plan;
  if (channels.email && env.RESEND_API_KEY && env.EMAIL_FROM) {
    const recipients = (next.settings?.users ?? []).filter((user) => user.status === 'active' && user.role === 'management' && /^\S+@\S+\.\S+$/.test(user.email)).map((user) => user.email);
    if (recipients.length) bestEffortTasks.push(fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients, subject: `ИКИОМА ОС: требуется внимание · ${next.project?.code ?? ''}`, text: message }) }));
  }
  await Promise.all(durableTasks);
  await Promise.allSettled(bestEffortTasks);
};

const handlePutState = async (request, env, context) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
  if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);

  let authorizedSnapshot;
  let authenticated;
  let authorizedIdentity;
  try {
    await ensureSchema(env.DB);
    authorizedSnapshot = await readSnapshot(env.DB, projectId);
    authenticated = authenticatedIdentity(request, env);
    authorizedIdentity = authorizedSnapshot
      ? projectIdentity(request, env, authorizedSnapshot.state)
      : authenticated?.isOwner ? { ...authenticated, id: 'owner', role: 'management', status: 'active' } : null;
    if (!authorizedIdentity) return json({ ok: false, error: 'project_access_denied' }, 403);
  } catch {
    return json({ ok: false, error: 'storage_error' }, 503);
  }

  let payload;
  try {
    payload = await readJsonBodyLimited(request, MAX_STATE_BYTES + MAX_JSON_BODY_BYTES);
  } catch (error) {
    return json(
      { ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' },
      error?.message === 'payload_too_large' ? 413 : 400,
    );
  }

  const payloadProjectId = clean(payload?.projectId, 100);
  const expectedRevision = Number(payload?.expectedRevision);
  const action = clean(payload?.action, 80) || 'project_update';
  const summary = clean(payload?.summary, 300) || 'Обновлены данные проекта';
  const incomingState = payload?.state;

  if (payloadProjectId !== projectId
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0
    || !incomingState
    || incomingState.version !== 1
    || incomingState.project?.id !== projectId) {
    return json({ ok: false, error: 'invalid_state' }, 422);
  }

  const now = new Date().toISOString();
  const nextRevision = expectedRevision + 1;

  try {
    const previousSnapshot = expectedRevision > 0 ? authorizedSnapshot : null;
    const identity = expectedRevision === 0
      ? authenticated?.isOwner ? { ...authenticated, id: 'owner', role: 'management', status: 'active' } : null
      : authorizedIdentity;
    if (!identity) return json({ ok: false, error: expectedRevision === 0 ? 'owner_required' : 'project_access_denied' }, 403);

    const actor = identity.name;
    const role = identity.role;
    const mergedState = mergeStateForRole(previousSnapshot?.state ?? null, incomingState, identity, {
      serverManagedRoster: env.AUTH_ROSTER_MODE === 'local_password',
    });
    const state = applyBattleAutomations(previousSnapshot?.state ?? null, mergedState, actor);
    let stateJson;
    try {
      stateJson = JSON.stringify(state);
    } catch {
      return json({ ok: false, error: 'invalid_state' }, 422);
    }
    const stateBytes = new TextEncoder().encode(stateJson).byteLength;
    if (stateBytes > MAX_STATE_BYTES) return json({ ok: false, error: 'payload_too_large' }, 413);

    const notificationPlan = await buildNotificationPlan(
      previousSnapshot?.state ?? null,
      state,
      env,
      actor,
      new URL(request.url).origin,
      summary,
      nextRevision,
    );
    const stateStatement = expectedRevision === 0
      ? env.DB.prepare(`
        INSERT OR IGNORE INTO project_state (
          project_id, state_json, revision, created_at, updated_at, updated_by, updated_role
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
      `).bind(projectId, stateJson, now, now, actor, role)
      : env.DB.prepare(`
        UPDATE project_state
        SET state_json = ?, revision = ?, updated_at = ?, updated_by = ?, updated_role = ?
        WHERE project_id = ? AND revision = ?
      `).bind(stateJson, nextRevision, now, actor, role, projectId, expectedRevision);
    const outboxStatements = notificationPlan.deliveries.map((delivery) => env.DB.prepare(`
      INSERT INTO telegram_outbox (
        id, chat_id, text, options_json, status, attempts, last_error, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, 'pending', 0, NULL, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM project_state
        WHERE project_id = ? AND revision = ? AND updated_at = ? AND updated_by = ?
          AND updated_role = ? AND state_json = ?
      )
      ON CONFLICT(id) DO NOTHING
    `).bind(
      delivery.stableId,
      String(delivery.chatId),
      delivery.text,
      JSON.stringify(delivery.options ?? {}),
      now,
      now,
      projectId,
      nextRevision,
      now,
      actor,
      role,
      stateJson,
    ));
    const batchResults = await env.DB.batch([stateStatement, ...outboxStatements]);
    const result = batchResults?.[0];

    if (changes(result) !== 1) {
      const current = await readSnapshot(env.DB, projectId);
      const currentIdentity = current ? projectIdentity(request, env, current.state) : null;
      const safeCurrent = current && currentIdentity
        ? { ...current, state: stateForRole(current.state, currentIdentity), updatedRole: currentIdentity.role }
        : null;
      return json({ ok: false, error: 'revision_conflict', current: safeCurrent }, 409);
    }

    try {
      await env.DB.prepare(`
        INSERT INTO audit_log (
          id, project_id, revision, created_at, actor, role, action, summary, state_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), projectId, nextRevision, now, actor, role, action, summary, stateBytes).run();
    } catch {
      // Состояние уже сохранено. Сбой журнала не должен заставлять клиента повторять запись.
    }

    // State and every required Telegram outbox row were committed in one DB
    // transaction. Delivery and best-effort email may continue after response.
    context.waitUntil(dispatchNotifications(
      previousSnapshot?.state ?? null,
      state,
      env,
      actor,
      new URL(request.url).origin,
      summary,
      nextRevision,
      notificationPlan,
    ).catch(() => null));

    return json({
      ok: true,
      snapshot: {
        projectId,
        revision: nextRevision,
        updatedAt: now,
        updatedBy: actor,
        updatedRole: role,
        notificationQueued: true,
        state: stateForRole(state, identity),
      },
    });
  } catch {
    return json({ ok: false, error: 'storage_error' }, 500);
  }
};

const handleAudit = async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  const projectId = clean(url.searchParams.get('projectId'), 100);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
  if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);

  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity || identity.role !== 'management') return json({ ok: false, error: 'project_access_denied' }, 403);
    const result = await env.DB.prepare(`
      SELECT id, revision, created_at, actor, role, action, summary, state_bytes
      FROM audit_log
      WHERE project_id = ?
      ORDER BY revision DESC
      LIMIT ?
    `).bind(projectId, limit).all();
    return json({ ok: true, events: result?.results ?? [] });
  } catch {
    return json({ ok: false, error: 'storage_error' }, 500);
  }
};

const handleProjects = async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  try {
    await ensureSchema(env.DB);
    const result = await env.DB.prepare(`
      SELECT project_id, state_json, revision, updated_at
      FROM project_state
      ORDER BY updated_at DESC
      LIMIT 100
    `).all();
    const projects = (result?.results ?? []).flatMap((row) => {
      try {
        const state = JSON.parse(row.state_json);
        const identity = projectIdentity(request, env, state);
        if (!identity) return [];
        const project = state?.project;
        if (!project?.id || String(project.id).startsWith('__')) return [];
        return [{
          id: project.id,
          code: clean(project.code, 40),
          name: clean(project.name, 120),
          model: clean(project.model, 120),
          area: Number(project.area) || 0,
          address: clean(project.address, 240),
          targetDate: clean(project.targetDate, 40),
          revision: Number(row.revision),
          updatedAt: row.updated_at,
          status: clean(project.status, 40),
        }];
      } catch {
        return [];
      }
    });
    const visibleProjects = projects.some((project) => project.status !== 'workspace')
      ? projects.filter((project) => project.status !== 'workspace')
      : projects;
    return json({
      ok: true,
      projects: visibleProjects.map(({ status: _status, ...project }) => project),
    });
  } catch {
    return json({ ok: false, error: 'storage_error' }, 500);
  }
};

const integrationStatus = async (env) => {
  const telegramConnection = await resolveTelegramConnection(env);
  const botUsername = clean(telegramConnection.bot?.username, 120);
  let telegramBoundUsers = 0;
  let telegramPendingMessages = 0;
  let telegramDeadMessages = 0;
  let telegramLastDeliveryError = '';
  if (env.DB) {
    try {
      await ensureSchema(env.DB);
      const [bindingRow, outboxRow, outboxErrorRow] = await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) AS count FROM telegram_bindings`).first(),
        env.DB.prepare(`
          SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead_count
          FROM telegram_outbox
          WHERE status != 'sent'
        `).first(),
        env.DB.prepare(`
          SELECT last_error
          FROM telegram_outbox
          WHERE status != 'sent' AND last_error IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1
        `).first(),
      ]);
      telegramBoundUsers = Number(bindingRow?.count) || 0;
      telegramPendingMessages = Number(outboxRow?.count) || 0;
      telegramDeadMessages = Number(outboxRow?.dead_count) || 0;
      telegramLastDeliveryError = clean(outboxErrorRow?.last_error, 300);
    } catch {
      telegramBoundUsers = 0;
      telegramPendingMessages = 0;
      telegramDeadMessages = 0;
      telegramLastDeliveryError = '';
    }
  }
  return {
    email: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    telegram: Boolean(telegramConnection.tokenConfigured && telegramConnection.chat?.id),
    telegramBot: Boolean(telegramConnection.tokenConfigured && telegramConnection.issue !== 'invalid_token'),
    telegramBotUsername: botUsername,
    telegramCommon: Boolean(telegramConnection.chat?.id),
    telegramCommonTitle: clean(telegramConnection.chat?.title, 160),
    telegramCandidates: telegramConnection.candidates ?? [],
    telegramIssue: clean(telegramConnection.issue, 80),
    telegramInbound: Boolean(env.TELEGRAM_WEBHOOK_URL && env.TELEGRAM_WEBHOOK_SECRET),
    telegramBoundUsers,
    telegramPendingMessages,
    telegramDeadMessages,
    telegramLastDeliveryError,
    camera: Boolean(env.CAMERA_VIEW_URL),
    websiteForm: true,
    publicWebsiteForm: true,
  };
};

const handleIntegrationStatus = async (request, env) => {
  const identity = authenticatedIdentity(request, env);
  if (!identity) return json({ ok: false, error: 'authentication_required' }, 401);
  const status = await integrationStatus(env);
  if (!identity.isOwner) status.telegramCandidates = [];
  return json({ ok: true, integrations: status });
};

const handleIntegrationTest = async (request, env) => {
  const identity = authenticatedIdentity(request, env);
  if (!identity?.isOwner) return json({ ok: false, error: 'owner_required' }, 403);
  let payload;
  try { payload = await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES); } catch (error) {
    return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400);
  }
  const channel = clean(payload?.channel, 30);
  const message = clean(payload?.message, 500) || 'Тестовое уведомление ИКИОМА ОС';
  const status = await integrationStatus(env);
  if (channel === 'email') {
    const to = clean(payload?.to, 240);
    if (!status.email) return json({ ok: false, error: 'email_not_configured' }, 409);
    if (!/^\S+@\S+\.\S+$/.test(to)) return json({ ok: false, error: 'invalid_recipient' }, 422);
    try {
      const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: 'ИКИОМА ОС: тест уведомлений', html: `<p>${message.replace(/[<>&]/g, '')}</p>` }) });
      if (!response.ok) return json({ ok: false, error: 'provider_error' }, 502);
      return json({ ok: true, channel: 'email' });
    } catch { return json({ ok: false, error: 'provider_unavailable' }, 502); }
  }
  if (channel === 'telegram') {
    if (!status.telegram) return json({ ok: false, error: status.telegramIssue || 'telegram_not_configured' }, 409);
    try {
      const connection = await resolveTelegramConnection(env, { discover: false });
      const response = await telegramSend(env.TELEGRAM_BOT_TOKEN, connection.chat?.id, message);
      if (!response.ok) return json({ ok: false, error: 'provider_error' }, 502);
      await reviveTelegramOutbox(env.DB, connection.chat?.id);
      await flushTelegramOutbox(env);
      return json({ ok: true, channel: 'telegram' });
    } catch { return json({ ok: false, error: 'provider_unavailable' }, 502); }
  }
  return json({ ok: false, error: 'unsupported_channel' }, 422);
};

const handleTelegramChatSelect = async (request, env) => {
  const identity = authenticatedIdentity(request, env);
  if (!identity?.isOwner) return json({ ok: false, error: 'owner_required' }, 403);
  if (!env.TELEGRAM_BOT_TOKEN || !env.DB) return json({ ok: false, error: 'telegram_not_configured' }, 409);

  let payload;
  try { payload = await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES); } catch (error) {
    return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400);
  }
  const chatId = clean(payload?.chatId, 120);
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

const sendTelegramFieldHeadquartersGuide = async (connection, env) => {
  const chatId = clean(connection?.chat?.id, 120);
  if (!chatId || !env.DB || !env.TELEGRAM_BOT_TOKEN) return { sent: false, issue: 'chat_missing' };
  await ensureSchema(env.DB);
  const messageKey = 'system:telegram-field-headquarters-guide-v1';
  const now = new Date().toISOString();
  const claim = await env.DB.prepare(`
    INSERT INTO telegram_updates (update_id, received_at, processed_at, status, error)
    VALUES (?, ?, NULL, 'processing', NULL)
    ON CONFLICT(update_id) DO NOTHING
  `).bind(messageKey, now).run();
  if (changes(claim) !== 1) {
    const existing = await env.DB.prepare(`
      SELECT status, received_at
      FROM telegram_updates
      WHERE update_id = ?
    `).bind(messageKey).first();
    if (existing?.status === 'done') {
      return { sent: false, ready: true, status: 'already_sent', issue: '' };
    }
    if (existing?.status === 'processing') {
      const claimedAt = Date.parse(clean(existing.received_at, 80));
      const stale = !Number.isFinite(claimedAt) || Date.now() - claimedAt > 120_000;
      if (!stale) return { sent: false, ready: false, status: 'processing', issue: '' };
      const staleClaim = await env.DB.prepare(`
        UPDATE telegram_updates
        SET received_at = ?, processed_at = NULL, status = 'processing', error = NULL
        WHERE update_id = ? AND status = 'processing' AND received_at = ?
      `).bind(now, messageKey, existing.received_at).run();
      if (changes(staleClaim) !== 1) {
        return { sent: false, ready: false, status: 'processing', issue: '' };
      }
    }
    if (existing?.status === 'error') {
      const retryClaim = await env.DB.prepare(`
        UPDATE telegram_updates
        SET received_at = ?, processed_at = NULL, status = 'processing', error = NULL
        WHERE update_id = ? AND status = 'error'
      `).bind(now, messageKey).run();
      if (changes(retryClaim) !== 1) {
        return { sent: false, ready: false, status: 'retry_conflict', issue: '' };
      }
    }
  }

  const guide = [
    '🏗 ИкиОМА · Telegram-полевой штаб запущен',
    '',
    'Теперь чат умеет не только получать уведомления, но и работать со ИКИОМА ОС.',
    '',
    '1. Подключите себя',
    'ИКИОМА ОС → Настройки → Доступы → значок ссылки рядом со своим именем. Откройте персональную ссылку и нажмите «Запустить». Без привязки бот не даст менять проект — случайные люди из чата командовать стройкой не смогут.',
    '',
    '2. Команды',
    '/task Илья, проверить геометрию свай завтра срочно — создать черновик задачи. Сохранится только после подтверждения.',
    '/tasks — открытые задачи: руководитель видит все, сотрудник только свои.',
    '/status — этапы, просрочки, снабжение и принятые/оплаченные суммы.',
    '/note текст — создать черновик записи в дневник; сохранится только после подтверждения.',
    '/camera — свежий кадр или ссылка на эфир после установки камеры.',
    '/project — выбрать объект, если их несколько.',
    '/help — короткая памятка.',
    '',
    '3. Фото и документы',
    '• Фото или голосовое сообщение с подписью /report — в полевой дневник объекта.',
    '• Договор, акт, счёт, УПД или накладная с подписью /doc — в документы проекта.',
    '• В личном чате с ботом файл можно отправить без команды.',
    '• Перед сохранением бот всегда показывает черновик и просит подтверждение.',
    '',
    '4. Задачи',
    'Исполнитель получает личное уведомление и может нажать «Принял», «На проверку» или «Есть проблема». Изменения проекта продолжают приходить в этот общий чат.',
    '',
    'Важно: обычная переписка общего чата не переносится в ОС. Бот обрабатывает команды, обращения с @ikioma_bot и ответы на его сообщения. Если смысл не распознан, бот прямо напишет, что ничего не сохранено.',
    'Камера пока не установлена, поэтому /camera честно сообщит, что оборудование ожидается. Голосовые отчёты сохраняются как аудио; автоматическую расшифровку подключим отдельным этапом.',
  ].join('\n');

  try {
    const response = await telegramSend(env.TELEGRAM_BOT_TOKEN, chatId, guide, {
      reply_markup: {
        inline_keyboard: [[{
          text: 'Открыть ИКИОМА ОС',
          url: telegramOrigin(env),
        }]],
      },
    });
    const body = await parseTelegramBody(response);
    if (!response.ok || !body?.ok) throw new Error('telegram_guide_rejected');
    await env.DB.prepare(`
      UPDATE telegram_updates
      SET status = 'done', processed_at = ?, error = NULL
      WHERE update_id = ?
    `).bind(new Date().toISOString(), messageKey).run();
    if (body.result?.message_id) {
      await telegramRequest(env.TELEGRAM_BOT_TOKEN, 'pinChatMessage', {
        chat_id: chatId,
        message_id: body.result.message_id,
        disable_notification: true,
      });
    }
    return { sent: true, ready: true, status: 'sent', issue: '' };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE telegram_updates
      SET status = 'error', processed_at = ?, error = ?
      WHERE update_id = ?
    `).bind(new Date().toISOString(), clean(error instanceof Error ? error.message : 'telegram_guide_failed', 300), messageKey).run();
    return { sent: false, ready: false, status: 'failed', issue: 'telegram_guide_failed' };
  }
};

const handleTelegramBootstrap = async (request, env) => {
  const suppliedKey = clean(request.headers.get('x-stroios-setup-key'), 160);
  const expectedKey = clean(env.TELEGRAM_SETUP_KEY, 160);
  if (!expectedKey || suppliedKey !== expectedKey) return json({ ok: false, error: 'setup_authorization_required' }, 403);

  const connection = await resolveTelegramConnection(env);
  let webhookReady = false;
  let webhookIssue = '';
  if (env.TELEGRAM_WEBHOOK_URL && env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_BOT_TOKEN) {
    try {
      const [webhookResponse, commandsResponse] = await Promise.all([
        telegramRequest(env.TELEGRAM_BOT_TOKEN, 'setWebhook', {
          url: env.TELEGRAM_WEBHOOK_URL,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ['message', 'callback_query', 'my_chat_member'],
          drop_pending_updates: false,
        }),
        telegramRequest(env.TELEGRAM_BOT_TOKEN, 'setMyCommands', {
          commands: [
            { command: 'task', description: 'Поставить задачу' },
            { command: 'tasks', description: 'Открытые задачи' },
            { command: 'stages', description: 'Этапы и сроки' },
            { command: 'done', description: 'Выполненные задачи' },
            { command: 'finance', description: 'Расходы, доходы и баланс' },
            { command: 'expense', description: 'Добавить расход' },
            { command: 'status', description: 'Статус объекта' },
            { command: 'note', description: 'Запись в дневник объекта' },
            { command: 'report', description: 'Добавить фотоотчёт' },
            { command: 'doc', description: 'Сохранить документ' },
            { command: 'camera', description: 'Камера объекта' },
            { command: 'project', description: 'Выбрать объект' },
            { command: 'help', description: 'Что умеет бот' },
          ],
          language_code: 'ru',
        }),
      ]);
      const [webhookBody, commandsBody] = await Promise.all([
        parseTelegramBody(webhookResponse),
        parseTelegramBody(commandsResponse),
      ]);
      webhookReady = Boolean(webhookResponse.ok && webhookBody?.ok && commandsResponse.ok && commandsBody?.ok);
      if (!webhookReady) webhookIssue = 'telegram_webhook_rejected';
    } catch {
      webhookIssue = 'telegram_provider_unavailable';
    }
  } else {
    webhookIssue = 'webhook_not_configured';
  }
  const guide = webhookReady && connection.chat?.id
    ? await sendTelegramFieldHeadquartersGuide(connection, env)
    : { sent: false, ready: false, status: 'not_attempted', issue: '' };
  return json({
    ok: Boolean(connection.chat?.id && webhookReady),
    telegramBot: Boolean(connection.tokenConfigured && connection.issue !== 'invalid_token'),
    telegramCommon: Boolean(connection.chat?.id),
    telegramCommonTitle: clean(connection.chat?.title, 160),
    telegramCandidateCount: connection.candidates?.length ?? 0,
    telegramIssue: clean(connection.issue, 80),
    telegramInbound: webhookReady,
    telegramWebhookIssue: webhookIssue,
    telegramGuideSent: guide.sent,
    telegramGuideReady: guide.ready,
    telegramGuideStatus: guide.status,
    telegramGuideIssue: guide.issue,
  }, connection.chat?.id && webhookReady ? 200 : 409);
};

const findIdentityAcrossProjects = async (request, env) => {
  const authenticated = authenticatedIdentity(request, env);
  if (!authenticated) return null;
  if (authenticated.isOwner) return { ...authenticated, id: 'owner', role: 'management', status: 'active' };
  if (!env.DB) return null;

  await ensureSchema(env.DB);
  const result = await env.DB.prepare(`
    SELECT state_json
    FROM project_state
    ORDER BY updated_at DESC
    LIMIT 100
  `).all();
  for (const row of result?.results ?? []) {
    try {
      const identity = projectIdentity(request, env, JSON.parse(row.state_json));
      if (identity) return identity;
    } catch {
      // Пропускаем повреждённый снимок, не раскрывая его содержимое.
    }
  }
  return null;
};

const handleSession = async (request, env) => {
  try {
    const identity = await findIdentityAcrossProjects(request, env);
    if (!identity) return json({ ok: false, error: 'access_not_assigned' }, 403);
    return json({
      ok: true,
      user: {
        id: identity.id,
        email: identity.email,
        name: identity.name,
        role: identity.role,
        isOwner: identity.isOwner,
      },
    });
  } catch {
    return json({ ok: false, error: 'session_unavailable' }, 503);
  }
};

const handleCameraStatus = async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
  if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
    return json({
      ok: true,
      camera: {
        configured: Boolean(env.CAMERA_VIEW_URL),
        online: Boolean(env.CAMERA_VIEW_URL && snapshot.state?.project?.cameraStatus === 'online'),
        label: clean(env.CAMERA_LABEL, 80) || 'Камера 01',
      },
    });
  } catch {
    return json({ ok: false, error: 'camera_status_unavailable' }, 503);
  }
};

const handleCameraView = async (request, env) => {
  if (!env.CAMERA_VIEW_URL || !env.DB) return json({ ok: false, error: 'camera_not_configured' }, 409);
  const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
  if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
    const target = new URL(env.CAMERA_VIEW_URL);
    if (!['https:', 'http:'].includes(target.protocol)) return json({ ok: false, error: 'invalid_camera_url' }, 500);
    return Response.redirect(target.toString(), 302);
  } catch {
    return json({ ok: false, error: 'camera_unavailable' }, 503);
  }
};

const handleQualityPhotoUpload = async (request, env) => {
  if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  const projectId = clean(url.searchParams.get('projectId'), 100);
  const checkpointId = clean(url.searchParams.get('checkpointId'), 100);
  if (!validProjectId(projectId) || !validProjectId(checkpointId)) return json({ ok: false, error: 'invalid_checkpoint' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    const checkpoint = (snapshot?.state?.checkpoints ?? []).find((item) => clean(item.id, 100) === checkpointId);
    if (!identity || identity.role === 'client' || !checkpoint) return json({ ok: false, error: 'project_access_denied' }, 403);
    const releaseUpload = claimUploadAdmission();
    if (!releaseUpload) return json({ ok: false, error: 'upload_busy' }, 429);
    try {
      const form = await readFormDataLimited(request, MAX_QUALITY_PHOTO_BYTES + MAX_MULTIPART_OVERHEAD_BYTES);
      const file = form.get('file');
      if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return json({ ok: false, error: 'file_required' }, 422);
      if (Number(file.size) <= 0 || Number(file.size) > MAX_QUALITY_PHOTO_BYTES) return json({ ok: false, error: 'invalid_file_size' }, 413);
      const prefix = await file.slice(0, 512).arrayBuffer();
      const mimeType = rasterImageMimeType(file, prefix);
      if (!mimeType) return json({ ok: false, error: 'unsupported_file' }, 415);
      const name = safeFileName(file.name);
      const fileKey = `${projectId}/quality/${checkpointId}/${crypto.randomUUID()}-${name}`;
      const uploadedAt = new Date().toISOString();
      await env.BUCKET.put(fileKey, file.stream(), {
        maxBytes: MAX_QUALITY_PHOTO_BYTES,
        httpMetadata: { contentType: mimeType || 'application/octet-stream' },
        customMetadata: {
          projectId,
          checkpointId,
          originalName: name,
          uploadedBy: identity.id,
          uploadedAt,
        },
      });
      return json({
        ok: true,
        photo: {
          id: crypto.randomUUID(),
          name,
          capturedAt: uploadedAt,
          fileKey,
          fileName: name,
          mimeType,
          sizeBytes: Number(file.size),
          uploadedAt,
          uploadedBy: identity.name,
          source: 'web',
        },
      }, 201);
    } finally {
      releaseUpload();
    }
  } catch (error) {
    if (error?.message === 'payload_too_large') return json({ ok: false, error: 'payload_too_large' }, 413);
    return json({ ok: false, error: 'upload_failed' }, 500);
  }
};

const handleQualityPhotoFile = async (request, env) => {
  if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  const projectId = clean(url.searchParams.get('projectId'), 100);
  const key = clean(url.searchParams.get('key'), 500);
  if (!validProjectId(projectId) || !key.startsWith(`${projectId}/quality/`)) return json({ ok: false, error: 'invalid_file' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
    const checkpoint = (snapshot.state?.checkpoints ?? []).find((item) => (
      (item.photos ?? []).some((photo) => clean(photo.fileKey, 500) === key)
    ));
    if (!checkpoint || (identity.role === 'client' && !checkpoint.clientVisible)) return json({ ok: false, error: 'file_not_found' }, 404);
    const photo = (checkpoint.photos ?? []).find((item) => clean(item.fileKey, 500) === key);
    const object = await env.BUCKET.get(key);
    if (!object || !photo) return json({ ok: false, error: 'file_not_found' }, 404);
    let body = object.body;
    let mimeType = '';
    if (body?.tee) {
      const [probe, responseBody] = body.tee();
      body = responseBody;
      mimeType = detectRasterImageType(await readStreamPrefix(probe));
    }
    const filename = safeFileName(photo.fileName || photo.name || 'quality-photo');
    const headers = protectedFileHeaders(filename, 'quality-photo', { inlineMime: mimeType });
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    return new Response(body, { headers });
  } catch {
    return json({ ok: false, error: 'file_unavailable' }, 500);
  }
};

const handleDocumentUpload = async (request, env) => {
  if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
  if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity || identity.role === 'client') return json({ ok: false, error: 'project_access_denied' }, 403);
    const releaseUpload = claimUploadAdmission();
    if (!releaseUpload) return json({ ok: false, error: 'upload_busy' }, 429);
    try {
      const form = await readFormDataLimited(request, MAX_FILE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES);
      const file = form.get('file');
      if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return json({ ok: false, error: 'file_required' }, 422);
      if (Number(file.size) <= 0 || Number(file.size) > MAX_FILE_BYTES) return json({ ok: false, error: 'invalid_file_size' }, 413);
      const prefix = await file.slice(0, 512).arrayBuffer();
      const mimeType = documentMimeType(file, prefix);
      if (!mimeType) return json({ ok: false, error: 'unsupported_file' }, 415);
      const name = safeFileName(file.name);
      const key = `${projectId}/${crypto.randomUUID()}-${name}`;
      const uploadedAt = new Date().toISOString();
      await env.BUCKET.put(key, file.stream(), {
        maxBytes: MAX_FILE_BYTES,
        httpMetadata: { contentType: mimeType },
        customMetadata: {
          projectId,
          originalName: name,
          uploadedBy: identity.id,
          uploadedAt,
        },
      });
      return json({
        ok: true,
        file: {
          key,
          name,
          type: mimeType,
          size: Number(file.size),
          uploadedAt,
        },
      }, 201);
    } finally {
      releaseUpload();
    }
  } catch (error) {
    if (error?.message === 'payload_too_large') return json({ ok: false, error: 'payload_too_large' }, 413);
    return json({ ok: false, error: 'upload_failed' }, 500);
  }
};

const handleDocumentFile = async (request, env) => {
  if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  const projectId = clean(url.searchParams.get('projectId'), 100);
  const key = clean(url.searchParams.get('key'), 500);
  if (!validProjectId(projectId) || !key.startsWith(`${projectId}/`)) return json({ ok: false, error: 'invalid_file' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
    const document = (snapshot.state?.documents ?? []).find((item) => clean(item.fileKey, 500) === key);
    if (!document || (identity.role === 'client' && !document.clientVisible)) return json({ ok: false, error: 'file_not_found' }, 404);
    const object = await env.BUCKET.get(key);
    if (!object) return json({ ok: false, error: 'file_not_found' }, 404);
    const filename = safeFileName(document.fileName || document.name);
    const headers = protectedFileHeaders(filename, 'document');
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    return new Response(object.body, { headers });
  } catch {
    return json({ ok: false, error: 'file_unavailable' }, 500);
  }
};

const handleFieldReportFile = async (request, env) => {
  if (!env.DB || !env.BUCKET) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  const projectId = clean(url.searchParams.get('projectId'), 100);
  const key = clean(url.searchParams.get('key'), 500);
  if (!validProjectId(projectId) || !key.startsWith(`${projectId}/`)) return json({ ok: false, error: 'invalid_file' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity) return json({ ok: false, error: 'project_access_denied' }, 403);
    const report = (snapshot.state?.fieldReports ?? []).find((item) => (item.attachments ?? []).some((attachment) => clean(attachment.key, 500) === key));
    if (!report || (identity.role === 'client' && !report.clientVisible)) return json({ ok: false, error: 'file_not_found' }, 404);
    const attachment = (report.attachments ?? []).find((item) => clean(item.key, 500) === key);
    const object = await env.BUCKET.get(key);
    if (!object || !attachment) return json({ ok: false, error: 'file_not_found' }, 404);
    const filename = safeFileName(attachment.name);
    const headers = protectedFileHeaders(filename, 'field-report');
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    return new Response(object.body, { headers });
  } catch {
    return json({ ok: false, error: 'file_unavailable' }, 500);
  }
};

const handleLeadInbox = async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  await ensureSchema(env.DB);
  if (request.method === 'GET') {
    const projectId = clean(new URL(request.url).searchParams.get('projectId'), 100);
    if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
    try {
      const snapshot = await readSnapshot(env.DB, projectId);
      const identity = projectId === PUBLIC_LEAD_PROJECT_ID
        ? authenticatedIdentity(request, env)
        : snapshot ? projectIdentity(request, env, snapshot.state) : null;
      if (!identity || (projectId === PUBLIC_LEAD_PROJECT_ID ? !identity.isOwner : identity.role !== 'management')) {
        return json({ ok: false, error: 'project_access_denied' }, 403);
      }
      const result = await env.DB.prepare(`SELECT id, project_id, created_at, name, phone, email, source, message, status FROM lead_inbox WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`).bind(projectId).all();
      return json({ ok: true, leads: result?.results ?? [] });
    } catch { return json({ ok: false, error: 'storage_error' }, 500); }
  }
  let payload;
  try { payload = await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES); } catch (error) {
    return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400);
  }
  const projectId = clean(payload?.projectId, 100);
  const name = clean(payload?.name, 120);
  const phone = clean(payload?.phone, 60);
  const email = clean(payload?.email, 240);
  const source = clean(payload?.source, 40) || 'website';
  const message = clean(payload?.message, 1000);
  if (!validProjectId(projectId) || !name || !phone) return json({ ok: false, error: 'invalid_lead' }, 422);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : null;
    if (!identity || identity.role !== 'management') return json({ ok: false, error: 'project_access_denied' }, 403);
    await env.DB.prepare(`INSERT INTO lead_inbox (id, project_id, created_at, name, phone, email, source, message, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`).bind(id, projectId, createdAt, name, phone, email || null, source, message || null).run();
    return json({ ok: true, lead: { id, projectId, createdAt, name, phone, email, source, message, status: 'new' } }, 201);
  } catch { return json({ ok: false, error: 'storage_error' }, 500); }
};

const incrementPublicLeadRateLimit = async (db, key, windowStart, updatedAt) => {
  await db.prepare(`
    INSERT INTO public_lead_rate_limits (key, window_start, attempts, updated_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(key, window_start) DO UPDATE SET
      attempts = public_lead_rate_limits.attempts + 1,
      updated_at = excluded.updated_at
  `).bind(key, windowStart, updatedAt).run();
  const row = await db.prepare(`
    SELECT attempts
    FROM public_lead_rate_limits
    WHERE key = ? AND window_start = ?
  `).bind(key, windowStart).first();
  return Number(row?.attempts) || 0;
};

export const claimPublicLeadRateLimit = async (db, clientAddress, now = Date.now()) => {
  const windowTime = Math.floor(now / PUBLIC_LEAD_RATE_WINDOW_MS) * PUBLIC_LEAD_RATE_WINDOW_MS;
  const windowStart = new Date(windowTime).toISOString();
  const updatedAt = new Date(now).toISOString();
  const retryAfter = Math.max(1, Math.ceil((windowTime + PUBLIC_LEAD_RATE_WINDOW_MS - now) / 1000));
  const expiredBefore = new Date(windowTime - 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(`
    DELETE FROM public_lead_rate_limits
    WHERE window_start < ?
  `).bind(expiredBefore).run();

  const clientHash = await sha256(normalizeClientAddress(clientAddress));
  const clientAttempts = await incrementPublicLeadRateLimit(db, `client:${clientHash}`, windowStart, updatedAt);
  if (clientAttempts > PUBLIC_LEAD_CLIENT_LIMIT) return { allowed: false, retryAfter, scope: 'client' };
  return { allowed: true, retryAfter, scope: '' };
};

const handlePublicLead = async (request, env) => {
  const origin = clean(request.headers.get('origin'), 500);
  if (!PUBLIC_LEAD_ORIGINS.has(origin)) return json({ ok: false, error: 'forbidden_origin' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    },
  });
  if (request.method !== 'POST') return publicLeadResponse({ ok: false, error: 'method_not_allowed' }, 405, origin);
  if (!env.DB) return publicLeadResponse({ ok: false, error: 'storage_unavailable' }, 503, origin);

  let payload;
  try {
    payload = await readJsonBodyLimited(request, PUBLIC_LEAD_BODY_LIMIT);
  } catch (error) {
    return publicLeadResponse(
      { ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' },
      error?.message === 'payload_too_large' ? 413 : 400,
      origin,
    );
  }

  const name = clean(payload?.name, 120);
  const phone = clean(payload?.phone, 60);
  const email = clean(payload?.email, 240);
  const source = clean(payload?.source, 40) || 'website';
  const message = clean(payload?.message, 1000);
  const trap = clean(payload?.company, 120);
  if (trap) return publicLeadResponse({ ok: true }, 202, origin);
  if (!name || phone.replace(/\D/g, '').length < 10 || (email && !/^\S+@\S+\.\S+$/.test(email))) {
    return publicLeadResponse({ ok: false, error: 'invalid_lead' }, 422, origin);
  }

  try {
    await ensureSchema(env.DB);
    const clientAddress = clean(
      request.headers.get('oai-client-ip') || request.headers.get('cf-connecting-ip'),
      200,
    ) || 'unknown';
    const rateLimit = await claimPublicLeadRateLimit(env.DB, clientAddress);
    if (!rateLimit.allowed) {
      return publicLeadResponse(
        { ok: false, error: 'rate_limit_exceeded' },
        429,
        origin,
        { 'Retry-After': String(rateLimit.retryAfter) },
      );
    }
  } catch {
    return publicLeadResponse({ ok: false, error: 'storage_error' }, 500, origin);
  }

  try {
    const duplicateAfter = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const duplicate = await env.DB.prepare(`
      SELECT id FROM lead_inbox
      WHERE project_id = ? AND phone = ? AND created_at >= ?
      LIMIT 1
    `).bind(PUBLIC_LEAD_PROJECT_ID, phone, duplicateAfter).first();
    if (duplicate?.id) return publicLeadResponse({ ok: true, duplicate: true }, 200, origin);

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO lead_inbox (id, project_id, created_at, name, phone, email, source, message, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
    `).bind(id, PUBLIC_LEAD_PROJECT_ID, createdAt, name, phone, email || null, source, message || null).run();
    let telegramNotified = false;
    try {
      const connection = await resolveTelegramConnection(env, { discover: false });
      if (env.TELEGRAM_BOT_TOKEN && connection.chat?.id) {
        const details = [
          '🏠 Новая заявка с ikioma.ru',
          `Имя: ${name}`,
          `Телефон: ${phone}`,
          email ? `Email: ${email}` : '',
          `Источник: ${source}`,
          message ? `Комментарий: ${message}` : '',
          `Открыть воронку: ${deepLink(telegramOrigin(env), PUBLIC_LEAD_PROJECT_ID, 'marketing', id)}`,
        ].filter(Boolean).join('\n');
        const notification = await telegramSend(env.TELEGRAM_BOT_TOKEN, connection.chat.id, details, { timeoutMs: 3_000 });
        telegramNotified = notification.ok;
      }
    } catch {
      telegramNotified = false;
    }
    return publicLeadResponse({ ok: true, leadId: id, telegramNotified }, 201, origin);
  } catch {
    return publicLeadResponse({ ok: false, error: 'storage_error' }, 500, origin);
  }
};

const handleDeveloperFeedback = async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  let projectId = clean(url.searchParams.get('projectId'), 120);
  let payload = null;
  if (request.method === 'POST') {
    try { payload = await readJsonBodyLimited(request, MAX_JSON_BODY_BYTES); } catch (error) {
      return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400);
    }
    projectId = clean(payload?.projectId, 120);
  }
  if (!validProjectId(projectId)) return json({ ok: false, error: 'invalid_project' }, 422);
  try {
    await ensureSchema(env.DB);
    const snapshot = await readSnapshot(env.DB, projectId);
    const identity = snapshot ? projectIdentity(request, env, snapshot.state) : authenticatedIdentity(request, env);
    if (!identity || identity.role !== 'management') return json({ ok: false, error: 'project_access_denied' }, 403);
    if (request.method === 'GET') {
      const result = await env.DB.prepare(`
        SELECT id, project_id, created_at, created_by, page, category, title, details, status
        FROM developer_feedback WHERE project_id = ? ORDER BY created_at DESC LIMIT 50
      `).bind(projectId).all();
      return json({ ok: true, items: (result.results ?? []).map((row) => ({
        id: row.id, projectId: row.project_id, createdAt: row.created_at, createdBy: row.created_by,
        page: row.page, category: row.category, title: row.title, details: row.details, status: row.status,
      })) });
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
    const page = clean(payload?.page, 60);
    const category = clean(payload?.category, 60);
    const title = clean(payload?.title, 160);
    const details = clean(payload?.details, 3000);
    if (!page || !category || !title || !details) return json({ ok: false, error: 'invalid_feedback' }, 422);
    const item = { id: crypto.randomUUID(), projectId, createdAt: new Date().toISOString(), createdBy: clean(identity.name || identity.email, 160) || 'Пользователь', page, category, title, details, status: 'new' };
    await env.DB.prepare(`
      INSERT INTO developer_feedback (id, project_id, created_at, created_by, page, category, title, details, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(item.id, item.projectId, item.createdAt, item.createdBy, item.page, item.category, item.title, item.details, item.status).run();
    return json({ ok: true, item }, 201);
  } catch {
    return json({ ok: false, error: 'storage_error' }, 500);
  }
};


const handleApi = async (request, env, context) => {
  const url = new URL(request.url);
  if (url.pathname === '/api/public/leads') return handlePublicLead(request, env);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ ok: false, error: 'forbidden_origin' }, 403);

  if (url.pathname === '/api/session' && request.method === 'GET') return handleSession(request, env);
  if (url.pathname === '/api/state' && request.method === 'GET') return handleGetState(request, env);
  if (url.pathname === '/api/state' && request.method === 'PUT') return handlePutState(request, env, context);
  if (url.pathname === '/api/projects' && request.method === 'GET') return handleProjects(request, env);
  if (url.pathname === '/api/integrations/status' && request.method === 'GET') return handleIntegrationStatus(request, env);
  if (url.pathname === '/api/integrations/test' && request.method === 'POST') return handleIntegrationTest(request, env);
  if (url.pathname === '/api/integrations/telegram/select' && request.method === 'POST') return handleTelegramChatSelect(request, env);
  if (url.pathname === '/api/integrations/telegram/link' && request.method === 'POST') return handleTelegramLink(request, env);
  if (url.pathname === '/api/integrations/telegram/bootstrap' && request.method === 'POST') return handleTelegramBootstrap(request, env);
  if (url.pathname === '/api/integrations/telegram/update' && request.method === 'POST') return handleTelegramUpdate(request, env, context);
  if (url.pathname === '/api/camera/status' && request.method === 'GET') return handleCameraStatus(request, env);
  if (url.pathname === '/api/camera/view' && request.method === 'GET') return handleCameraView(request, env);
  if (url.pathname === '/api/quality/upload' && request.method === 'POST') return handleQualityPhotoUpload(request, env);
  if (url.pathname === '/api/quality/file' && request.method === 'GET') return handleQualityPhotoFile(request, env);
  if (url.pathname === '/api/documents/upload' && request.method === 'POST') return handleDocumentUpload(request, env);
  if (url.pathname === '/api/documents/file' && request.method === 'GET') return handleDocumentFile(request, env);
  if (url.pathname === '/api/field-reports/file' && request.method === 'GET') return handleFieldReportFile(request, env);
  if (url.pathname === '/api/leads' && (request.method === 'GET' || request.method === 'POST')) return handleLeadInbox(request, env);
  if (url.pathname === '/api/developer-feedback' && (request.method === 'GET' || request.method === 'POST')) return handleDeveloperFeedback(request, env);
  if (url.pathname === '/api/audit' && request.method === 'GET') return handleAudit(request, env);
  return json({ ok: false, error: 'not_found' }, 404);
};

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
