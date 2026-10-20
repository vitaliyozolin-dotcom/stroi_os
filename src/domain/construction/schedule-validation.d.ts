import type { ConstructionSnapshot } from '../contexts';
import type { UserRole } from '../../entities/index';
export function validateScheduleReview(previous: ConstructionSnapshot | null, next: ConstructionSnapshot, identity: { role: UserRole; id?: string; name?: string }, now?: string): string | null;
