import type { UserRole } from '../entities/index';
import { prepareSettings, type SettingsInput } from '../domain/settings.ts';
import type { Clock, IdGenerator } from './ports.ts';
import type { SettingsSnapshot, SettingsPatch } from '../domain/contexts.ts';
import { moduleChange, executeModule, type ModuleChange, type ModuleRepository } from './module-repository.ts';
export const changeProjectSettings = (state: SettingsSnapshot, input: SettingsInput, identity: { name: string; role: UserRole; canManageAccess: boolean }, clock: Clock, ids: IdGenerator): { ok: true; change: ModuleChange<SettingsPatch> | null } | { ok: false; error: string } => {
 if (identity.role !== 'management') return { ok: false, error: 'Настройки доступны управлению.' };
 const now = clock.now(), result = prepareSettings(state, input, identity.canManageAccess, input.kind === 'user' && !input.id ? ids.next('user') : '', now);
 if (!result.ok) return result;
 if (!result.changed) return { ok: true, change: null };
 return { ok: true, change: moduleChange(state, { settings: result.settings }, 'settings_updated', result.summary, { identity, clock: { now: () => now }, ids }) };
};
export const createSettingsUseCases = (repository: ModuleRepository<SettingsSnapshot, SettingsPatch>, identity: { name: string; role: UserRole; canManageAccess: boolean }, clock: Clock, ids: IdGenerator) => ({ execute: (input: SettingsInput) => executeModule(repository, state => changeProjectSettings(state, input, identity, clock, ids)) });
