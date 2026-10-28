import { useRef } from 'react';
import type { AppState, UserRole } from './entities/index';
import type { StateChangeSink } from './application/state-change.ts';
import { createFinanceLedgerUseCases, financeLedgerSnapshot } from './application/finance-ledger.ts';
import { createProjectFinanceLedgerRepository, financeLedgerReadModel } from './infrastructure/finance-ledger-project.ts';
export const useFinanceLedger = (state: AppState, identity: { name: string; role: UserRole; id?: string }, onChange: StateChangeSink) => {
  const current = useRef(state); current.current = state;
  const repository = createProjectFinanceLedgerRepository(() => current.current, (next, meta) => { onChange(next, meta); current.current = next; });
  return { ...createFinanceLedgerUseCases(repository, identity), snapshot: financeLedgerSnapshot(financeLedgerReadModel(state)) };
};
