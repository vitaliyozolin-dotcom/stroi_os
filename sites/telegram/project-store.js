import { validateBaselineChanges } from '../projects/baseline.js';
import { validateStageControl } from '../projects/stage-control.js';
import { validateFinanceChanges } from '../projects/finance.js';
import { validateSharedPaymentWrite } from '../projects/shared-payment.js';
import { validateFinanceLedgerChanges, validateFinanceLedgerShape } from '../../src/domain/finance-ledger.js';
import { validateTreasuryChanges } from '../../src/domain/treasury.js';
import { validateOrderRelationsChanges } from '../../src/domain/order-relations.js';
import { validateFinanceAutomationChanges } from '../../src/domain/finance-automation.js';
import { requiresPortfolioCheck, validatePortfolioWrite } from '../../src/domain/finance-portfolio.js';

const MAX_STATE_BYTES = 6_000_000;

export const createTelegramProjectStore = ({ ensureSchema, readSnapshot, changes, mutationNoop }) => {
  const listSnapshots = async (db) => {
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

  const mutateWithinTransaction = async (env, projectId, actor, role, action, summary, mutation, atomicFinance) => {
    await ensureSchema(env.DB);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await readSnapshot(env.DB, projectId);
      if (!snapshot) throw new Error('project_not_found');
      const previous = snapshot.state;
      const next = JSON.parse(JSON.stringify(previous));
      const resultState = await mutation(next);
      if (resultState === mutationNoop) {
        return { previous, state: previous, revision: snapshot.revision, updatedAt: snapshot.updatedAt, changed: false };
      }
      const state = resultState ?? next;
      const now = new Date().toISOString();
      if (JSON.stringify(previous.orderRelations) !== JSON.stringify(state.orderRelations)) throw new Error('Для изменения связей заказа откройте карточку заказа в системе.');
      const orderError = validateOrderRelationsChanges(previous, state, { role, name: actor }, now);
      if (orderError) throw new Error(`invalid_order_relations: ${orderError}`);
      const ledgerShapeError = validateFinanceLedgerShape(state.financeLedger);
      if (ledgerShapeError) throw new Error(`invalid_finance_ledger: ${ledgerShapeError}`);
      const stageError = validateStageControl(previous, state, { role, name: actor }, now);
      if (stageError) throw new Error(`invalid_stage_transition: ${stageError}`);
      const baselineError = validateBaselineChanges(previous, state, { role, name: actor }, now);
      if (baselineError) throw new Error(`invalid_baseline_transition: ${baselineError}`);
      const financeError = validateFinanceChanges(previous, state, { role, name: actor }, now);
      if (financeError) throw new Error(`invalid_finance_transition: ${financeError}`);
      const ledgerError = validateFinanceLedgerChanges(previous, state, { role, name: actor }, now);
      if (ledgerError) throw new Error(`invalid_finance_ledger: ${ledgerError}`);
      const treasuryError = validateTreasuryChanges(previous, state, { role, name: actor }, now);
      if (treasuryError) throw new Error(`invalid_treasury_transition: ${treasuryError}`);
      const automationError = validateFinanceAutomationChanges(previous, state, { role, name: actor }, now);
      if (automationError) throw new Error(`invalid_finance_automation: ${automationError}`);
      const sharedError = await validateSharedPaymentWrite(env.DB, previous, state);
      if (sharedError) throw new Error(`invalid_shared_payment: ${sharedError}`);
      if (!atomicFinance && [...(previous.financeLedger?.operations ?? []), ...(state.financeLedger?.operations ?? [])].some(row => row.sharedPaymentId || row.sharedPaymentSourceKey)) throw new Error('financial_transaction_unavailable');
      if (requiresPortfolioCheck(previous, state)) {
        if (!atomicFinance) throw new Error('financial_transaction_unavailable');
        const others = await env.DB.prepare('SELECT state_json FROM project_state WHERE project_id <> ?').bind(projectId).all();
        const portfolioError = validatePortfolioWrite(previous, state, (others?.results ?? []).map(row => JSON.parse(row.state_json)));
        if (portfolioError) throw new Error(`invalid_portfolio_finance: ${portfolioError}`);
      }
      const stateJson = JSON.stringify(state);
      const stateBytes = new TextEncoder().encode(stateJson).byteLength;
      if (stateBytes > MAX_STATE_BYTES) throw new Error('payload_too_large');
      const nextRevision = snapshot.revision + 1;
      const statement = env.DB.prepare(`
        UPDATE project_state
        SET state_json = ?, revision = ?, updated_at = ?, updated_by = ?, updated_role = ?
        WHERE project_id = ? AND revision = ?
      `).bind(stateJson, nextRevision, now, actor, role, projectId, snapshot.revision);
      if (atomicFinance) {
        const result = await statement.run();
        if (changes(result) !== 1) continue;
        await env.DB.prepare(`
          INSERT INTO audit_log (
            id, project_id, revision, created_at, actor, role, action, summary, state_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), projectId, nextRevision, now, actor, role, action, summary, stateBytes).run();
      } else {
        if (!env.DB.batch) throw new Error('financial_transaction_unavailable');
        const audit = env.DB.prepare(`
          INSERT INTO audit_log (id, project_id, revision, created_at, actor, role, action, summary, state_bytes)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM project_state WHERE project_id = ? AND revision = ? AND updated_at = ? AND state_json = ?)
          ON CONFLICT(id) DO NOTHING
        `).bind(`telegram:${projectId}:${nextRevision}`, projectId, nextRevision, now, actor, role, action, summary, stateBytes,
          projectId, nextRevision, now, stateJson);
        const result = await env.DB.batch([statement, audit]);
        if (changes(result?.[0]) !== 1) continue;
      }
      return { previous, state, revision: nextRevision, updatedAt: now, changed: true };
    }
    throw new Error('revision_conflict');
  };

  const mutate = async (env, ...args) => {
    await ensureSchema(env.DB);
    if (!env.DB?.financialTransaction) return mutateWithinTransaction(env, ...args, false);
    return env.DB.financialTransaction(db => mutateWithinTransaction({ ...env, DB: db }, ...args, true));
  };

  return { listSnapshots, mutate };
};
