import type {
  FinanceAutomationState,
  FinancialRiskReview,
  UserRole,
} from "../entities/index";
import {
  emptyFinanceAutomation,
  financialRiskSignals,
  validateFinanceAutomationChanges,
  type FinanceAutomationProject,
} from "../domain/finance-automation.js";
export type FinanceAutomationReadModel = FinanceAutomationProject;
export const financeAutomationSnapshot = (state: FinanceAutomationReadModel) =>
  JSON.stringify([
    state.project.id,
    state.financeAutomation,
    state.treasury,
    state.financeLedger,
    state.financeEntries,
    state.budgetLines,
    state.stages,
    state.tasks,
    state.documents,
    state.settings?.users,
  ]);
export interface FinanceAutomationRepository {
  read():
    | { ok: true; snapshot: FinanceAutomationReadModel }
    | { ok: false; error: string };
  commit(change: {
    projectId: string;
    expected: string;
    financeAutomation: FinanceAutomationState;
    action: string;
    summary: string;
  }): { ok: true } | { ok: false; error: string };
}
export const createFinanceAutomationUseCases = (
  repository: FinanceAutomationRepository,
  identity: { name: string; role: UserRole; id?: string },
) => ({
  save(input: {
    expected: string;
    riskId?: string;
    review?: Pick<
      FinancialRiskReview,
      | "ownerId"
      | "nextAction"
      | "actionDueDate"
      | "acknowledged"
      | "snoozedUntil"
    >;
    today: string;
  }) {
    if (identity.role !== "management")
      return {
        ok: false as const,
        error: "Финансовые уведомления доступны управлению.",
      };
    const read = repository.read();
    if (!read.ok) return read;
    const state = read.snapshot;
    if (financeAutomationSnapshot(state) !== input.expected)
      return {
        ok: false as const,
        error: "Расчёты или уведомления обновились. Откройте действие заново.",
      };
    const financeAutomation = structuredClone(
      state.financeAutomation ?? emptyFinanceAutomation(),
    );
    const active = financialRiskSignals(state, { today: input.today });
    if (input.riskId && !active.some((signal) => signal.id === input.riskId))
      return {
        ok: false as const,
        error: "Условие риска уже снято. Обновите список.",
      };
    if (input.riskId) {
      const old = financeAutomation.reviews.find(
        (review) => review.riskId === input.riskId,
      );
      const review = { ...old, ...input.review, riskId: input.riskId };
      financeAutomation.reviews = [
        ...financeAutomation.reviews.filter(
          (row) => row.riskId !== input.riskId,
        ),
        review,
      ];
    } else
      for (const signal of active)
        if (
          !financeAutomation.reviews.some(
            (review) => review.riskId === signal.id,
          )
        )
          financeAutomation.reviews.push({ riskId: signal.id });
    const error = validateFinanceAutomationChanges(
      state,
      { ...state, financeAutomation },
      identity,
    );
    if (error) return { ok: false as const, error };
    return repository.commit({
      projectId: state.project.id,
      expected: input.expected,
      financeAutomation,
      action: "finance_attention_updated",
      summary: input.riskId
        ? "Обновлено действие по финансовому риску"
        : "Сверен журнал финансовых уведомлений",
    });
  },
});
