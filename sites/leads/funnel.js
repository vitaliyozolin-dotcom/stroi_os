import { migrateLead, monthExpired, qualificationBlockers, salesLabel, salesStages, escrowFundingBlockers } from '../../src/domain/sales-workflow.js';
import { completedSalesStage, lifecycleItemBlockers, migrateLifecycle, milestoneKeys, projectLead } from '../../src/domain/project-lifecycle.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stageKnown = stage => salesStages.some(def => def.key === stage);
const systemActor = 'ИКИОМА ОС';

export function normalizeSalesState(state, now) {
  if (!state?.project?.id) return state;
  const route = migrateLifecycle(state.project.lifecycle);
  if (route && state.project.lifecycle !== route) state.project.lifecycle = route;
  if (Array.isArray(state.leads)) state.leads = state.leads.map(lead => migrateLead(lead, now, state.activity));
  const linked = projectLead(state);
  if (linked) {
    state.project.leadOwner ??= linked.owner;
    state.project.projectManager ??= linked.projectManager;
  }
  return state;
}

// Verify milestones against the linked project while its revision and the CRM update are locked together.
export async function validateSalesWrite(before, next, db, readSnapshot, now) {
  const linked = projectLead(next);
  for (const field of ['leadOwner', 'projectManager']) {
    const value = next.project[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > 160)) return 'Проверьте имя владельца лида и менеджера проекта.';
  }
  for (const lead of next.leads ?? []) {
    const old = before?.leads?.find(row => row.id === lead.id);
    if (!stageKnown(lead.stage)) return 'Выберите статус воронки.';
    if (old?.projectId && old.projectId !== lead.projectId) return 'Связь обращения с проектом неизменяема.';
    if ([lead.owner, lead.projectManager].some(value => value !== undefined && (typeof value !== 'string' || value.length > 160))) return 'Проверьте имя ответственного.';
    if (linked === lead) {
      const oldProject = before?.project;
      if (oldProject?.leadOwner !== next.project.leadOwner) lead.owner = next.project.leadOwner || '';
      else next.project.leadOwner = lead.owner;
      if (oldProject?.projectManager !== next.project.projectManager) lead.projectManager = next.project.projectManager;
      else next.project.projectManager = lead.projectManager;
      if (before && completedSalesStage(before) !== completedSalesStage(next)) lead.stage = completedSalesStage(next);
    }
    if (!old && before && lead.source !== 'manual') {
      const inbox = await db.prepare('SELECT i.status, i.created_at, c.entered_at FROM lead_inbox i LEFT JOIN lead_status_clock c ON c.lead_id = i.id WHERE i.id = ?').bind(lead.id).first();
      if (inbox) {
        lead.stage = inbox.status; lead.stageEnteredAt = inbox.entered_at || inbox.created_at;
        continue;
      }
    }
    const changed = old?.stage !== lead.stage;
    if (lead.stage === 'qualified' && changed && qualificationBlockers(lead).length) return qualificationBlockers(lead).join(' ');
    const verifyMilestone = changed && milestoneKeys[lead.stage];
    const revisedFunding = old?.projectId && (!same(old.qualification, lead.qualification) || old.mortgageStatus !== lead.mortgageStatus);
    if (verifyMilestone || revisedFunding) {
      const target = linked === lead ? next : lead.projectId ? (await readSnapshot(db, lead.projectId))?.state : null;
      const route = target?.project.lifecycle;
      const related = route?.sourceLeadId === lead.id && target?.project.id === lead.projectId && (target === next || route.sourceProjectId === next.project.id);
      if (!related) return 'Сначала передайте заявку руководителю проекта в расчёт.';
      if (verifyMilestone) {
        if (route.items.find(item => item.key === verifyMilestone)?.status !== 'done' || completedSalesStage(target) !== lead.stage) return 'Сначала подтвердите результат в этапе 00 связанного проекта.';
        if (verifyMilestone === 'contract' && lifecycleItemBlockers(target, 'contract').length) return 'Для статуса 0.95 подтвердите подписанный договор в документах проекта.';
      }
      if (verifyMilestone === 'escrow' || revisedFunding && route.items.find(item => item.key === 'escrow')?.status === 'done') {
        const blockers = escrowFundingBlockers({ ...target, leads: target.leads.map(row => row.id === lead.id ? lead : row) });
        if (blockers.length) return blockers.join(' ');
      }
    }
    lead.stageEnteredAt = old && !changed ? old.stageEnteredAt || old.createdAt : now;
  }
  return '';
}

async function saveProjection(db, row, state, now, actor, summary) {
  const revision = Number(row.revision) + 1;
  const data = JSON.stringify(state);
  const results = await db.batch([
    db.prepare('UPDATE project_state SET state_json = ?, revision = ?, updated_at = ?, updated_by = ?, updated_role = ? WHERE project_id = ? AND revision = ?')
      .bind(data, revision, now, actor, 'management', row.project_id, row.revision),
    db.prepare(`INSERT OR IGNORE INTO audit_log (id, project_id, revision, created_at, actor, role, action, summary, state_bytes)
      SELECT ?, ?, ?, ?, ?, 'management', 'lead_workflow_updated', ?, ? WHERE EXISTS
      (SELECT 1 FROM project_state WHERE project_id = ? AND revision = ? AND state_json = ?)`)
      .bind(`lead-workflow:${row.project_id}:${revision}`, row.project_id, revision, now, actor, summary, new TextEncoder().encode(data).length, row.project_id, revision, data),
  ]);
  if (Number(results[0]?.meta?.changes ?? results[0]?.changes) !== 1) throw Error('Concurrent CRM update');
}
async function saveInboxStage(db, id, stage, enteredAt) {
  await db.batch([
    db.prepare('UPDATE lead_inbox SET status = ? WHERE id = ?').bind(stage, id),
    db.prepare(`INSERT INTO lead_status_clock (lead_id, entered_at) VALUES (?, ?)
      ON CONFLICT(lead_id) DO UPDATE SET entered_at = excluded.entered_at`).bind(id, enteredAt),
  ]);
}
const inboxQuery = 'SELECT i.id, i.status, i.created_at, c.entered_at FROM lead_inbox i LEFT JOIN lead_status_clock c ON c.lead_id = i.id';

// A submitted website lead can already be visible in several project inboxes.
// Mirror its status only; private qualification details travel solely between the source and its linked project.
export async function syncLeadCopies(db, previous, state, actor, now) {
  const updates = (state.leads ?? []).filter(lead => {
    const old = previous?.leads?.find(row => row.id === lead.id);
    return old && !same(old, lead);
  });
  if (!updates.length) return;
  const inboxIds = new Set((await db.prepare('SELECT id FROM lead_inbox').all()).results.map(row => row.id));
  const rows = (await db.prepare('SELECT project_id, state_json, revision FROM project_state WHERE project_id <> ?').bind(state.project.id).all()).results;
  for (const lead of updates) {
    if (inboxIds.has(lead.id)) await saveInboxStage(db, lead.id, lead.stage, lead.stageEnteredAt);
  }
  for (const row of rows) {
    const other = JSON.parse(row.state_json);
    const changes = [];
    for (const lead of updates) {
      const copy = other.leads?.find(item => item.id === lead.id);
      if (!copy) continue;
      const route = other.project.lifecycle;
      const isTarget = route?.sourceProjectId === state.project.id && route.sourceLeadId === lead.id && other.project.id === lead.projectId;
      const isSource = state.project.lifecycle?.sourceProjectId === other.project.id && state.project.lifecycle?.sourceLeadId === lead.id && copy.projectId === state.project.id;
      if (!isTarget && !isSource && !inboxIds.has(lead.id)) continue;
      const fields = { stage: lead.stage, stageEnteredAt: lead.stageEnteredAt };
      if (isTarget || isSource) {
        for (const key of ['owner', 'projectManager', 'qualification', 'budget', 'region', 'houseArea', 'mortgageStatus', 'landStatus']) fields[key] = lead[key];
      }
      if (Object.entries(fields).every(([key, value]) => same(copy[key], value))) continue;
      Object.assign(copy, fields);
      if (isTarget) Object.assign(other.project, { leadOwner: lead.owner, projectManager: lead.projectManager });
      changes.push(salesLabel(lead.stage));
    }
    if (changes.length) await saveProjection(db, row, other, now, actor, 'Обновлена заявка: ' + [...new Set(changes)].join(', '));
  }
}

// Each run is idempotent, shares the project write lock, and works with the application closed.
export async function maintainLeadFunnel(db, now = new Date().toISOString()) {
  const run = async tx => {
    const inbox = (await tx.prepare(inboxQuery).all()).results;
    const rows = (await tx.prepare('SELECT project_id, state_json, revision FROM project_state').all()).results;
    const states = rows.map(row => normalizeSalesState(JSON.parse(row.state_json), now));
    const canonical = new Map(inbox.map(row => [row.id, { stage: stageKnown(row.status) ? row.status : 'new', stageEnteredAt: row.entered_at || row.created_at }]));
    for (const state of states) for (const lead of state.leads ?? []) {
      const candidate = canonical.get(lead.id);
      if (candidate && Date.parse(lead.stageEnteredAt) > Date.parse(candidate.stageEnteredAt)) canonical.set(lead.id, { stage: lead.stage, stageEnteredAt: lead.stageEnteredAt });
    }
    const age = lead => lead.stage === 'new' && monthExpired(lead.stageEnteredAt, now) ? { stage: 'deferred', stageEnteredAt: now } : lead;
    for (const row of inbox) {
      const value = age(canonical.get(row.id));
      canonical.set(row.id, value);
      if (row.status !== value.stage || row.entered_at !== value.stageEnteredAt) await saveInboxStage(tx, row.id, value.stage, value.stageEnteredAt);
    }
    for (const [i, state] of states.entries()) {
      if (!state?.project?.id || state.project.id.startsWith('__')) continue;
      let expired = 0;
      for (const lead of state.leads ?? []) {
        const value = canonical.get(lead.id) || age(lead);
        if (lead.stage === 'new' && value.stage === 'deferred') expired++;
        Object.assign(lead, { stage: value.stage, stageEnteredAt: value.stageEnteredAt });
      }
      if (JSON.stringify(state) === rows[i].state_json) continue;
      const summary = expired ? `Переведено в отложенный спрос: ${expired}` : 'Обновлён маршрут проекта и статусы заявок';
      await saveProjection(tx, rows[i], state, now, systemActor, summary);
    }
  };
  return db.financialTransaction ? db.financialTransaction(run) : run(db);
}
