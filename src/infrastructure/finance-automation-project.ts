import type { AppState } from "../entities/index";
import {
  financeAutomationSnapshot,
  type FinanceAutomationReadModel,
  type FinanceAutomationRepository,
} from "../application/finance-automation.ts";
import type { StateChangeSink } from "../application/state-change.ts";
export const financeAutomationReadModel = (
  state: AppState,
): FinanceAutomationReadModel => ({
  project: { id: state.project.id },
  financeAutomation: state.financeAutomation,
  treasury: state.treasury,
  financeLedger: state.financeLedger,
  financeEntries: state.financeEntries,
  budgetLines: state.budgetLines,
  stages: state.stages,
  tasks: state.tasks,
  documents: state.documents,
  settings: { users: state.settings.users },
});
export const createFinanceAutomationRepository = (
  read: () => AppState,
  sink: StateChangeSink,
): FinanceAutomationRepository => {
  const projectId = read().project.id;
  return {
    read: () => {
      const current = read();
      return current.project.id === projectId
        ? { ok: true, snapshot: financeAutomationReadModel(current) }
        : { ok: false, error: "Проект изменился." };
    },
    commit: (change) => {
      const current = read();
      if (current.project.id !== projectId || change.projectId !== projectId)
        return { ok: false, error: "Проект изменился." };
      if (
        financeAutomationSnapshot(financeAutomationReadModel(current)) !==
        change.expected
      )
        return {
          ok: false,
          error: "Финансовые данные обновились. Повторите действие.",
        };
      sink(
        {
          ...current,
          financeAutomation: structuredClone(change.financeAutomation),
        },
        { action: change.action, summary: change.summary },
      );
      return { ok: true };
    },
  };
};
