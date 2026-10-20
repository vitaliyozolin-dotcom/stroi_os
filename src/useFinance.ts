import { useRef } from 'react';
import type { AppState } from './entities/index';
import type { FinanceActor } from './domain/finance/index.js';
import { createFinanceUseCases } from './application/finance.ts';
import type { StateChangeSink } from './application/state-change.ts';
import { createProjectFinanceRepository } from './infrastructure/finance-project.ts';
import { runtimeIdGenerator, systemClock } from './infrastructure/runtime';

export const useFinance = (state: AppState, identity: FinanceActor, onChange: StateChangeSink) => {
  const currentProject = useRef(state);
  currentProject.current = state;
  const repository = createProjectFinanceRepository(() => currentProject.current, (next, metadata) => {
    onChange(next, metadata);
    currentProject.current = next;
  });
  return createFinanceUseCases(repository, { identity, clock: systemClock, ids: runtimeIdGenerator });
};
