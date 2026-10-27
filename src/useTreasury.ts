import { useRef } from 'react';
import type { AppState, UserRole } from './entities/index';
import type { StateChangeSink } from './application/state-change.ts';
import { createTreasuryUseCases, treasurySnapshot } from './application/treasury.ts';
import { createProjectTreasuryRepository, treasuryReadModel } from './infrastructure/treasury-project.ts';

export const useTreasury = (state: AppState, identity: { name: string; role: UserRole; id?: string }, onChange: StateChangeSink) => {
  const current = useRef(state);
  current.current = state;
  const repository = createProjectTreasuryRepository(() => current.current, (next, meta) => {
    onChange(next, meta);
    current.current = next;
  });
  return { ...createTreasuryUseCases(repository, identity), snapshot: treasurySnapshot(treasuryReadModel(state)) };
};
