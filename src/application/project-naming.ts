import type { HouseProject, ActivityEvent, UserRole } from '../entities/index';
import { withProjectLocationName, type NamedConstructionProject } from '../domain/project-naming.js';
/** Explicit management command; the normal project PUT keeps revision checks and audit. */
export function renameProjectFromLocation<T extends { project: HouseProject; activity: ActivityEvent[] }>(state: T, identity: { name: string; role: UserRole }, now: string, peers: NamedConstructionProject[] = []): { ok: true; state: T; changed: boolean } | { ok: false; error: string } {
  if (identity.role !== 'management') return { ok: false, error: 'Название проекта изменяет управление.' };
  const project = withProjectLocationName(state.project, peers);
  if (project === state.project) return { ok: true, state, changed: false };
  return { ok: true, changed: true, state: { ...state, project, activity: [{ id: `project-name:${state.project.id}:${now}`, timestamp: now, actor: identity.name, text: `Название по месту строительства: «${state.project.name}» → «${project.name}». Код ${project.code} сохранён.`, tone: 'neutral' as const }, ...state.activity] } };
}
