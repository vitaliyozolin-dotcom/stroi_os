import { authenticatedIdentity, projectIdentity } from '../access-control.js';
import { json } from '../lib/http.js';
import { readJsonBodyLimited } from '../lib/request-body.js';
import { emptyFinanceLedger, ledgerEntryBalance, validateFinanceLedgerChanges, validateFinanceLedgerShape } from '../../src/domain/finance-ledger.js';
import { validateTreasuryChanges } from '../../src/domain/treasury.js';
import { validateFinanceAutomationChanges } from '../../src/domain/finance-automation.js';
import { validatePortfolioWrite } from '../../src/domain/finance-portfolio.js';
import { SHARED_PAYMENT_PREFIX, sharedPaymentInputError, normalizeSharedPaymentInput, buildSharedPaymentShares,
  isSharedPaymentOperation, stableSharedPaymentValue, sharedPaymentEvidenceFingerprint } from '../../src/domain/shared-payment.js';

const same = (a, b) => stableSharedPaymentValue(a) === stableSharedPaymentValue(b);
const changes = result => Number(result?.meta?.changes ?? result?.changes ?? 0);
const query = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all())?.results ?? [];
const fail = (error, message, status = 422) => json({ ok: false, error, message }, status);
const denied = () => fail('project_access_denied', 'Для общего платежа нужны финансовые права во всех затронутых заказах.', 403);
const conflict = () => fail('revision_conflict', 'Данные одного из заказов изменились. Обновите форму и проверьте распределение.', 409);
const readProjects = async db => {
  const rows = await query(db, 'SELECT project_id, state_json, revision, updated_at, updated_by, updated_role FROM project_state ORDER BY project_id LIMIT 501');
  if (rows.length > 500) return null;
  return rows.map(row => ({ projectId: row.project_id, state: JSON.parse(row.state_json), revision: Number(row.revision), updatedAt: row.updated_at ?? '', updatedBy: row.updated_by ?? '', updatedRole: row.updated_role ?? 'management' }));
};
const originalDocument = (state, documentId) => (state.documents ?? []).find(document => document.id === documentId
  && document.clientVisible === false && typeof document.fileKey === 'string' && document.fileKey.startsWith(`${state.project.id}/`)
  && !document.fileKey.includes('\\') && !document.fileKey.split('/').some(part => ['.', '..'].includes(part)));
const ordinaryKeys = state => [...(state.financeLedger?.operations ?? []), ...(state.financeLedger?.confirmations ?? [])].map(row => row.sourceKey)
  .concat((state.financeEntries ?? []).map(row => row.historicalPayment?.sourceUniqueKey)).filter(key => typeof key === 'string' && key);
const projectPreview = row => ({ projectId: row.projectId, projectName: row.state.project.name || row.projectId, revision: row.revision,
  legalEntityIds: [...new Set((row.state.treasury?.accounts ?? []).filter(account => account.currency === 'RUB' && account.legalEntityId).map(account => account.legalEntityId))],
  accounts: (row.state.treasury?.accounts ?? []).filter(account => !account.isProjectDedicated && account.sharedAccountKey && account.currency === 'RUB')
    .map(account => ({ id: account.id, name: account.name, legalEntityId: account.legalEntityId, sharedAccountKey: account.sharedAccountKey })),
  entries: (row.state.financeEntries ?? []).map(entry => { const balance = ledgerEntryBalance(row.state, entry.id); return {
    id: entry.id, kind: entry.kind, description: entry.description, counterparty: entry.counterparty, remainingCents: balance.remainingCents, payableCents: balance.payableCents,
    tranches: (row.state.treasury?.entryPlans ?? []).find(plan => plan.entryId === entry.id)?.tranches.map(({ id, amountCents, source }) => ({ id, amountCents, source })) ?? [],
    retentions: (row.state.financeLedger?.retentions ?? []).filter(item => item.entryId === entry.id).map(({ id, amountCents, status, trancheId }) => ({ id, amountCents, status, ...(trancheId ? { trancheId } : {}) })),
  }; }),
  documents: (row.state.documents ?? []).filter(document => originalDocument(row.state, document.id)).map(({ id, name }) => ({ id, name })),
});
const canonicalForProject = (db, projectId) => query(db, `SELECT p.payload_json, s.operation_id, s.amount_cents FROM shared_payment_records p
  JOIN shared_payment_project_shares s ON s.payment_id = p.id WHERE s.project_id = ?`, projectId);
const projectionError = 'Доли общего платежа создаёт сервер. Сумму, реквизиты и межпроектное распределение записанной доли нельзя изменить или удалить.';

/** Run inside the caller's financialTransaction, after merge, on ALL project writes (including Telegram).
 * Allows ordinary append-only allocationEvents and real refunds; existing ledger validation still applies.
 * No trust is placed in client-supplied shared metadata, nor even in a matching previous state.
 */
export async function validateSharedPaymentWrite(db, previousState, nextState) {
  try {
    if (!nextState?.project?.id || previousState?.project?.id && previousState.project.id !== nextState.project.id) return projectionError;
    const shape = validateFinanceLedgerShape(nextState.financeLedger); if (shape) return shape;
    const authoritative = await canonicalForProject(db, nextState.project.id);
    const operations = nextState.financeLedger?.operations ?? [], expected = new Map();
    for (const row of authoritative) {
      const record = JSON.parse(row.payload_json), share = record.shares.find(item => item.projectId === nextState.project.id);
      if (!share || share.operationId !== row.operation_id || share.amountCents !== Number(row.amount_cents)) return projectionError;
      const matches = operations.filter(operation => operation.id === share.operationId);
      if (matches.length !== 1 || !same(matches[0], share.operation)) return projectionError;
      if (record.principal.cashTreatment !== 'participant_direct') {
        const account = (nextState.treasury?.accounts ?? []).find(item => item.id === share.accountId);
        if (!account || account.isProjectDedicated || account.currency !== 'RUB' || account.sharedAccountKey !== record.principal.sharedAccountKey || account.legalEntityId !== record.principal.legalEntityId) return 'Реквизиты счёта записанного общего платежа неизменны. Для другого счёта создайте отдельную запись.';
      }
      if (record.principal.bankEvidence?.projectId === nextState.project.id) {
        const document = originalDocument(nextState, record.principal.bankEvidence.documentId);
        if (!document || sharedPaymentEvidenceFingerprint(document) !== record.bankDocumentFingerprint) return 'Нельзя заменить или открыть клиенту банковское основание записанного общего платежа.';
      }
      expected.set(share.operationId, share.operation);
    }
    if (operations.some(operation => isSharedPaymentOperation(operation) && !expected.has(operation.id))) return projectionError;
    for (const [key, rows] of Object.entries(nextState.financeLedger ?? {})) {
      if (!Array.isArray(rows) || key === 'history' || key === 'operations') continue;
      if (rows.some(row => row && (Object.keys(row).some(name => name.startsWith('sharedPayment')) || row.id?.startsWith?.(SHARED_PAYMENT_PREFIX)))) return projectionError;
    }
    if (operations.some(operation => Object.keys(operation).some(key => key.startsWith('sharedPayment')) && !expected.has(operation.id))) return projectionError;
    if ((nextState.financeLedger?.confirmations ?? []).some(event => expected.has(event.operationId))) return 'Подтверждение общего платежа относится ко всему исходному движению. Отдельная доля не сверяется как самостоятельная банковская операция.';
    const keys = [...new Set(ordinaryKeys(nextState))];
    for (let offset = 0; offset < keys.length; offset += 100) {
      const part = keys.slice(offset, offset + 100);
      if ((await query(db, `SELECT id FROM shared_payment_records WHERE source_key IN (${part.map(() => '?').join(',')}) LIMIT 1`, ...part)).length) return 'Этот исходный платёж уже распределён между заказами. Повторная запись банковского движения запрещена.';
    }
    return '';
  } catch { return 'Не удалось проверить неизменность общего платежа. Обновите данные; запись не выполнена.'; }
}

const accountError = (principal, share, state) => {
  if (principal.cashTreatment === 'participant_direct') {
    return (state.treasury?.accounts ?? []).some(account => account.legalEntityId === principal.legalEntityId && account.currency === 'RUB') ? '' : 'Выбранное юрлицо должно быть явно настроено в каждом затронутом заказе.';
  }
  const accounts = (state.treasury?.accounts ?? []).filter(account => account.sharedAccountKey === principal.sharedAccountKey);
  if (accounts.length !== 1 || accounts[0].id !== share.accountId || accounts[0].isProjectDedicated || accounts[0].legalEntityId !== principal.legalEntityId
    || accounts[0].currency !== 'RUB' || !accounts[0].opening?.confirmed || !Number.isSafeInteger(accounts[0].projectAllocationCents)) return 'Каждый заказ должен использовать подтверждённую проекцию одного общего счёта того же юрлица и валюты.';
  return '';
};
const snapshot = row => ({ projectId: row.projectId, state: row.state, revision: row.revision, updatedAt: row.updatedAt, updatedBy: row.updatedBy, updatedRole: row.updatedRole });

/** One principal record + immutable project shares + project revisions/audit, committed together. */
export const createSharedPaymentHandler = ({ ensureSchema }) => async (request, env) => {
  if (!env.DB) return fail('storage_unavailable', 'Хранилище недоступно.', 503);
  const actor = authenticatedIdentity(request, env);
  if (!actor) return denied();
  const currentProjectId = new URL(request.url).searchParams.get('projectId');
  if (!currentProjectId || currentProjectId.length > 100) return fail('invalid_project', 'Откройте платёж из нужного заказа.');
  if (!['GET', 'POST'].includes(request.method)) return fail('not_found', 'Маршрут не найден.', 404);
  let input;
  if (request.method === 'POST') {
    if (!env.DB.financialTransaction) return fail('financial_transaction_unavailable', 'Хранилище не поддерживает атомарную запись общего платежа.', 503);
    try { input = await readJsonBodyLimited(request, 256 * 1024); }
    catch (error) { return fail(error?.message === 'payload_too_large' ? 'payload_too_large' : 'invalid_json', 'Не удалось прочитать платёж.', error?.message === 'payload_too_large' ? 413 : 400); }
    const error = sharedPaymentInputError(input); if (error) return fail('invalid_shared_payment', error);
  }
  try {
    await ensureSchema(env.DB);
    const execute = async db => {
      const rows = await readProjects(db); if (!rows) return fail('portfolio_scope_too_large', 'Слишком много заказов для общей операции.');
      const current = rows.find(row => row.projectId === currentProjectId);
      if (!current || projectIdentity(request, env, current.state)?.role !== 'management') return denied();
      const allowed = rows.filter(row => projectIdentity(request, env, row.state)?.role === 'management');
      const authorizedIds = new Set(allowed.map(row => row.projectId));
      if (request.method === 'GET') {
        const payments = (await canonicalForProject(db, currentProjectId)).map(row => JSON.parse(row.payload_json))
          .filter(record => record.shares.every(share => authorizedIds.has(share.projectId)))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
        return json({ ok: true, projects: allowed.map(projectPreview), payments });
      }
      const principal = normalizeSharedPaymentInput(input), shares = buildSharedPaymentShares(principal);
      if (!shares.some(share => share.projectId === currentProjectId) || shares.some(share => !authorizedIds.has(share.projectId))) return denied();
      const existingRows = await query(db, 'SELECT payload_json FROM shared_payment_records WHERE id = ? OR source_key = ?', principal.id, principal.sourceKey);
      if (existingRows.length) {
        const existing = JSON.parse(existingRows[0].payload_json);
        if (!existing.shares.every(share => authorizedIds.has(share.projectId))) return denied();
        if (existingRows.length !== 1 || !same(existing.principal, principal)) return fail('payment_identity_conflict', 'Платёж с таким ID или уникальным источником уже записан. Проверьте исходную запись; повторное движение не создаётся.', 409);
        for (const share of existing.shares) {
          const row = rows.find(item => item.projectId === share.projectId);
          const error = await validateSharedPaymentWrite(db, row.state, row.state); if (error) return fail('invalid_shared_projection', error, 409);
        }
        return json({ ok: true, payment: existing, snapshot: snapshot(current), replayed: true });
      }
      const expected = new Map(input.expected.map(row => [row.projectId, row.revision]));
      if (shares.some(share => expected.get(share.projectId) !== rows.find(row => row.projectId === share.projectId)?.revision)) return conflict();
      if (rows.some(row => ordinaryKeys(row.state).includes(principal.sourceKey))) return fail('duplicate_source', 'Этот банковский источник уже записан в финансовом журнале. Сначала откройте существующую запись; повторный платёж запрещён.', 409);
      const now = new Date().toISOString(), candidates = new Map();
      let bankDocumentFingerprint;
      if (principal.bankEvidence) {
        const evidenceState = rows.find(row => row.projectId === principal.bankEvidence.projectId).state;
        const document = originalDocument(evidenceState, principal.bankEvidence.documentId);
        if (!document) return fail('invalid_bank_evidence', 'Для сверки нужен закрытый оригинал банковского документа затронутого заказа.');
        bankDocumentFingerprint = sharedPaymentEvidenceFingerprint(document);
      }
      for (const share of shares) {
        const old = rows.find(row => row.projectId === share.projectId), state = structuredClone(old.state);
        const existingError = await validateSharedPaymentWrite(db, old.state, old.state); if (existingError) return fail('invalid_shared_projection', existingError);
        const error = accountError(principal, share, state); if (error) return fail('invalid_shared_account', error);
        const identity = projectIdentity(request, env, old.state);
        state.financeLedger ??= emptyFinanceLedger();
        state.financeLedger.operations.push(share.operation);
        state.financeLedger.changeReason = `Распределение общего платежа: ${principal.sourceReference || principal.id}. ${principal.source}`.slice(0, 4000);
        const treasuryError = validateTreasuryChanges(old.state, state, identity, now); if (treasuryError) return fail('invalid_treasury_transition', treasuryError);
        const ledgerError = validateFinanceLedgerChanges(old.state, state, identity, now); if (ledgerError) return fail('invalid_finance_ledger', ledgerError);
        const automationError = validateFinanceAutomationChanges(old.state, state, identity, now); if (automationError) return fail('invalid_finance_automation', automationError);
        // The canonical record keeps the exact server-stamped immutable projection.
        share.operation = structuredClone(state.financeLedger.operations.find(operation => operation.id === share.operationId));
        candidates.set(share.projectId, { ...old, state, revision: old.revision + 1, updatedAt: now, updatedBy: identity.name, updatedRole: 'management', identity });
      }
      const portfolio = rows.map(row => candidates.get(row.projectId)?.state ?? row.state);
      for (const row of candidates.values()) {
        const error = validatePortfolioWrite(rows.find(old => old.projectId === row.projectId).state, row.state, portfolio.filter(state => state.project.id !== row.projectId));
        if (error) return fail('invalid_portfolio_finance', error);
      }
      const record = { version: 1, principal, shares, createdAt: now, createdBy: actor.name || actor.email || actor.id || 'Управление', ...(bankDocumentFingerprint ? { bankDocumentFingerprint } : {}) };
      const statements = [db.prepare('INSERT INTO shared_payment_records (id, source_key, payload_json, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .bind(principal.id, principal.sourceKey, JSON.stringify(record), now, record.createdBy)];
      for (const share of shares) statements.push(db.prepare('INSERT INTO shared_payment_project_shares (payment_id, project_id, operation_id, amount_cents) VALUES (?, ?, ?, ?)')
        .bind(principal.id, share.projectId, share.operationId, share.amountCents));
      const projectIndexes = [];
      for (const row of candidates.values()) {
        const stateJson = JSON.stringify(row.state), bytes = new TextEncoder().encode(stateJson).byteLength;
        if (bytes > 6_000_000) return fail('payload_too_large', 'Данные заказа превышают допустимый размер.', 413);
        projectIndexes.push(statements.length);
        statements.push(db.prepare('UPDATE project_state SET state_json = ?, revision = ?, updated_at = ?, updated_by = ?, updated_role = ? WHERE project_id = ? AND revision = ?')
          .bind(stateJson, row.revision, now, row.updatedBy, 'management', row.projectId, row.revision - 1));
        statements.push(db.prepare(`INSERT INTO audit_log (id, project_id, revision, created_at, actor, role, action, summary, state_bytes)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM project_state WHERE project_id = ? AND revision = ? AND state_json = ?)
          ON CONFLICT(id) DO NOTHING`).bind(`shared-payment:${row.projectId}:${row.revision}`, row.projectId, row.revision, now, row.updatedBy, 'management', 'shared_payment_recorded',
          `Общий платёж ${principal.sourceReference || principal.id}: доля заказа. ${principal.source}`.slice(0, 300), bytes, row.projectId, row.revision, stateJson));
      }
      const results = await db.batch(statements);
      if (results.length !== statements.length || results.some(result => changes(result) !== 1) || projectIndexes.some(index => changes(results[index]) !== 1 || changes(results[index + 1]) !== 1)) return conflict();
      return json({ ok: true, payment: record, snapshot: snapshot(candidates.get(currentProjectId)), replayed: false });
    };
    return request.method === 'POST' ? await env.DB.financialTransaction(execute) : await execute(env.DB);
  } catch { return fail('storage_error', 'Не удалось подтвердить результат записи. Обновите данные и повторите с тем же ID платежа; повтор не создаст второе движение.', 500); }
};
