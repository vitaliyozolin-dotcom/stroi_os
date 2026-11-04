import type { OrderChangeRequest, UserRole, OrderRelationsState, BudgetLine, FinanceEntry, TreasuryState, FinanceLedgerState } from '../entities/index';
import type { ConstructionSnapshot } from '../domain/contexts';
import { treasuryMoneyToCents } from '../domain/treasury.js';
import { effectiveBudgetLines } from '../domain/finance-totals.js';
import { stagePlanSnapshot } from '../domain/schedule-planning.ts';
import { previewScheduleRecovery, previewStagePlan, type SchedulePaymentPreview } from './schedule-payment-preview.ts';

export interface OrderImpactScenario { stageId: string; remainingDays?: number; forecastEnd?: string }
export interface OrderImpactSnapshot extends ConstructionSnapshot {
  project: ConstructionSnapshot['project'] & { contractValue: number; unknownFields?: string[] };
  orderRelations?: OrderRelationsState;
  budgetLines: BudgetLine[];
  financeEntries: FinanceEntry[];
  treasury?: TreasuryState;
  financeLedger?: FinanceLedgerState;
}

/** A disposable scenario: no save, signed terms, payment facts or source dates are rewritten. */
export function orderChangeImpact<S extends OrderImpactSnapshot>(state: S, change: OrderChangeRequest, identity: { role: UserRole; name: string }, scenario?: OrderImpactScenario, now = new Date().toISOString()) {
  if (identity.role !== 'management') return { ok: false as const, error: 'Влияние изменения доступно управлению.' };
  if (!state.orderRelations?.changeRequests.some(row => row.id === change.id)) return { ok: false as const, error: 'Изменение не найдено в текущем заказе.' };
  const objectIds = new Set(change.objectIds);
  const links = state.orderRelations.links.filter(link => link.changeRequestId === change.id || link.objectId && objectIds.has(link.objectId));
  const linked = (kind: string) => new Set(links.filter(link => link.kind === kind).map(link => link.entityId));
  const stageIds = linked('stage'), budgetIds = linked('budget'), supplyIds = linked('procurement');
  const budgets = effectiveBudgetLines(state).filter(row => budgetIds.has(row.id));
  const sum = (values: (number | null)[]) => values.some(value => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const currentBudgetCents = budgets.length ? sum(budgets.map(row => treasuryMoneyToCents(row.plan))) : null;
  const currentPriceCents = state.project.unknownFields?.includes('contractValue') ? null : treasuryMoneyToCents(state.project.contractValue);
  const proposed = (before: number | null, delta?: number) => before === null || delta === undefined || !Number.isSafeInteger(before + delta) ? null : before + delta;
  let preview: SchedulePaymentPreview<S> | null = null;
  if (scenario) {
    const stage = state.stages.find(row => row.id === scenario.stageId);
    if (!stage || !stageIds.has(stage.id)) preview = { ok: false, error: 'Сначала свяжите этап с изменением или его объектом.' };
    else if (stage.acceptedAt || stage.actualEnd || stage.completedOn) preview = { ok: false, error: 'Фактически завершённый этап не переносится расчётным сценарием.' };
    else if (stage.schedule) preview = previewScheduleRecovery(state, { stageId: stage.id, remainingDays: scenario.remainingDays ?? NaN });
    else preview = previewStagePlan(state, { stageId: stage.id, expected: stagePlanSnapshot(state, stage.id), draft: {
      planStart: stage.planStart, planEnd: stage.planEnd, forecastEnd: scenario.forecastEnd ?? '', dependencyId: stage.dependencyId ?? '', responsibleId: stage.responsibleId ?? '', reason: `Расчёт изменения: ${change.title}`,
    } }, identity, now);
  }
  return { ok: true as const, preview, currentBudgetCents, proposedBudgetCents: proposed(currentBudgetCents, change.costDeltaCents), currentPriceCents, proposedPriceCents: proposed(currentPriceCents, change.priceDeltaCents),
    stages: state.stages.filter(row => stageIds.has(row.id)), budgets,
    supplies: state.procurement.filter(row => supplyIds.has(row.id) || stageIds.has(row.stageId)),
    specifications: state.orderRelations.objects.filter(row => objectIds.has(row.id)).map(row => ({ objectId: row.id, title: row.title,
      current: row.specifications.find(spec => spec.id === row.activeSpecificationId), proposals: row.specifications.filter(spec => spec.changeRequestId === change.id && spec.id !== row.activeSpecificationId) })),
  };
}
