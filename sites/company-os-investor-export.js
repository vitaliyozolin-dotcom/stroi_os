import { verifyCompanyOsOidc } from './company-os-export.js';

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const cleanDate = (value) => typeof value === 'string' && value ? value : null;

const bearer = (request) => {
  const value = String(request.headers.get('authorization') || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
};

const parseState = (row) => {
  try {
    const state = JSON.parse(row.state_json);
    if (!state?.project?.id || String(state.project.id).startsWith('__')) return null;
    return { row, state };
  } catch {
    return null;
  }
};

const stageEvidence = (state, stageId) => {
  const checkpoints = (state.checkpoints ?? []).filter((item) => item?.stageId === stageId);
  const photos = checkpoints.reduce((sum, item) => sum + (Array.isArray(item.photos) ? item.photos.length : 0), 0);
  return {
    checkpoints: checkpoints.length,
    accepted: checkpoints.filter((item) => item.status === 'accepted').length,
    photos,
  };
};

const projectPack = ({ row, state }) => {
  const expenseEntries = (state.financeEntries ?? []).filter((item) => item?.kind === 'expense');
  const paidCost = expenseEntries.reduce((sum, item) => {
    if (Number(item.paidAmount) > 0) return sum + number(item.paidAmount);
    if (item.status === 'paid') return sum + number(item.amount);
    return sum;
  }, 0);
  const acceptedCost = expenseEntries.reduce((sum, item) => sum + number(item.acceptedAmount), 0);
  const committedCost = expenseEntries.reduce((sum, item) => {
    const paid = number(item.paidAmount) || (item.status === 'paid' ? number(item.amount) : 0);
    return sum + Math.max(0, number(item.amount) - paid);
  }, 0);
  const budgetForecast = (state.budgetLines ?? []).reduce((sum, item) => sum + number(item.forecast), 0);
  const stages = (state.stages ?? []).map((stage) => {
    const evidence = stageEvidence(state, stage.id);
    return {
      id: String(stage.id),
      name: String(stage.name || stage.shortName || stage.id),
      status: String(stage.status || 'not_ready'),
      weight: number(stage.weight),
      progress: number(stage.progress),
      plan_start: cleanDate(stage.planStart),
      plan_end: cleanDate(stage.planEnd),
      forecast_end: cleanDate(stage.forecastEnd),
      actual_end: cleanDate(stage.actualEnd),
      evidence_count: evidence.photos + evidence.accepted,
      evidence_complete: evidence.checkpoints > 0 && evidence.accepted === evidence.checkpoints,
    };
  });
  const checkpoints = state.checkpoints ?? [];
  const photosCount = checkpoints.reduce((sum, item) => sum + (Array.isArray(item.photos) ? item.photos.length : 0), 0);
  const now = Date.now();
  const overdueTasks = (state.tasks ?? []).filter((item) => {
    if (['done', 'canceled'].includes(item?.status)) return false;
    const due = Date.parse(item?.dueDate || '');
    return Number.isFinite(due) && due < now;
  }).length;
  const procurementRisks = (state.procurement ?? []).filter((item) => Boolean(String(item?.risk || '').trim())).length;

  return {
    project_id: String(state.project.id),
    project: `ИКИОМА · ${state.project.code || state.project.name || state.project.id}`,
    code: state.project.code || null,
    model: state.project.model || null,
    area_m2: number(state.project.area),
    contract_value_rub: Math.round(number(state.project.contractValue)),
    target_cost_rub: Math.round(number(state.project.targetCost)),
    forecast_cost_rub: Math.round(budgetForecast || number(state.project.targetCost)),
    paid_cost_rub: Math.round(paidCost),
    accepted_cost_rub: Math.round(acceptedCost),
    committed_cost_rub: Math.round(committedCost),
    start_date: cleanDate(state.project.startDate),
    target_date: cleanDate(state.project.targetDate),
    forecast_date: cleanDate(state.project.forecastDate),
    stages,
    quality: {
      photos_count: photosCount,
      checkpoints_total: checkpoints.length,
      checkpoints_accepted: checkpoints.filter((item) => item.status === 'accepted').length,
    },
    documents_count: Array.isArray(state.documents) ? state.documents.length : 0,
    procurement: { risk_count: procurementRisks },
    tasks: { overdue_count: overdueTasks },
    source_ref: `ikioma:${state.project.id}:revision:${row.revision}`,
  };
};

export const buildIkiomaInvestorPayload = ({ stateRows = [], generatedAt = new Date().toISOString() } = {}) => ({
  meta: {
    project: 'ikioma-investor',
    generated_at: generatedAt,
    schema_version: 1,
    source_of_truth: 'IKIOMA OS PostgreSQL',
    privacy: 'no_customer_pii_no_address_no_raw_media',
  },
  adapter_sources: [],
  finance_projects: [],
  sales_opportunities: [],
  investor_projects: stateRows.map(parseState).filter(Boolean).map(projectPack),
  owner_exceptions: [],
});

export const buildIkiomaInvestorExport = async (env) => {
  const result = await env.DB.prepare(`
    SELECT project_id, state_json, revision, updated_at
    FROM project_state
    ORDER BY updated_at DESC
    LIMIT 100
  `).all();
  return buildIkiomaInvestorPayload({ stateRows: result?.results ?? [] });
};

export const handleCompanyOsInvestorExport = async (request, env) => {
  if (request.method !== 'GET') return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  if (!env.DB) return Response.json({ ok: false, error: 'storage_unavailable' }, { status: 503 });
  try {
    await verifyCompanyOsOidc(bearer(request));
  } catch {
    return Response.json({ ok: false, error: 'company_os_auth_required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const payload = await buildIkiomaInvestorExport(env);
    return Response.json({ ok: true, ...payload }, {
      headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch {
    return Response.json({ ok: false, error: 'export_failed' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
};
