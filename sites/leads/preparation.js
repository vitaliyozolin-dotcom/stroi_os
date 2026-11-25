import { syncLeadCopies } from './funnel.js';
import { authenticatedIdentity, projectIdentity } from '../access-control.js';
import { validateOrderDirectoryReferences } from '../orders/directory.js';
import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { clean, validProjectId } from '../lib/validation.js';
import { createLeadProjectState, leadHandoffBlockers, leadProjectIdentity, validateLifecycleChanges } from '../../src/domain/project-lifecycle.js';

/** Deterministic target ID makes lost responses and repeated CRM handoffs safe. */
export const createLeadPreparationHandler = ({ ensureSchema, readSnapshot }) => async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const authenticated = authenticatedIdentity(request, env);
  // Reuse the existing permission to create projects; do not silently grant it to a manager.
  if (!authenticated?.isOwner) return json({ ok: false, error: 'owner_required', message: 'Создание нового проекта доступно владельцу.' }, 403);
  let payload;
  try { payload = await readJsonBodyLimited(request, 32 * 1024); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const sourceId = clean(payload?.sourceProjectId, 100), leadId = clean(payload?.leadId, 100);
  if (!validProjectId(sourceId) || !leadId) return json({ ok: false, error: 'invalid_lead' }, 422);
  try {
    await ensureSchema(env.DB);
    const run = async db => {
      const source = await readSnapshot(db, sourceId);
      const identity = source ? projectIdentity(request, env, source.state) : null;
      if (!identity || identity.role !== 'management') return json({ ok: false, error: 'project_access_denied' }, 403);
      const lead = source.state.leads?.find(row => row.id === leadId);
      if (!lead) return json({ ok: false, error: 'lead_not_found' }, 404);
      const target = await leadProjectIdentity(lead.id);
      const existing = await readSnapshot(db, target.id);
      const linkSource = async (targetState, preparedAt) => {
        if (lead.projectId && lead.projectId !== targetState.project.id) return { error: 'Обращение уже связано с другим проектом.' };
        if (lead.projectId === targetState.project.id) return { snapshot: { ...source, projectId: sourceId } };
        const sourceState = structuredClone(source.state);
        sourceState.leads = sourceState.leads.map(row => row.id === lead.id ? { ...row, projectId: targetState.project.id, stage: 'preparation', stageEnteredAt: preparedAt, preparedAt } : row);
        sourceState.activity = [{ id: `lead-prepared:${lead.id}`, timestamp: preparedAt, actor: identity.name, text: `Обращение передано в проект ${targetState.project.code}.`, tone: 'positive' }, ...(sourceState.activity ?? [])];
        const stateJson = JSON.stringify(sourceState);
        const result = await db.batch([
          db.prepare('UPDATE project_state SET state_json = ?, revision = ?, updated_at = ?, updated_by = ?, updated_role = ? WHERE project_id = ? AND revision = ?').bind(stateJson, source.revision + 1, preparedAt, identity.name, 'management', sourceId, source.revision),
          db.prepare("INSERT OR IGNORE INTO audit_log (id, project_id, revision, created_at, actor, role, action, summary, state_bytes) VALUES (?, ?, ?, ?, ?, 'management', 'lead_project_linked', ?, ?)").bind(`lead-linked:${targetState.project.id}`, sourceId, source.revision + 1, preparedAt, identity.name, `Обращение ${lead.id} связано с проектом ${targetState.project.code}`, new TextEncoder().encode(stateJson).length),
        ]);
        if (Number(result?.[0]?.meta?.changes ?? result?.[0]?.changes ?? 0) !== 1) return { error: 'Карточка изменилась. Обновите данные.' };
        await syncLeadCopies(db, source.state, sourceState, identity.name, preparedAt);
        return { snapshot: { state: sourceState, revision: source.revision + 1, projectId: sourceId, updatedAt: preparedAt, updatedBy: identity.name, updatedRole: 'management' } };
      };
      if (!env.DB.financialTransaction) return json({ ok: false, error: 'transaction_required' }, 503);
      if (existing) {
        if (existing.state.project?.lifecycle?.sourceLeadId !== leadId || existing.state.project?.lifecycle?.sourceProjectId !== sourceId) return json({ ok: false, error: 'lead_project_conflict' }, 409);
        const linked = await linkSource(existing.state, existing.state.project.createdAt);
        if (linked.error) return json({ ok: false, error: 'lead_project_conflict', message: linked.error }, 409);
        return json({ sourceSnapshot: linked.snapshot, ok: true, created: false, project: { id: existing.state.project.id, code: existing.state.project.code, name: existing.state.project.name }, preparedAt: existing.state.project.createdAt });
      }
      if (lead.stage !== 'qualified') return json({ ok: false, error: 'qualification_required', message: 'Перед передачей в расчёт квалифицируйте заявку до статуса 0.6.' }, 422);
      if (payload.expectedLead !== JSON.stringify(lead)) return json({ ok: false, error: 'lead_changed', message: 'Дождитесь сохранения карточки и повторите передачу.' }, 409);
      const blockers = leadHandoffBlockers(lead);
      if (blockers.length) return json({ ok: false, error: 'lead_incomplete', message: blockers.join(' ') }, 422);
      if (!env.DB.financialTransaction) return json({ ok: false, error: 'transaction_required' }, 503);
      const rows = await db.prepare('SELECT state_json FROM project_state').all();
      const codes = (rows?.results ?? []).flatMap(row => { try { return [JSON.parse(row.state_json)?.project?.code]; } catch { return []; } });
      const nextNumber = codes.reduce((max, code) => /^H-\d+$/.test(code ?? '') ? Math.max(max, Number(code.slice(2))) : max, 0) + 1;
      target.code = `H-${String(nextNumber).padStart(3, '0')}`;
      const now = new Date().toISOString();
      const state = createLeadProjectState(source.state, lead, target, identity.name, now);
      const directoryError = state.orderRelations?.objects?.length ? await validateOrderDirectoryReferences({ db, request, env, previousState: null, nextState: state }) : ''; 
      if (directoryError) return json({ ok: false, error: 'invalid_order_references', message: directoryError }, 422);
      const error = validateLifecycleChanges(null, state, identity, now);
      if (error) return json({ ok: false, error: 'invalid_project_lifecycle', message: error }, 422);
      const stateJson = JSON.stringify(state);
      const results = await db.batch([
        db.prepare(`INSERT OR IGNORE INTO project_state (project_id, state_json, revision, created_at, updated_at, updated_by, updated_role) VALUES (?, ?, 1, ?, ?, ?, 'management')`).bind(target.id, stateJson, now, now, identity.name),
        db.prepare(`INSERT OR IGNORE INTO audit_log (id, project_id, revision, created_at, actor, role, action, summary, state_bytes) VALUES (?, ?, 1, ?, ?, 'management', 'lead_project_created', ?, ?)`).bind(`lead-created:${target.id}`, target.id, now, identity.name, `Проект ${target.code} создан из обращения ${lead.id}`, new TextEncoder().encode(stateJson).length),
      ]);
      if (Number(results?.[0]?.meta?.changes ?? results?.[0]?.changes ?? 0) !== 1) return json({ ok: false, error: 'revision_conflict' }, 409);
      const linked = await linkSource(state, now);
      if (linked.error) return json({ ok: false, error: 'revision_conflict', message: linked.error }, 409);
      return json({ sourceSnapshot: linked.snapshot, ok: true, created: true, project: { id: state.project.id, code: state.project.code, name: state.project.name }, preparedAt: now }, 201);
    };
    return env.DB.financialTransaction ? await env.DB.financialTransaction(run) : await run(env.DB);
  } catch { return json({ ok: false, error: 'storage_error' }, 500); }
};
