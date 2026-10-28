import {
  authenticatedIdentity,
  mergeStateForRole,
  projectIdentity,
  stateForRole,
} from '../access-control.js';
import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { clean, validProjectId } from '../lib/validation.js';
import { validateFinanceChanges } from './finance.js';
import { validateBaselineChanges } from './baseline.js';
import { validateStageControl } from './stage-control.js';
import { validateTreasuryChanges } from '../../src/domain/treasury.js';
import { validateFinanceLedgerChanges, validateFinanceLedgerShape } from '../../src/domain/finance-ledger.js';
import { validateFinanceAutomationChanges } from '../../src/domain/finance-automation.js';
import { requiresPortfolioCheck, validatePortfolioWrite } from '../../src/domain/finance-portfolio.js';

const MAX_STATE_BYTES = 6_000_000;
const MAX_JSON_BODY_BYTES = 32 * 1024;

export const createProjectWriteHandler = ({
  ensureSchema,
  readSnapshot,
  changes,
  applyAutomations,
  buildNotificationPlan,
  dispatchNotifications,
}) => {
const write = async (request, env, context, atomicFinance = false, afterCommit, notificationEnv = env) => {
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
    const stageError = validateStageControl(previousSnapshot?.state ?? null, mergedState, identity, now);
    if (stageError) return json({ ok: false, error: 'invalid_stage_transition', message: stageError }, 422);
    const baselineError = validateBaselineChanges(previousSnapshot?.state ?? null, mergedState, identity, now);
    if (baselineError) return json({ ok: false, error: 'invalid_baseline_transition', message: baselineError }, 422);
    // Shape validation protects the read calculations before legacy payment events
    // are stamped. Full settlement validation must see those authoritative events.
    const ledgerShapeError = validateFinanceLedgerShape(mergedState.financeLedger);
    if (ledgerShapeError) return json({ ok: false, error: 'invalid_finance_ledger', message: ledgerShapeError }, 422);
    const financeError = validateFinanceChanges(previousSnapshot?.state ?? null, mergedState, identity, now);
    if (financeError) return json({ ok: false, error: 'invalid_finance_transition', message: financeError }, 422);
    const ledgerError = validateFinanceLedgerChanges(previousSnapshot?.state ?? null, mergedState, identity, now);
    if (ledgerError) return json({ ok: false, error: 'invalid_finance_ledger', message: ledgerError }, 422);
    const treasuryError = validateTreasuryChanges(previousSnapshot?.state ?? null, mergedState, identity, now);
    if (treasuryError) return json({ ok: false, error: 'invalid_treasury_transition', message: treasuryError }, 422);
    const automationError = validateFinanceAutomationChanges(previousSnapshot?.state ?? null, mergedState, identity, now);
    if (automationError) return json({ ok: false, error: 'invalid_finance_automation', message: automationError }, 422);
    if (requiresPortfolioCheck(previousSnapshot?.state ?? null, mergedState)) {
      if (!atomicFinance) return json({ ok: false, error: 'financial_transaction_unavailable', message: 'Хранилище не поддерживает атомарную сверку нескольких проектов.' }, 503);
      const otherRows = await env.DB.prepare('SELECT state_json FROM project_state WHERE project_id <> ?').bind(projectId).all();
      const others = (otherRows?.results ?? []).map(row => JSON.parse(row.state_json));
      const portfolioError = validatePortfolioWrite(previousSnapshot?.state ?? null, mergedState, others);
      if (portfolioError) return json({ ok: false, error: 'invalid_portfolio_finance', message: portfolioError }, 422);
    }
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
    // The audit record commits in the same transaction as the state and outbox.
    // The guarded SELECT cannot write a new revision's audit on a failed CAS.
    const auditStatement = env.DB.prepare(`
      INSERT INTO audit_log (
        id, project_id, revision, created_at, actor, role, action, summary, state_bytes
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM project_state
        WHERE project_id = ? AND revision = ? AND updated_at = ? AND updated_by = ?
          AND updated_role = ? AND state_json = ?
      )
      ON CONFLICT(id) DO NOTHING
    `).bind(`project-write:${projectId}:${nextRevision}`, projectId, nextRevision, now, actor, role, action, summary, stateBytes,
      projectId, nextRevision, now, actor, role, stateJson);
    const batchResults = await env.DB.batch([stateStatement, ...outboxStatements, auditStatement]);
    if (changes(batchResults?.[0]) !== 1) {
      const current = await readSnapshot(env.DB, projectId);
      const currentIdentity = current ? projectIdentity(request, env, current.state) : null;
      const safeCurrent = current && currentIdentity
        ? { ...current, state: stateForRole(current.state, currentIdentity), updatedRole: currentIdentity.role }
        : null;
      return json({ ok: false, error: 'revision_conflict', current: safeCurrent }, 409);
    }

    // Starting an async function starts its side effects immediately. Under the
    // outer financial transaction, enqueue the callback until COMMIT succeeds and
    // use the original pool, never a released transaction-scoped client.
    const dispatch = () => dispatchNotifications(previousSnapshot?.state ?? null, state, notificationEnv, actor, new URL(request.url).origin, summary, nextRevision, notificationPlan).catch(() => null);
    if (afterCommit) afterCommit.push(dispatch);
    else context.waitUntil(dispatch());
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
return async (request, env, context) => {
  if (!env.DB?.financialTransaction) return write(request, env, context);
  try {
    const afterCommit = [];
    const response = await env.DB.financialTransaction(db => write(request, { ...env, DB: db }, context, true, afterCommit, env));
    if (response.ok) for (const dispatch of afterCommit) context.waitUntil(dispatch());
    return response;
  }
  catch { return json({ ok: false, error: 'storage_error' }, 500); }
};
};
