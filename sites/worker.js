import {
  authenticatedIdentity,
  mergeStateForRole,
  normalizeEmail,
  projectIdentity,
  stateForRole,
} from './access-control.js';
import { addCalendarDays, addDays, dateKey, isoDate } from './lib/date.js';
import { json, publicLeadResponse } from './lib/http.js';
import { clean, safeFileName, supportedDocument, validProjectId } from './lib/validation.js';

const MAX_STATE_BYTES = 6_000_000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_QUALITY_PHOTO_BYTES = 12 * 1024 * 1024;
const TELEGRAM_CONFIG_PROJECT_ID = '__integration__:telegram';
const BATTLE_SCHEMA_VERSION = 17;
const BATTLE_RESET_KEY = 'battle_v17_reset';
const PUBLIC_LEAD_PROJECT_ID = 'ikioma-sales';
const PUBLIC_LEAD_ORIGINS = new Set(['https://ikioma.ru', 'https://www.ikioma.ru']);
let schemaPromise;
let battleResetPromise;

const changes = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

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
        CREATE INDEX IF NOT EXISTS data_reset_backups_created_at
        ON data_reset_backups (created_at DESC)
      `).run(),
    ])).catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  await schemaPromise;
};

const cleanWorkspaceState = (env) => {
  const today = isoDate();
  const target = isoDate(addCalendarDays(new Date(`${today}T12:00:00Z`), 120));
  const stageTemplates = [
    ['prebuild', 'Подготовка участка и временные сети', 'Подготовка', 5, 7],
    ['foundation', 'Фундамент', 'Фундамент', 10, 10],
    ['floor', 'Перекрытие и нижняя обвязка', 'Перекрытие', 6, 7],
    ['sip', 'Сборка силового и SIP-контура', 'SIP-контур', 15, 14],
    ['roof', 'Кровля', 'Кровля', 8, 10],
    ['openings', 'Окна и входные двери', 'Окна', 6, 7],
    ['facade', 'Фасад и защита контура', 'Фасад', 7, 14],
    ['electric', 'Электрика', 'Электрика', 7, 10],
    ['engineering', 'Вода, канализация, ОВиК', 'Инженерия', 10, 14],
    ['rough', 'Черновая отделка', 'Черновая', 7, 12],
    ['finish', 'Чистовая отделка', 'Чистовая', 7, 14],
    ['commissioning', 'Пусконаладка и испытания', 'Испытания', 7, 7],
    ['handover', 'Сдача дома клиенту', 'Сдача', 5, 4],
  ];
  const availableDays = 120;
  const templateDays = stageTemplates.reduce((sum, item) => sum + item[4], 0);
  let cursor = 0;
  const stages = stageTemplates.map((template, index) => {
    const startOffset = Math.min(availableDays - 1, Math.round(cursor / templateDays * availableDays));
    cursor += template[4];
    const endOffset = index === stageTemplates.length - 1
      ? availableDays
      : Math.max(startOffset + 1, Math.round(cursor / templateDays * availableDays));
    return {
      id: template[0],
      order: index + 1,
      name: template[1],
      shortName: template[2],
      status: 'not_ready',
      weight: template[3],
      progress: 0,
      planStart: isoDate(addCalendarDays(new Date(`${today}T12:00:00Z`), startOffset)),
      planEnd: isoDate(addCalendarDays(new Date(`${today}T12:00:00Z`), endOffset)),
      forecastEnd: isoDate(addCalendarDays(new Date(`${today}T12:00:00Z`), endOffset)),
      responsible: 'Не назначен',
      dependencyId: index ? stageTemplates[index - 1][0] : undefined,
      dependency: index ? stageTemplates[index - 1][2] : undefined,
    };
  });
  const budgetLines = [
    ['bl-prebuild', ['prebuild'], 'Подготовка участка'],
    ['bl-foundation', ['foundation'], 'Фундамент'],
    ['bl-structure', ['floor', 'sip'], 'Силовой контур и SIP'],
    ['bl-roof', ['roof'], 'Кровля'],
    ['bl-openings', ['openings'], 'Окна и двери'],
    ['bl-facade', ['facade'], 'Фасад'],
    ['bl-engineering', ['electric', 'engineering'], 'Инженерные системы'],
    ['bl-finish', ['rough', 'finish'], 'Отделка'],
    ['bl-management', ['commissioning', 'handover'], 'Управление и резерв'],
  ].map(([id, stageIds, name]) => ({ id, stageIds, name, plan: 0, forecast: 0 }));
  const ownerEmail = normalizeEmail(env.OWNER_EMAIL) || 'vitaliyozolin@gmail.com';
  const ownerName = clean(env.OWNER_NAME, 120) || 'Виталий Озолин';
  return {
    version: 1,
    schemaVersion: BATTLE_SCHEMA_VERSION,
    project: {
      id: 'workspace-initial',
      code: 'NEW',
      name: 'Новый проект',
      address: '',
      model: '',
      area: 0,
      clientNames: '',
      contractValue: 0,
      targetCost: 0,
      startDate: today,
      targetDate: target,
      forecastDate: target,
      foreman: '',
      cameraStatus: 'offline',
      createdAt: new Date().toISOString(),
      source: 'Чистое рабочее пространство',
      status: 'workspace',
    },
    budgetMeta: {
      version: '—',
      source: 'Смета не загружена',
      note: 'План появится после загрузки или ручного подтверждения сметы.',
    },
    stages,
    budgetLines,
    financeEntries: [],
    procurement: [],
    counterparties: [],
    supplierQuotes: [],
    leads: [],
    tasks: [],
    fieldReports: [],
    settings: {
      schemaVersion: BATTLE_SCHEMA_VERSION,
      users: [{
        id: 'user-owner',
        name: ownerName,
        email: ownerEmail,
        role: 'management',
        status: 'active',
      }],
      notifications: {
        channels: { email: false, telegram: false, browser: true },
        events: {
          financeApproval: true,
          supplyRisk: true,
          qualityRework: true,
          leadWithoutAction: true,
          scheduleDelay: true,
          taskAssigned: true,
          taskOverdue: true,
          projectActivity: true,
        },
      },
      dashboardWidgets: ['project', 'progress', 'finance', 'decisions', 'cashflow', 'quality', 'supply', 'tasks', 'activity'],
    },
    checkpoints: [],
    documents: [],
    decisions: [],
    activity: [],
  };
};

const waitForBattleReset = async (db) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const marker = await db.prepare(`SELECT value FROM system_meta WHERE key = ?`).bind(BATTLE_RESET_KEY).first();
    if (marker?.value === 'done') return;
  }
  throw new Error('battle_reset_in_progress');
};

const runBattleReset = async (env) => {
  if (!env.DB) throw new Error('storage_unavailable');
  await ensureSchema(env.DB);
  const existing = await env.DB.prepare(`SELECT value FROM system_meta WHERE key = ?`).bind(BATTLE_RESET_KEY).first();
  if (existing?.value === 'done') return;

  const lockValue = `running:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO system_meta (key, value, updated_at)
    VALUES (?, ?, ?)
  `).bind(BATTLE_RESET_KEY, lockValue, now).run();
  const lock = await env.DB.prepare(`SELECT value FROM system_meta WHERE key = ?`).bind(BATTLE_RESET_KEY).first();
  if (lock?.value === 'done') return;
  if (lock?.value !== lockValue) {
    await waitForBattleReset(env.DB);
    return;
  }

  try {
    const [projectRows, leadRows] = await Promise.all([
      env.DB.prepare(`
        SELECT project_id, state_json, revision, created_at, updated_at, updated_by, updated_role
        FROM project_state
        WHERE substr(project_id, 1, 2) != '__'
      `).all(),
      env.DB.prepare(`
        SELECT id, project_id, created_at, name, phone, email, source, message, status
        FROM lead_inbox
      `).all(),
    ]);
    for (const row of projectRows?.results ?? []) {
      await env.DB.prepare(`
        INSERT INTO data_reset_backups (id, kind, record_key, payload_json, created_at, reason)
        VALUES (?, 'project_state', ?, ?, ?, 'Удаление демонстрационных данных перед боевым запуском v17')
      `).bind(crypto.randomUUID(), row.project_id, JSON.stringify(row), now).run();
    }
    for (const row of leadRows?.results ?? []) {
      await env.DB.prepare(`
        INSERT INTO data_reset_backups (id, kind, record_key, payload_json, created_at, reason)
        VALUES (?, 'lead_inbox', ?, ?, ?, 'Удаление демонстрационных данных перед боевым запуском v17')
      `).bind(crypto.randomUUID(), row.id, JSON.stringify(row), now).run();
    }

    const workspace = cleanWorkspaceState(env);
    const workspaceJson = JSON.stringify(workspace);
    const workspaceBytes = new TextEncoder().encode(workspaceJson).byteLength;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM project_state WHERE substr(project_id, 1, 2) != '__'`),
      env.DB.prepare(`DELETE FROM audit_log WHERE substr(project_id, 1, 2) != '__'`),
      env.DB.prepare(`DELETE FROM lead_inbox`),
      env.DB.prepare(`DELETE FROM telegram_link_codes`),
      env.DB.prepare(`DELETE FROM telegram_bindings`),
      env.DB.prepare(`DELETE FROM telegram_chat_projects`),
      env.DB.prepare(`DELETE FROM telegram_chat_candidates`),
      env.DB.prepare(`DELETE FROM telegram_drafts`),
      env.DB.prepare(`DELETE FROM telegram_updates`),
      env.DB.prepare(`
        INSERT INTO project_state (
          project_id, state_json, revision, created_at, updated_at, updated_by, updated_role
        ) VALUES ('workspace-initial', ?, 1, ?, ?, 'Система', 'management')
      `).bind(workspaceJson, now, now),
      env.DB.prepare(`
        INSERT INTO audit_log (
          id, project_id, revision, created_at, actor, role, action, summary, state_bytes
        ) VALUES (?, 'workspace-initial', 1, ?, 'Система', 'management', 'battle_reset', 'Демонстрационные данные удалены, создано чистое рабочее пространство', ?)
      `).bind(crypto.randomUUID(), now, workspaceBytes),
      env.DB.prepare(`
        UPDATE system_meta SET value = 'done', updated_at = ? WHERE key = ? AND value = ?
      `).bind(now, BATTLE_RESET_KEY, lockValue),
    ]);
    console.log(JSON.stringify({
      event: 'battle_reset_completed',
      version: BATTLE_SCHEMA_VERSION,
      projectBackups: projectRows?.results?.length ?? 0,
      leadBackups: leadRows?.results?.length ?? 0,
    }));
  } catch (error) {
    await env.DB.prepare(`DELETE FROM system_meta WHERE key = ? AND value = ?`).bind(BATTLE_RESET_KEY, lockValue).run();
    throw error;
  }
};

const ensureBattleReset = async (env) => {
  if (!battleResetPromise) {
    battleResetPromise = runBattleReset(env).catch((error) => {
      battleResetPromise = undefined;
      throw error;
    });
  }
  await battleResetPromise;
};

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

const telegramSend = (token, chatId, text, options = {}) => {
  const { timeoutMs = 10_000, ...telegramOptions } = options;
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, ...telegramOptions }),
  });
};

const telegramRequest = (token, method, payload = {}) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});

const parseTelegramBody = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

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

const telegramAnswerCallback = (token, callbackQueryId, text = '', showAlert = false) => telegramRequest(token, 'answerCallbackQuery', {
  callback_query_id: callbackQueryId,
  text,
  show_alert: showAlert,
});

const telegramEditMessage = (token, chatId, messageId, text, replyMarkup) => telegramRequest(token, 'editMessageText', {
  chat_id: chatId,
  message_id: messageId,
  text,
  disable_web_page_preview: true,
  reply_markup: replyMarkup,
});

const telegramSendPhoto = (token, chatId, photo, caption, options = {}) => telegramRequest(token, 'sendPhoto', {
  chat_id: chatId,
  photo,
  caption,
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
    return { previous, state, revision: nextRevision, updatedAt: now };
  }
  throw new Error('revision_conflict');
};

const bindingForTelegramUser = async (db, telegramUserId, chatId = '') => {
  await ensureSchema(db);
  if (chatId) {
    const mapped = await db.prepare(`SELECT project_id FROM telegram_chat_projects WHERE chat_id = ?`).bind(chatId).first();
    if (mapped?.project_id) {
      const binding = await db.prepare(`
        SELECT telegram_user_id, project_id, system_user_id, private_chat_id, username, display_name, role, bound_at, updated_at
        FROM telegram_bindings
        WHERE telegram_user_id = ? AND project_id = ?
      `).bind(telegramUserId, mapped.project_id).first();
      if (binding) return binding;
    }
  }
  return db.prepare(`
    SELECT telegram_user_id, project_id, system_user_id, private_chat_id, username, display_name, role, bound_at, updated_at
    FROM telegram_bindings
    WHERE telegram_user_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).bind(telegramUserId).first();
};

const bindingsForTelegramUser = async (db, telegramUserId) => {
  await ensureSchema(db);
  const result = await db.prepare(`
    SELECT telegram_user_id, project_id, system_user_id, private_chat_id, username, display_name, role, bound_at, updated_at
    FROM telegram_bindings
    WHERE telegram_user_id = ?
    ORDER BY updated_at DESC
  `).bind(telegramUserId).all();
  return result?.results ?? [];
};

const createTelegramDraft = async (db, telegramUserId, chatId, projectId, kind, payload) => {
  const id = shortId();
  const now = new Date();
  await db.prepare(`
    INSERT INTO telegram_drafts (
      id, telegram_user_id, chat_id, project_id, kind, payload_json, status, created_at, expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
  `).bind(id, telegramUserId, chatId, projectId, kind, JSON.stringify(payload), now.toISOString(), addDays(now, 1).toISOString(), now.toISOString()).run();
  return { id, payload };
};

const readTelegramDraft = async (db, id, telegramUserId) => {
  const row = await db.prepare(`
    SELECT id, telegram_user_id, chat_id, project_id, kind, payload_json, status, created_at, expires_at, updated_at
    FROM telegram_drafts
    WHERE id = ? AND telegram_user_id = ?
  `).bind(id, telegramUserId).first();
  if (!row || row.status !== 'draft' || row.expires_at < new Date().toISOString()) return null;
  try {
    return { ...row, payload: JSON.parse(row.payload_json) };
  } catch {
    return null;
  }
};

const updateTelegramDraft = async (db, draft, payload, status = 'draft') => {
  await db.prepare(`
    UPDATE telegram_drafts
    SET payload_json = ?, status = ?, updated_at = ?
    WHERE id = ? AND status = 'draft'
  `).bind(JSON.stringify(payload), status, new Date().toISOString(), draft.id).run();
};

const telegramDisplayName = (from) => clean([from?.first_name, from?.last_name].filter(Boolean).join(' '), 160)
  || clean(from?.username, 120)
  || `Telegram ${String(from?.id ?? '')}`;

const commandFromText = (value) => {
  const text = clean(value, 3000);
  const match = text.match(/^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  return match ? { name: match[1].toLocaleLowerCase('en-US'), body: clean(match[2], 2400) } : null;
};

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

const telegramFileToR2 = async (env, projectId, fileId, fileName, mimeType, uploadedBy) => {
  const metadataResponse = await telegramRequest(env.TELEGRAM_BOT_TOKEN, 'getFile', { file_id: fileId });
  const metadataBody = await parseTelegramBody(metadataResponse);
  if (!metadataResponse.ok || !metadataBody?.ok || !metadataBody.result?.file_path) throw new Error('telegram_file_unavailable');
  const declaredSize = Number(metadataBody.result.file_size) || 0;
  if (declaredSize > MAX_FILE_BYTES) throw new Error('telegram_file_too_large');
  const sourceResponse = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${metadataBody.result.file_path}`);
  if (!sourceResponse.ok || !sourceResponse.body) throw new Error('telegram_file_unavailable');
  const safeName = safeFileName(fileName);
  const key = `${projectId}/telegram/${crypto.randomUUID()}-${safeName}`;
  const uploadedAt = new Date().toISOString();
  await env.BUCKET.put(key, sourceResponse.body, {
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
    id: `attachment-${crypto.randomUUID()}`,
    key,
    name: safeName,
    mimeType: clean(mimeType, 120) || sourceResponse.headers.get('content-type') || 'application/octet-stream',
    sizeBytes: declaredSize || Number(sourceResponse.headers.get('content-length')) || 0,
    uploadedAt,
    uploadedBy: clean(uploadedBy, 160),
    source: 'telegram',
  };
};

const telegramOrigin = (env) => clean(env.APP_PUBLIC_URL, 500) || 'https://stroios-work-2026.ozolin.chatgpt.site';

const telegramHelp = (role = 'foreman') => [
  'ИКИОМА ОС · полевой штаб',
  '',
  role === 'management' ? '/task текст — поставить задачу' : null,
  '/tasks — мои открытые задачи',
  '/stages — этапы и их состояние',
  '/done — последние выполненные задачи',
  role === 'management' ? '/finance — расходы, доходы и баланс' : null,
  '/status — статус объекта',
  '/report — как добавить фотоотчёт',
  '/doc — как сохранить документ',
  '/camera — эфир или свежий кадр',
  '/project — выбрать объект',
  '/help — эта подсказка',
  '',
  'Можно спросить обычным текстом: «этапы», «выполненные задачи», «расходы и доходы». В общем чате напишите, например: «@ikioma_bot этапы» — или ответьте на сообщение бота.',
  '',
  'Фото, документ или голосовое сообщение можно прислать боту в личный чат. В общем чате добавьте к файлу подпись /report или /doc. Перед сохранением бот всегда покажет черновик.',
].filter(Boolean).join('\n');

const taskStatusLabel = (status) => ({
  todo: 'к выполнению',
  in_progress: 'в работе',
  waiting: 'ожидает',
  review: 'на проверке',
  done: 'выполнено',
  canceled: 'отменено',
}[status] ?? status);

const taskActionMarkup = (taskId, role) => ({
  inline_keyboard: role === 'management'
    ? [[
      { text: 'В работу', callback_data: `ts|${taskId}|ip` },
      { text: 'Выполнено', callback_data: `ts|${taskId}|done` },
      { text: 'Есть проблема', callback_data: `ts|${taskId}|wait` },
    ]]
    : [[
      { text: 'Принял', callback_data: `ts|${taskId}|ip` },
      { text: 'На проверку', callback_data: `ts|${taskId}|review` },
      { text: 'Есть проблема', callback_data: `ts|${taskId}|wait` },
    ]],
});

const telegramBotUsername = async (env) => {
  const stored = await readTelegramConfig(env.DB);
  const configured = clean(stored?.bot?.username, 120);
  if (configured) return configured;
  const response = await telegramRequest(env.TELEGRAM_BOT_TOKEN, 'getMe');
  const body = await parseTelegramBody(response);
  return response.ok && body?.ok ? clean(body.result?.username, 120) : '';
};

const handleTelegramLink = async (request, env) => {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'telegram_not_configured' }, 409);
  let payload;
  try { payload = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
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
  await env.DB.prepare(`
    INSERT INTO telegram_chat_projects (chat_id, project_id, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      project_id = excluded.project_id,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).bind(privateChatId, row.project_id, now, telegramUserId).run();

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
        status: item.status === 'disabled' ? 'disabled' : 'active',
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
  await env.DB.prepare(`UPDATE telegram_link_codes SET used_at = ? WHERE code_hash = ?`).bind(now, codeHash).run();

  const connection = await resolveTelegramConnection(env, { discover: false });
  if (connection.chat?.id) {
    await env.DB.prepare(`
      INSERT INTO telegram_chat_projects (chat_id, project_id, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        project_id = excluded.project_id,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).bind(String(connection.chat.id), row.project_id, now, telegramUserId).run();
  }
  await telegramSend(
    env.TELEGRAM_BOT_TOKEN,
    privateChatId,
    `Готово, ${user.name}. Вы подключены к проекту «${snapshot.state.project?.name ?? snapshot.state.project?.code}».\n\n${telegramHelp(user.role)}`,
  );
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
    assigneeId: assignee?.id ?? '',
    dueDate,
    dueOffset: [0, 1, 3, 7].includes(dueOffset) ? dueOffset : -1,
    priority: taskPriorityFromText(body),
  });
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

const naturalTelegramIntent = (value) => {
  const text = clean(value, 3000).toLocaleLowerCase('ru');
  if (/\b(этап|этапы|стадии|ход работ)\b/u.test(text)) return 'stages';
  if (/\b(выполненн|завершенн|сделанн).{0,20}\b(задач|работ)|\bчто (сделано|выполнено)\b/u.test(text)) return 'done';
  if (/\b(расход|доход|финанс|деньг|оплачен|получен)/u.test(text)) return 'finance';
  if (/\b(задач|дела).{0,20}\b(открыт|текущ|актив)|\bчто делать\b/u.test(text)) return 'tasks';
  if (/\b(статус|состояние|что на объекте)\b/u.test(text)) return 'status';
  return '';
};

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

const telegramSelectProject = async (message, binding, env) => {
  const bindings = await bindingsForTelegramUser(env.DB, String(message.from.id));
  if (bindings.length <= 1) {
    const { snapshot } = await projectForBinding(env, binding);
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, `Текущий объект: ${snapshot.state.project?.name ?? snapshot.state.project?.code}`);
    return;
  }
  const projects = [];
  for (const item of bindings.slice(0, 12)) {
    const snapshot = await readSnapshot(env.DB, item.project_id);
    if (snapshot) projects.push({ id: item.project_id, name: snapshot.state.project?.name ?? snapshot.state.project?.code ?? item.project_id });
  }
  const draft = await createTelegramDraft(env.DB, String(message.from.id), String(message.chat.id), binding.project_id, 'project', { projects });
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Выберите объект для этого чата:', {
    reply_markup: { inline_keyboard: projects.map((item, index) => [{ text: item.name, callback_data: `ps|${draft.id}|${index}` }]) },
  });
};

const telegramAttachmentDraft = async (message, binding, env) => {
  const caption = clean(message.caption, 1200);
  const captionCommand = commandFromText(caption);
  const isPrivate = message.chat?.type === 'private';
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
    telegramFileId: source.file_id,
    fileName: fallbackName,
    mimeType: clean(document?.mime_type || voice?.mime_type || (photo ? 'image/jpeg' : ''), 120),
    fileSize: Number(document?.file_size || voice?.file_size || photo?.file_size) || 0,
    note,
    category,
    typeLabel,
    telegramMessageId: String(message.message_id ?? ''),
  });
  const card = renderFileDraft(draft);
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, card.text, { reply_markup: card.replyMarkup });
};

const telegramHandleCommand = async (message, binding, command, env) => {
  if (command.name === 'task') return telegramTaskDraft(message, binding, command.body, env);
  if (command.name === 'tasks') return telegramTasks(message, binding, env);
  if (command.name === 'stages') return telegramStages(message, binding, env);
  if (command.name === 'done') return telegramCompletedTasks(message, binding, env);
  if (command.name === 'finance') return telegramFinance(message, binding, env);
  if (command.name === 'status') return telegramProjectStatus(message, binding, env);
  if (command.name === 'camera') return telegramCamera(message, binding, env);
  if (command.name === 'project') return telegramSelectProject(message, binding, env);
  if (command.name === 'doc') {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Пришлите файл в личный чат с ботом. В общем чате приложите к документу подпись /doc. Бот покажет категорию и попросит подтверждение.');
    return;
  }
  if (command.name === 'report') {
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Пришлите фото или голосовое сообщение в личный чат. В общем чате добавьте подпись /report и комментарий. Запись попадёт в дневник объекта только после подтверждения.');
    return;
  }
  const { user } = await projectForBinding(env, binding);
  await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, telegramHelp(user.role));
};

const telegramHandleMessage = async (message, env) => {
  if (!message?.chat?.id || !message?.from?.id || message.from.is_bot) return;
  const command = commandFromText(message.text);
  if (command?.name === 'start' && command.body) {
    await bindTelegramUser(message, command.body, env);
    return;
  }
  const binding = await bindingForTelegramUser(env.DB, String(message.from.id), String(message.chat.id));
  if (!binding) {
    if (message.chat.type === 'private') {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Ваш Telegram пока не связан с ИКИОМА ОС. Руководитель может выпустить персональную ссылку в «Настройки → Доступы».');
    }
    return;
  }
  if (message.document || message.photo || message.voice) {
    await telegramAttachmentDraft(message, binding, env);
    return;
  }
  if (command) {
    await telegramHandleCommand(message, binding, command, env);
    return;
  }
  const botUsername = await telegramBotUsername(env);
  const rawText = clean(message.text, 3000);
  const mentioned = botUsername && new RegExp(`@${botUsername}\\b`, 'iu').test(rawText);
  const repliedToBot = Boolean(message.reply_to_message?.from?.is_bot);
  if (message.chat.type === 'private' || mentioned || repliedToBot) {
    const intent = naturalTelegramIntent(rawText.replace(botUsername ? new RegExp(`@${botUsername}\\b`, 'giu') : /$^/, '').trim());
    if (intent) {
      await telegramHandleCommand(message, binding, { name: intent, body: '' }, env);
      return;
    }
    const { user } = await projectForBinding(env, binding);
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, telegramHelp(user.role));
  }
};

const telegramConfirmTask = async (callback, draft, binding, env) => {
  const { snapshot, user } = await projectForBinding(env, binding);
  if (user.role !== 'management' || draft.kind !== 'task') throw new Error('action_denied');
  const assignee = (snapshot.state.settings?.users ?? []).find((item) => item.id === draft.payload.assigneeId && item.status !== 'disabled');
  if (!assignee) throw new Error('assignee_missing');
  const now = new Date().toISOString();
  const taskId = `task-${crypto.randomUUID()}`;
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
    history: [{
      id: `task-history-${crypto.randomUUID()}`,
      timestamp: now,
      actor: user.name,
      kind: 'created',
      text: `Создал задачу через Telegram и назначил ${assignee.name}`,
    }],
  };
  const mutation = await mutateProjectFromTelegram(
    env,
    draft.project_id,
    user.name,
    user.role,
    'telegram.task.create',
    `Создана задача «${task.title}» · ответственный ${assignee.name}`,
    (state) => {
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
  await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
  await telegramEditMessage(
    env.TELEGRAM_BOT_TOKEN,
    callback.message.chat.id,
    callback.message.message_id,
    `Задача создана\n\n${task.title}\nОтветственный: ${assignee.name}\nСрок: ${task.dueDate}\n\n${deepLink(telegramOrigin(env), draft.project_id, 'tasks', task.id)}`,
  );
  await dispatchNotifications(mutation.previous, mutation.state, env, user.name, telegramOrigin(env), `Создана задача «${task.title}»`);
};

const telegramConfirmFile = async (callback, draft, binding, env) => {
  const { user } = await projectForBinding(env, binding);
  if (!env.BUCKET) throw new Error('storage_unavailable');
  const attachment = await telegramFileToR2(
    env,
    draft.project_id,
    draft.payload.telegramFileId,
    draft.payload.fileName,
    draft.payload.mimeType,
    user.name,
  );
  const now = new Date().toISOString();
  const isDocument = draft.kind === 'document';
  const summary = isDocument ? `Загружен документ «${attachment.name}» через Telegram` : `Добавлен фотоотчёт через Telegram · ${user.name}`;
  const mutation = await mutateProjectFromTelegram(
    env,
    draft.project_id,
    user.name,
    user.role,
    isDocument ? 'telegram.document.create' : 'telegram.field_report.create',
    summary,
    (state) => {
      if (isDocument) {
        const document = {
          id: `document-${crypto.randomUUID()}`,
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
        };
        state.documents = [document, ...(state.documents ?? [])];
      } else {
        const report = {
          id: `field-report-${crypto.randomUUID()}`,
          createdAt: now,
          author: user.name,
          note: clean(draft.payload.note, 1000) || (attachment.mimeType.startsWith('audio/') ? 'Голосовой отчёт без расшифровки' : 'Фотоотчёт без комментария'),
          source: 'telegram',
          clientVisible: false,
          telegramMessageId: draft.payload.telegramMessageId,
          attachments: [attachment],
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
  await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
  await telegramEditMessage(
    env.TELEGRAM_BOT_TOKEN,
    callback.message.chat.id,
    callback.message.message_id,
    `${isDocument ? 'Документ сохранён' : 'Запись добавлена в дневник объекта'}\n\n${attachment.name}\nАвтор: ${user.name}\n\n${deepLink(telegramOrigin(env), draft.project_id, 'project')}`,
  );
  await dispatchNotifications(mutation.previous, mutation.state, env, user.name, telegramOrigin(env), summary);
};

const telegramChangeTaskStatus = async (callback, binding, taskId, action, env) => {
  const { snapshot, user } = await projectForBinding(env, binding);
  const task = (snapshot.state.tasks ?? []).find((item) => item.id === taskId);
  if (!task || (user.role !== 'management' && task.assigneeId !== user.id)) throw new Error('action_denied');
  const status = ({ ip: 'in_progress', review: 'review', wait: 'waiting', done: 'done' })[action];
  if (!status || (status === 'done' && user.role !== 'management')) throw new Error('action_denied');
  const now = new Date().toISOString();
  const mutation = await mutateProjectFromTelegram(
    env,
    binding.project_id,
    user.name,
    user.role,
    'telegram.task.status',
    `Задача «${task.title}» → ${taskStatusLabel(status)}`,
    (state) => {
      state.tasks = (state.tasks ?? []).map((item) => item.id === task.id ? {
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
  await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, `Статус: ${taskStatusLabel(status)}`);
  await telegramSend(
    env.TELEGRAM_BOT_TOKEN,
    callback.message.chat.id,
    `Задача «${task.title}» теперь: ${taskStatusLabel(status)}.\n${deepLink(telegramOrigin(env), binding.project_id, 'tasks', task.id)}`,
    status === 'done' ? {} : { reply_markup: taskActionMarkup(task.id, user.role) },
  );
  await dispatchNotifications(mutation.previous, mutation.state, env, user.name, telegramOrigin(env), `Обновлена задача «${task.title}»`);
};

const telegramHandleCallback = async (callback, env) => {
  if (!callback?.id || !callback?.from?.id || !callback?.message?.chat?.id) return;
  const parts = clean(callback.data, 200).split('|');
  const action = parts[0];
  const binding = await bindingForTelegramUser(env.DB, String(callback.from.id), String(callback.message.chat.id));
  if (!binding) {
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сначала подключите личный Telegram в ИКИОМА ОС.', true);
    return;
  }
  if (action === 'ts') {
    await telegramChangeTaskStatus(callback, binding, parts[1], parts[2], env);
    return;
  }
  const draft = await readTelegramDraft(env.DB, parts[1], String(callback.from.id));
  if (!draft) {
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Черновик уже закрыт или устарел.', true);
    return;
  }
  if (action === 'tx' || action === 'fx') {
    await updateTelegramDraft(env.DB, draft, draft.payload, 'canceled');
    await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, callback.message.chat.id, callback.message.message_id, 'Черновик отменён.');
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
    return;
  }
  if (action === 'tc') {
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Создаю задачу…');
    await telegramConfirmTask(callback, draft, binding, env);
    return;
  }
  if (action === 'fc') {
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сохраняю файл…');
    await telegramConfirmFile(callback, draft, binding, env);
    return;
  }
  if (action === 'ta' || action === 'td') {
    const snapshot = await readSnapshot(env.DB, draft.project_id);
    if (!snapshot) throw new Error('project_not_found');
    if (action === 'ta') {
      const users = (snapshot.state.settings?.users ?? []).filter((user) => user.status !== 'disabled' && user.role !== 'client').slice(0, 8);
      const assignee = users[Number(parts[2])];
      if (assignee) draft.payload.assigneeId = assignee.id;
    } else {
      const offset = Number(parts[2]);
      if (![0, 1, 3, 7].includes(offset)) throw new Error('invalid_due_date');
      draft.payload.dueOffset = offset;
      draft.payload.dueDate = dateKey(addDays(new Date(), offset));
    }
    await updateTelegramDraft(env.DB, draft, draft.payload);
    const card = renderTaskDraft(draft, snapshot.state);
    await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, callback.message.chat.id, callback.message.message_id, card.text, card.replyMarkup);
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
    return;
  }
  if (action === 'ps') {
    const project = draft.payload.projects?.[Number(parts[2])];
    if (!project) throw new Error('project_not_found');
    const allowed = (await bindingsForTelegramUser(env.DB, String(callback.from.id))).some((item) => item.project_id === project.id);
    if (!allowed) throw new Error('action_denied');
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO telegram_chat_projects (chat_id, project_id, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        project_id = excluded.project_id,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).bind(String(callback.message.chat.id), project.id, now, String(callback.from.id)).run();
    await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
    await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, callback.message.chat.id, callback.message.message_id, `Текущий объект: ${project.name}`);
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
  }
};

const processTelegramUpdate = async (update, env) => {
  try {
    if (update.callback_query) return await telegramHandleCallback(update.callback_query, env);
    if (update.message) return await telegramHandleMessage(update.message, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'processing_failed';
    const userText = message === 'telegram_file_too_large'
      ? 'Файл больше 20 МБ и не может быть сохранён.'
      : message === 'storage_unavailable'
        ? 'Хранилище проекта временно недоступно.'
        : message === 'action_denied'
          ? 'Для этого действия недостаточно прав.'
          : 'Не удалось выполнить действие. Повторите через минуту.';
    if (update.callback_query?.id) {
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, update.callback_query.id, userText, true);
    } else if (update.message?.chat?.id) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, update.message.chat.id, userText);
    }
  }
};

const handleTelegramUpdate = async (request, env, context) => {
  const suppliedSecret = clean(request.headers.get('x-telegram-bot-api-secret-token'), 256);
  const expectedSecret = clean(env.TELEGRAM_WEBHOOK_SECRET, 256);
  if (!expectedSecret || suppliedSecret !== expectedSecret) return json({ ok: false, error: 'webhook_authorization_required' }, 403);
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'telegram_not_configured' }, 409);
  let update;
  try { update = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const updateId = clean(String(update?.update_id ?? ''), 80);
  if (!updateId) return json({ ok: false, error: 'invalid_update' }, 422);
  await ensureSchema(env.DB);
  await rememberTelegramChatCandidates(env.DB, update);
  const existing = await env.DB.prepare(`SELECT status FROM telegram_updates WHERE update_id = ?`).bind(updateId).first();
  if (existing?.status === 'done' || existing?.status === 'processing') return json({ ok: true, duplicate: true });
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO telegram_updates (update_id, received_at, processed_at, status, error)
    VALUES (?, ?, NULL, 'processing', NULL)
    ON CONFLICT(update_id) DO UPDATE SET
      received_at = excluded.received_at,
      processed_at = NULL,
      status = 'processing',
      error = NULL
  `).bind(updateId, now).run();
  const work = processTelegramUpdate(update, env)
    .then(() => env.DB.prepare(`UPDATE telegram_updates SET status = 'done', processed_at = ?, error = NULL WHERE update_id = ?`).bind(new Date().toISOString(), updateId).run())
    .catch((error) => env.DB.prepare(`UPDATE telegram_updates SET status = 'error', processed_at = ?, error = ? WHERE update_id = ?`).bind(new Date().toISOString(), clean(error instanceof Error ? error.message : 'processing_failed', 300), updateId).run());
  context.waitUntil(work);
  return json({ ok: true, accepted: true }, 202);
};

const dispatchNotifications = async (previous, next, env, actor, origin, summary) => {
  let events = notificationEvents(previous, next);
  const channels = next.settings?.notifications?.channels ?? {};
  const allActivity = next.settings?.notifications?.events?.projectActivity !== false;
  if (!events.length && allActivity && clean(summary, 300)) events = [notificationEvent(clean(summary, 300), 'overview')];
  if (!events.length) return;
  const lines = events.map((event) => `• ${event.text}\n  ${deepLink(origin, next.project.id, event.page, event.entityId)}`);
  const message = `ИКИОМА ОС · ${next.project?.code ?? 'проект'}\nИзменил: ${actor}\n\n${lines.join('\n')}`;
  const tasks = [];
  const telegramConnection = channels.telegram && env.TELEGRAM_BOT_TOKEN
    ? await resolveTelegramConnection(env)
    : null;
  const commonChatId = clean(telegramConnection?.chat?.id, 120);
  if (channels.telegram && env.TELEGRAM_BOT_TOKEN && commonChatId) tasks.push(telegramSend(env.TELEGRAM_BOT_TOKEN, commonChatId, message));
  if (channels.telegram && env.TELEGRAM_BOT_TOKEN) {
    const users = new Map((next.settings?.users ?? []).map((user) => [clean(user.id, 100), user]));
    const directByChat = new Map();
    for (const event of events) {
      if (!event.recipientId) continue;
      const user = users.get(clean(event.recipientId, 100));
      let chatId = clean(user?.telegramChatId, 120);
      if (!chatId && env.DB && user?.id) {
        try {
          const binding = await env.DB.prepare(`
            SELECT private_chat_id
            FROM telegram_bindings
            WHERE project_id = ? AND system_user_id = ?
            ORDER BY updated_at DESC
            LIMIT 1
          `).bind(next.project.id, user.id).first();
          chatId = clean(binding?.private_chat_id, 120);
        } catch {
          chatId = '';
        }
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
      tasks.push(telegramSend(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        personalText,
        taskEvent ? { reply_markup: taskActionMarkup(taskEvent.entityId, taskEvent.role) } : {},
      ));
    }
  }
  if (channels.email && env.RESEND_API_KEY && env.EMAIL_FROM) {
    const recipients = (next.settings?.users ?? []).filter((user) => user.status === 'active' && user.role === 'management' && /^\S+@\S+\.\S+$/.test(user.email)).map((user) => user.email);
    if (recipients.length) tasks.push(fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients, subject: `ИКИОМА ОС: требуется внимание · ${next.project?.code ?? ''}`, text: message }) }));
  }
  await Promise.allSettled(tasks);
};

const handlePutState = async (request, env, context) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_STATE_BYTES) return json({ ok: false, error: 'payload_too_large' }, 413);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const projectId = clean(payload?.projectId, 100);
  const expectedRevision = Number(payload?.expectedRevision);
  const action = clean(payload?.action, 80) || 'project_update';
  const summary = clean(payload?.summary, 300) || 'Обновлены данные проекта';
  const incomingState = payload?.state;

  if (!validProjectId(projectId)
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
    await ensureSchema(env.DB);
    const previousSnapshot = expectedRevision > 0 ? await readSnapshot(env.DB, projectId) : null;
    const authenticated = authenticatedIdentity(request, env);
    const identity = expectedRevision === 0
      ? authenticated?.isOwner ? { ...authenticated, id: 'owner', role: 'management', status: 'active' } : null
      : previousSnapshot ? projectIdentity(request, env, previousSnapshot.state) : null;
    if (!identity) return json({ ok: false, error: expectedRevision === 0 ? 'owner_required' : 'project_access_denied' }, 403);

    const actor = identity.name;
    const role = identity.role;
    const mergedState = mergeStateForRole(previousSnapshot?.state ?? null, incomingState, identity);
    const state = applyBattleAutomations(previousSnapshot?.state ?? null, mergedState, actor);
    let stateJson;
    try {
      stateJson = JSON.stringify(state);
    } catch {
      return json({ ok: false, error: 'invalid_state' }, 422);
    }
    const stateBytes = new TextEncoder().encode(stateJson).byteLength;
    if (stateBytes > MAX_STATE_BYTES) return json({ ok: false, error: 'payload_too_large' }, 413);

    let result;
    if (expectedRevision === 0) {
      result = await env.DB.prepare(`
        INSERT OR IGNORE INTO project_state (
          project_id, state_json, revision, created_at, updated_at, updated_by, updated_role
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
      `).bind(projectId, stateJson, now, now, actor, role).run();
    } else {
      result = await env.DB.prepare(`
        UPDATE project_state
        SET state_json = ?, revision = ?, updated_at = ?, updated_by = ?, updated_role = ?
        WHERE project_id = ? AND revision = ?
      `).bind(stateJson, nextRevision, now, actor, role, projectId, expectedRevision).run();
    }

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

    const notificationTask = dispatchNotifications(previousSnapshot?.state ?? null, state, env, actor, new URL(request.url).origin, summary);
    if (context?.waitUntil) context.waitUntil(notificationTask);
    else await notificationTask;

    return json({
      ok: true,
      snapshot: {
        projectId,
        revision: nextRevision,
        updatedAt: now,
        updatedBy: actor,
        updatedRole: role,
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
  if (env.DB) {
    try {
      await ensureSchema(env.DB);
      const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM telegram_bindings`).first();
      telegramBoundUsers = Number(row?.count) || 0;
    } catch {
      telegramBoundUsers = 0;
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
  try { payload = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
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
  try { payload = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
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
    'Важно: камера пока не установлена, поэтому /camera честно сообщит, что оборудование ожидается. Голосовые отчёты сохраняются как аудио; автоматическую расшифровку подключим отдельным этапом.',
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
            { command: 'status', description: 'Статус объекта' },
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
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return json({ ok: false, error: 'file_required' }, 422);
    if (Number(file.size) <= 0 || Number(file.size) > MAX_QUALITY_PHOTO_BYTES) return json({ ok: false, error: 'invalid_file_size' }, 413);
    const mimeType = clean(file.type, 120).toLocaleLowerCase('en-US');
    if (!mimeType.startsWith('image/')) return json({ ok: false, error: 'unsupported_file' }, 415);
    const name = safeFileName(file.name);
    const fileKey = `${projectId}/quality/${checkpointId}/${crypto.randomUUID()}-${name}`;
    const uploadedAt = new Date().toISOString();
    await env.BUCKET.put(fileKey, file.stream(), {
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
  } catch {
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
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    object.writeHttpMetadata(headers);
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    const filename = safeFileName(photo.fileName || photo.name || 'quality-photo');
    const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'quality-photo';
    headers.set('Content-Disposition', `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return new Response(object.body, { headers });
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
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') return json({ ok: false, error: 'file_required' }, 422);
    if (Number(file.size) <= 0 || Number(file.size) > MAX_FILE_BYTES) return json({ ok: false, error: 'invalid_file_size' }, 413);
    if (!supportedDocument(file)) return json({ ok: false, error: 'unsupported_file' }, 415);
    const name = safeFileName(file.name);
    const key = `${projectId}/${crypto.randomUUID()}-${name}`;
    const uploadedAt = new Date().toISOString();
    await env.BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: clean(file.type, 120) || 'application/octet-stream' },
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
        type: clean(file.type, 120) || 'application/octet-stream',
        size: Number(file.size),
        uploadedAt,
      },
    }, 201);
  } catch {
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
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    object.writeHttpMetadata(headers);
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    const filename = safeFileName(document.fileName || document.name);
    const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'document';
    headers.set('Content-Disposition', `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
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
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    object.writeHttpMetadata(headers);
    if (object.httpEtag) headers.set('ETag', object.httpEtag);
    const filename = safeFileName(attachment.name);
    const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'field-report';
    headers.set('Content-Disposition', `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
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
  try { payload = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
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
  try { payload = await request.json(); } catch { return publicLeadResponse({ ok: false, error: 'invalid_json' }, 400, origin); }

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
    try { payload = await request.json(); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
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

  if (url.pathname === '/api/health' && request.method === 'GET') {
    if (!env.DB) return json({ ok: false, database: false }, 503);
    try {
      await ensureBattleReset(env);
      return json({ ok: true, database: true, schemaVersion: BATTLE_SCHEMA_VERSION, battleReady: true });
    } catch {
      return json({ ok: false, database: false, schemaVersion: BATTLE_SCHEMA_VERSION, battleReady: false }, 503);
    }
  }
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
    try {
      await ensureBattleReset(env);
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, context);
      return serveSpa(request, env);
    } catch {
      const url = new URL(request.url);
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
};
