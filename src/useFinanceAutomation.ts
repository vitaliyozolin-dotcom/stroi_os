import { useRef } from "react";
import type { AppState, UserRole } from "./entities/index";
import type { StateChangeSink } from "./application/state-change";
import {
  createFinanceAutomationUseCases,
  financeAutomationSnapshot,
} from "./application/finance-automation";
import {
  createFinanceAutomationRepository,
  financeAutomationReadModel,
} from "./infrastructure/finance-automation-project";
export const useFinanceAutomation = (
  state: AppState,
  identity: { name: string; role: UserRole; id?: string },
  onChange: StateChangeSink,
) => {
  const current = useRef(state);
  current.current = state;
  const repository = createFinanceAutomationRepository(
    () => current.current,
    (next, metadata) => {
      onChange(next, metadata);
      current.current = next;
    },
  );
  return {
    ...createFinanceAutomationUseCases(repository, identity),
    snapshot: financeAutomationSnapshot(financeAutomationReadModel(state)),
  };
};
