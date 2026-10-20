import type { AppState, UserRole } from '../entities/index';
import { prepareSettings, type SettingsInput } from '../domain/settings.ts';
import type { Clock, IdGenerator } from './ports';
import { commitStateChange, type StateChangeSink } from './state-change.ts';
import type { StateChange } from '../domain/change';
export const changeProjectSettings = (state: AppState, input: SettingsInput, identity: { name: string; role: UserRole; canManageAccess: boolean }, clock: Clock, ids: IdGenerator): { ok: true; change: StateChange | null } | { ok: false; error: string } => {
 if (identity.role !== 'management') return { ok: false, error: 'Настройки доступны управлению.' };
 const now = clock.now(), result = prepareSettings(state, input, identity.canManageAccess, input.kind === 'user' && !input.id ? ids.next('user') : '', now);
 if (!result.ok) return result;
 if (!result.changed) return { ok: true, change: null };
 return { ok: true, change: { action: 'settings_updated', summary: result.summary, state: { ...state, settings: result.settings, activity: [{ id: ids.next('activity'), timestamp: now, actor: identity.name, text: result.summary, tone: 'neutral' }, ...state.activity] } } };
};
export const createSettingsUseCases = (state: AppState, identity: { name: string; role: UserRole; canManageAccess: boolean }, clock: Clock, ids: IdGenerator, sink: StateChangeSink) => ({ execute: (input: SettingsInput) => { const result = changeProjectSettings(state, input, identity, clock, ids); if (result.ok && result.change) commitStateChange(result.change, sink); return result; } });
