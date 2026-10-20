import type { AppState, AppSettings, DashboardWidget, NotificationSettings, UserRole } from '../entities/index';
export const settingsSnapshot = (state: AppState) => JSON.stringify([state.project.id, state.settings]);
export type SettingsInput = { expected: string } & (
 | { kind: 'widget'; widget: DashboardWidget; enabled: boolean }
 | { kind: 'channel'; key: keyof NotificationSettings['channels']; enabled: boolean }
 | { kind: 'event'; key: keyof NotificationSettings['events']; enabled: boolean }
 | { kind: 'user'; id?: string; name: string; email: string; role: UserRole; telegram: string }
);
export const prepareSettings = (state: AppState, input: SettingsInput, canManageAccess: boolean, newId: string, now: string): { ok: true; settings: AppSettings; summary: string; changed: boolean } | { ok: false; error: string } => {
 if (input.expected !== settingsSnapshot(state)) return { ok: false, error: 'Настройки обновились. Откройте форму заново.' };
 if (input.kind !== 'user' && typeof input.enabled !== 'boolean') return { ok: false, error: 'Укажите состояние настройки.' };
 const settings = structuredClone(state.settings); let summary = '';
 if (input.kind === 'widget') {
  if (!['project', 'progress', 'finance', 'decisions', 'cashflow', 'quality', 'supply', 'tasks', 'activity'].includes(input.widget)) return { ok: false, error: 'Неизвестный блок главного экрана.' };
  settings.dashboardWidgets = input.enabled ? [...new Set([...settings.dashboardWidgets, input.widget])] : settings.dashboardWidgets.filter(widget => widget !== input.widget);
  summary = 'Обновлены блоки главного экрана';
 } else if (input.kind === 'channel' || input.kind === 'event') {
  const group = input.kind === 'channel' ? settings.notifications.channels : settings.notifications.events;
  if (!Object.hasOwn(group, input.key) || typeof input.enabled !== 'boolean') return { ok: false, error: 'Неизвестное правило уведомлений.' };
  Object.assign(group, { [input.key]: input.enabled }); summary = input.kind === 'channel' ? 'Обновлены каналы уведомлений' : 'Обновлены правила уведомлений';
 } else {
  if (!canManageAccess) return { ok: false, error: 'Участников меняет только владелец.' };
  const existing = input.id ? settings.users.find(user => user.id === input.id) : undefined;
  if (input.id && (!existing || existing.id === 'user-owner')) return { ok: false, error: 'Пользователь недоступен для изменения.' };
  const email = input.email.trim();
  if (!input.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['management', 'foreman', 'client'].includes(input.role)) return { ok: false, error: 'Укажите имя, корректный email и роль.' };
  if (settings.users.some(user => user.id !== input.id && user.email.trim().toLowerCase() === email.toLowerCase())) return { ok: false, error: 'Пользователь с таким email уже есть в проекте.' };
  const user = { ...(existing ?? { id: newId, status: 'active' as const, invitedAt: now, inviteDelivery: 'draft' as const }), name: input.name.trim(), email, role: input.role, telegram: input.telegram.trim() || undefined };
  settings.users = existing ? settings.users.map(row => row.id === user.id ? user : row) : [...settings.users, user];
  summary = `${existing ? 'Обновлён' : 'Добавлен'} участник ${user.name}. Доступ отдельно управляется сервером`;
 }
 return { ok: true, settings, summary, changed: JSON.stringify(settings) !== JSON.stringify(state.settings) };
};
