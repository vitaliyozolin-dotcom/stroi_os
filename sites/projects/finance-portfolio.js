import { projectIdentity } from '../access-control.js';
import { json } from '../lib/http.js';
import { financePortfolio } from '../../src/domain/finance-portfolio.js';
import { validTreasuryDate } from '../../src/domain/treasury.js';

export const createFinancePortfolioHandler = ({ ensureSchema }) => async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  const url = new URL(request.url);
  const today = url.searchParams.get('asOf') || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const horizonDays = Number(url.searchParams.get('horizon') || 91), scenario = url.searchParams.get('scenario') || 'base';
  if (!validTreasuryDate(today) || !Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > 1095
    || !['base', 'cautious', 'stress'].includes(scenario)) return json({ ok: false, error: 'invalid_finance_range' }, 422);
  const selected = url.searchParams.has('projects') ? new Set(url.searchParams.get('projects').split(',').filter(Boolean)) : null;
  try {
    await ensureSchema(env.DB);
    const rows = await env.DB.prepare('SELECT state_json FROM project_state ORDER BY project_id LIMIT 501').all();
    if ((rows?.results ?? []).length > 500) return json({ ok: false, error: 'portfolio_scope_too_large' }, 422);
    const states = (rows?.results ?? []).flatMap(row => {
      const state = JSON.parse(row.state_json), identity = projectIdentity(request, env, state);
      if (identity?.role !== 'management' || state.project?.status === 'workspace' || String(state.project?.id).startsWith('__')) return [];
      return !selected || selected.has(state.project.id) ? [state] : [];
    });
    if (!states.length) return json({ ok: false, error: 'project_access_denied' }, 403);
    return json({ ok: true, portfolio: financePortfolio(states, { today, horizonDays, scenario }) });
  } catch { return json({ ok: false, error: 'storage_error' }, 500); }
};
