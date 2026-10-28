import { authenticatedIdentity, projectIdentity } from '../access-control.js';
import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { validTreasuryDate, validateTreasuryChanges } from '../../src/domain/treasury.js';
import { validateFinanceLedgerChanges } from '../../src/domain/finance-ledger.js';
import { validateFinanceAutomationChanges } from '../../src/domain/finance-automation.js';
import { validatePortfolioWrite } from '../../src/domain/finance-portfolio.js';

const validKey = value => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,120}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const scopeKey = row => JSON.stringify([row.projectId, row.accountId]);
const changes = result => Number(result?.meta?.changes ?? result?.changes ?? 0);
const readProjects = async db => {
  const result = await db.prepare('SELECT project_id, state_json, revision FROM project_state ORDER BY project_id LIMIT 501').all();
  if ((result?.results ?? []).length > 500) return null;
  return (result?.results ?? []).map(row => ({ projectId: row.project_id, revision: Number(row.revision), state: JSON.parse(row.state_json) }));
};
const groupFor = (rows, key) => rows.flatMap(row => (row.state.treasury?.accounts ?? [])
  .filter(account => !account.isProjectDedicated && account.sharedAccountKey === key)
  .map(account => ({ ...row, accountId: account.id, account })));
const preview = (key, group) => ({
  sharedAccountKey: key, legalEntityId: group[0].account.legalEntityId, currency: group[0].account.currency,
  opening: group[0].account.opening ?? null, restrictedCents: group[0].account.restrictedCents ?? 0,
  projects: group.map(row => ({ projectId: row.projectId, projectName: row.state.project.name || row.projectId,
    accountId: row.accountId, accountName: row.account.name, revision: row.revision, allocationCents: row.account.projectAllocationCents ?? 0 })),
});
const scopeAllowed = (request, env, group) => group.length > 0 && group.every(row => projectIdentity(request, env, row.state)?.role === 'management');
const denied = () => json({ ok: false, error: 'project_access_denied', message: 'Изменение общего счёта требует управления всеми связанными проектами.' }, 403);
const conflict = () => json({ ok: false, error: 'revision_conflict', message: 'Состав проектов или их данные изменились. Обновите общий счёт и проверьте распределение заново.' }, 409);

/** A shared balance is updated as one unit of work across every linked project. */
export const createSharedFinanceAccountHandler = ({ ensureSchema }) => async (request, env) => {
  if (!env.DB) return json({ ok: false, error: 'storage_unavailable' }, 503);
  if (!authenticatedIdentity(request, env)) return denied();
  if (request.method === 'GET') {
    const key = new URL(request.url).searchParams.get('key');
    if (!validKey(key)) return json({ ok: false, error: 'invalid_shared_account_key' }, 422);
    try {
      await ensureSchema(env.DB);
      const rows = await readProjects(env.DB);
      if (!rows) return json({ ok: false, error: 'portfolio_scope_too_large' }, 422);
      const group = groupFor(rows, key);
      if (!scopeAllowed(request, env, group)) return denied();
      return json({ ok: true, sharedAccount: preview(key, group) });
    } catch { return json({ ok: false, error: 'storage_error' }, 500); }
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'not_found' }, 404);
  if (!env.DB.financialTransaction) return json({ ok: false, error: 'financial_transaction_unavailable' }, 503);
  let input;
  try { input = await readJsonBodyLimited(request, 256 * 1024); }
  catch (error) { return json({ ok: false, error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json' }, error?.message === 'payload_too_large' ? 413 : 400); }
  if (!validKey(input?.sharedAccountKey) || !text(input.legalEntityId, 200) || input.currency !== 'RUB'
    || !text(input.reason, 2000) || !nonnegative(input.restrictedCents)
    || !validTreasuryDate(input.opening?.asOf) || !nonnegative(input.opening?.amountCents) || input.opening?.confirmed !== true || !text(input.opening?.source, 4000)
    || !Array.isArray(input.expected) || !input.expected.length || input.expected.length > 500
    || !Array.isArray(input.allocations) || input.allocations.length !== input.expected.length
    || input.expected.some(row => !row || !text(row.projectId, 100) || !text(row.accountId, 200) || !Number.isSafeInteger(row.revision) || row.revision < 1)
    || input.allocations.some(row => !row || !text(row.projectId, 100) || !text(row.accountId, 200) || !nonnegative(row.amountCents))
    || new Set(input.expected.map(scopeKey)).size !== input.expected.length || new Set(input.allocations.map(scopeKey)).size !== input.allocations.length) {
    return json({ ok: false, error: 'invalid_shared_account', message: 'Проверьте счёт, подтверждённый остаток, ограничения, распределение и основание изменения.' }, 422);
  }
  try {
    await ensureSchema(env.DB);
    return await env.DB.financialTransaction(async db => {
      const rows = await readProjects(db);
      if (!rows) return json({ ok: false, error: 'portfolio_scope_too_large' }, 422);
      const group = groupFor(rows, input.sharedAccountKey);
      if (!scopeAllowed(request, env, group)) return denied();
      const expected = new Map(input.expected.map(row => [scopeKey(row), row.revision]));
      const allocations = new Map(input.allocations.map(row => [scopeKey(row), row.amountCents]));
      if (group.length !== expected.size || group.some(row => expected.get(scopeKey(row)) !== row.revision || !allocations.has(scopeKey(row)))) return conflict();
      // Duplicate aliases within one project cannot be repaired by silently choosing one.
      if (new Set(group.map(row => row.projectId)).size !== group.length) return json({ ok: false, error: 'invalid_shared_account', message: 'Общий счёт указан в проекте несколько раз. Сначала устраните дубли.' }, 422);
      const now = new Date().toISOString(), candidates = new Map();
      for (const row of group) {
        const state = structuredClone(row.state), identity = projectIdentity(request, env, row.state);
        const account = state.treasury.accounts.find(item => item.id === row.accountId);
        Object.assign(account, { legalEntityId: input.legalEntityId.trim(), currency: 'RUB',
          opening: { asOf: input.opening.asOf, amountCents: input.opening.amountCents, confirmed: true, source: input.opening.source.trim() },
          restrictedCents: input.restrictedCents, projectAllocationCents: allocations.get(scopeKey(row)) });
        state.treasury.changeReason = input.reason.trim();
        const treasuryError = validateTreasuryChanges(row.state, state, identity, now);
        if (treasuryError) return json({ ok: false, error: 'invalid_treasury_transition', message: treasuryError }, 422);
        const ledgerError = validateFinanceLedgerChanges(row.state, state, identity, now);
        if (ledgerError) return json({ ok: false, error: 'invalid_finance_ledger', message: ledgerError }, 422);
        const automationError = validateFinanceAutomationChanges(row.state, state, identity, now);
        if (automationError) return json({ ok: false, error: 'invalid_finance_automation', message: automationError }, 422);
        candidates.set(row.projectId, { ...row, state, account, revision: row.revision + 1, identity });
      }
      const portfolio = rows.map(row => candidates.get(row.projectId)?.state ?? row.state);
      for (const row of group) {
        const next = candidates.get(row.projectId);
        const error = validatePortfolioWrite(row.state, next.state, portfolio.filter(state => state.project.id !== row.projectId));
        if (error) return json({ ok: false, error: 'invalid_portfolio_finance', message: error }, 422);
      }
      const statements = [];
      for (const next of candidates.values()) {
        const stateJson = JSON.stringify(next.state), stateBytes = new TextEncoder().encode(stateJson).byteLength;
        if (stateBytes > 6_000_000) return json({ ok: false, error: 'payload_too_large' }, 413);
        statements.push(db.prepare('UPDATE project_state SET state_json = ?, revision = ?, updated_at = ?, updated_by = ?, updated_role = ? WHERE project_id = ? AND revision = ?')
          .bind(stateJson, next.revision, now, next.identity.name, 'management', next.projectId, next.revision - 1));
        statements.push(db.prepare(`INSERT INTO audit_log (id, project_id, revision, created_at, actor, role, action, summary, state_bytes)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM project_state WHERE project_id = ? AND revision = ? AND state_json = ?)
          ON CONFLICT(id) DO NOTHING`).bind(`shared-account:${next.projectId}:${next.revision}`, next.projectId, next.revision, now,
          next.identity.name, 'management', 'shared_account_updated', input.reason.trim().slice(0, 300), stateBytes, next.projectId, next.revision, stateJson));
      }
      const results = await db.batch(statements);
      if ([...candidates.values()].some((_row, index) => changes(results?.[index * 2]) !== 1 || changes(results?.[index * 2 + 1]) !== 1)) return conflict();
      return json({ ok: true, sharedAccount: preview(input.sharedAccountKey, [...candidates.values()]) });
    });
  } catch { return json({ ok: false, error: 'storage_error' }, 500); }
};
