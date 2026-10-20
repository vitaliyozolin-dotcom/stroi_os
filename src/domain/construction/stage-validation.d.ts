import type { ConstructionSnapshot } from '../contexts';
import type { UserRole } from '../../entities/index';
export function validateStageControl(previous: ConstructionSnapshot | null, next: ConstructionSnapshot, identity: { role: UserRole; id?: string; name?: string }, now?: string): string | null;
