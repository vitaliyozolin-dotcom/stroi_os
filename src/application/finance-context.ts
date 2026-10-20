import type { FinanceActor } from '../domain/finance/index.js';
import type { Clock, IdGenerator } from './ports';
export interface FinanceCommandContext { identity: FinanceActor; clock: Clock; ids: IdGenerator }
