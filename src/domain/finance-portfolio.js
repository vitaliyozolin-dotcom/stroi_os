import { treasuryProjection } from './treasury.js';

const safeSum = values => {
  let total = 0;
  for (const value of values) { if (!Number.isSafeInteger(value) || !Number.isSafeInteger(total + value)) return null; total += value; }
  return total;
};
const sharedSignature = account => JSON.stringify([account.legalEntityId, account.currency, account.opening?.asOf,
  account.opening?.amountCents, account.opening?.confirmed, account.restrictedCents ?? 0]);
const sharedAccounts = state => (state.treasury?.accounts ?? []).filter(account => !account.isProjectDedicated);
const sourceKeys = state => [...(state.financeLedger?.operations ?? []), ...(state.financeLedger?.confirmations ?? [])]
  .map(operation => operation.sourceKey).filter(Boolean);

/** Must run inside the same cross-project transaction as the project write. No hidden project details in errors. */
export function validatePortfolioWrite(previous, next, others) {
  const active = sharedAccounts(next);
  const keys = new Set();
  for (const account of active) {
    const old = sharedAccounts(previous ?? {}).find(item => item.id === account.id);
    if (!account.sharedAccountKey) {
      if (JSON.stringify(old) !== JSON.stringify(account)) return 'Для общего счёта укажите единый идентификатор во всех проектах.';
      continue;
    }
    if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(account.sharedAccountKey)) return 'Общий идентификатор счёта: до 120 латинских букв, цифр, точек, дефисов или подчёркиваний.';
    if (keys.has(account.sharedAccountKey)) return 'Один общий счёт не может быть добавлен в проект дважды.';
    keys.add(account.sharedAccountKey);
    if (!account.opening?.confirmed || !Number.isSafeInteger(account.opening.amountCents)
      || !Number.isSafeInteger(account.projectAllocationCents) || account.projectAllocationCents < 0) return 'Распределение общего счёта требует подтверждённого остатка и выделенной суммы проекта.';
    const matching = others.flatMap(sharedAccounts).filter(item => item.sharedAccountKey === account.sharedAccountKey);
    if (matching.some(item => sharedSignature(item) !== sharedSignature(account))) return 'Сведения общего счёта расходятся между проектами. Сверьте юрлицо, дату, остаток и ограничения.';
    const allocated = safeSum([account.projectAllocationCents, ...matching.map(item => item.projectAllocationCents)]);
    const available = account.opening.amountCents - (account.restrictedCents ?? 0);
    if (allocated === null || !Number.isSafeInteger(available) || allocated > available) return 'Выделенные суммы проектов превышают доступный остаток общего счёта.';
  }
  const already = new Set(others.flatMap(sourceKeys));
  for (const key of sourceKeys(next)) if (already.has(key)) return 'Эта банковская операция уже записана в другом проекте. Повторный импорт запрещён.';
  return '';
}

export const requiresPortfolioCheck = (previous, next) =>
  JSON.stringify(sharedAccounts(previous ?? {})) !== JSON.stringify(sharedAccounts(next))
  || JSON.stringify(sourceKeys(previous ?? {})) !== JSON.stringify(sourceKeys(next));

function aggregate(projections, today) {
  const openingCents = projections.length ? safeSum(projections.map(row => row.openingCents)) : null;
  const count = projections[0]?.days.length ?? 0;
  const days = Array.from({ length: count }, (_, index) => ({
    date: projections[0].days[index].date,
    inflowCents: safeSum(projections.map(row => row.days[index].inflowCents)),
    outflowCents: safeSum(projections.map(row => row.days[index].outflowCents)),
    balanceCents: safeSum(projections.map(row => row.days[index].balanceCents)),
  }));
  const known = openingCents !== null && days.every(day => day.balanceCents !== null);
  const minBalanceCents = known ? Math.min(openingCents, ...days.map(day => day.balanceCents)) : null;
  return { openingCents, minBalanceCents, firstDeficitDate: !known ? null : openingCents < 0 ? today : days.find(day => day.balanceCents < 0)?.date ?? null,
    peakFundingCents: minBalanceCents === null ? null : Math.max(0, -minBalanceCents), complete: projections.length > 0 && projections.every(row => row.completeness), days };
}

/** Scope is only the supplied, authorized projects. Project allocations, not replicated bank balances, are summed. */
export function financePortfolio(states, { today, horizonDays = 91, scenario = 'base' }) {
  const enabled = states.filter(state => state.treasury?.enabled), projections = [], groups = new Map(), accounts = [];
  const projects = states.map(state => {
    const projection = treasuryProjection(state, { today, horizonDays, scenario });
    projections.push(projection);
    for (const account of state.treasury?.accounts ?? []) {
      const accountProjection = treasuryProjection(state, { today, horizonDays, scenario, accountId: account.id });
      const legalEntityId = account.legalEntityId || 'Не указано';
      const rows = groups.get(legalEntityId) ?? []; rows.push(accountProjection); groups.set(legalEntityId, rows);
      accounts.push({ projectId: state.project.id, accountId: account.id, name: account.name, legalEntityId,
        sharedAccountKey: account.sharedAccountKey ?? null, scope: account.isProjectDedicated ? 'dedicated' : 'project_allocation',
        ...aggregate([accountProjection], today) });
    }
    return { projectId: state.project.id, code: state.project.code ?? '', name: state.project.name ?? state.project.id,
      enabled: state.treasury?.enabled === true, warningCount: projection.warnings.length, ...aggregate([projection], today) };
  });
  const companies = [...groups].map(([legalEntityId, rows]) => ({ legalEntityId, ...aggregate(rows, today) }));
  const sharedIssues = [];
  for (const state of enabled) {
    const problem = validatePortfolioWrite(state, state, states.filter(other => other.project.id !== state.project.id));
    if (problem) sharedIssues.push(problem);
    if (sharedAccounts(state).some(account => !account.sharedAccountKey)) sharedIssues.push('Часть общих счетов не имеет единого идентификатора; полнота распределения не подтверждена.');
  }
  const summary = aggregate(projections, today);
  return { today, horizonDays, scenario, scope: 'authorized_project_allocations', projectCount: states.length, enabledProjectCount: enabled.length,
    summary: { ...summary, complete: summary.complete && sharedIssues.length === 0 }, projects, companies, accounts,
    warnings: [...new Set(sharedIssues)], companiesWithDeficit: companies.filter(company => (company.peakFundingCents ?? 0) > 0).length };
}
