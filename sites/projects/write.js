import {
  authenticatedIdentity,
  mergeStateForRole,
  projectIdentity,
  stateForRole,
} from '../access-control.js';
import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { clean, validProjectId } from '../lib/validation.js';

const MAX_STATE_BYTES = 6_000_000;
const MAX_JSON_BODY_BYTES = 32 * 1024;

export const createProjectWriteHandler = ({
  ensureSchema,
  readSnapshot,
  changes,
  applyAutomations,
  buildNotificationPlan,
  dispatchNotifications,
}) => async (request, env, context) => {
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
    const state = applyAutomations(previousSnapshot?.state ?? null, mergedState, actor);
    let stateJson;
    try {
      stateJson = JSON.stringify(state);
    } catch {
      return json({ ok: false, error: 'invalid_state' }, 422);
    }
    const stateBytes = new TextEncoder().encode(stateJson).byteLength;
    if (stateBytes > MAX_STATE_BYTES) return json({ ok: false, error: 'payload_too_large' }, 413);

    const notificationPlan = await buildNotificationPlan(previousSnapshot?.state ?? null, state, env, actor, new URL(request.url).origin, summary, nextRevision);
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
        SELECT 1 FROM project_state
        WHERE project_id = ? AND revision = ? AND updated_at = ? AND updated_by = ?
          AND updated_role = ? AND state_json = ?
      )
      ON CONFLICT(id) DO NOTHING
    `).bind(delivery.stableId, String(delivery.chatId), delivery.text, JSON.stringify(delivery.options ?? {}), now, now, projectId, nextRevision, now, actor, role, stateJson));
    const batchResults = await env.DB.batch([stateStatement, ...outboxStatements]);
    if (changes(batchResults?.[0]) !== 1) {
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

    context.waitUntil(dispatchNotifications(previousSnapshot?.state ?? null, state, env, actor, new URL(request.url).origin, summary, nextRevision, notificationPlan).catch(() => null));
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
