import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AuthenticatedUser, UserRole } from '../entities/index';
import { allowedPages, readWorkspaceRoute, workspacePath } from './navigation';
import { useProjectState } from '../useProjectState';
import { normalizeAppState, projectRepository } from '../infrastructure/project-http';
import { projectCacheFactory } from '../infrastructure/project-cache';

const projectStateDependencies = { repository: projectRepository, cacheFactory: projectCacheFactory, normalizeState: normalizeAppState };

export function useWorkspaceProject(session: AuthenticatedUser | null, role: UserRole) {
  const location = useLocation();
  const changeLocation = useNavigate();
  const route = useMemo(() => readWorkspaceRoute(location.pathname, location.search), [location.pathname, location.search]);
  const page = route.page ?? (role === 'client' ? 'client' : 'overview');
  const attemptedProject = useRef<string | null>(null);
  const {
    state,
    updateState,
    sync,
    localCache,
    conflict,
    retry,
    useServerVersion,
    keepLocalVersion,
    applyServerSnapshot,
    reconcileServerSnapshot,
    projects,
    switchProject,
    createProject,
  } = useProjectState(role, session?.name ?? 'Виталий Озолин', session ? `${session.email}|${session.role}` : '', projectStateDependencies);
  useEffect(() => {
    if (!session || !route.valid) return;
    if (sync.phase === 'saving' || sync.phase === 'conflict') {
      attemptedProject.current = null;
      return;
    }
    if (sync.phase === 'loading') return;
    if (!allowedPages(role).includes(page)) {
      void changeLocation(workspacePath(route.projectId ?? state.project.id, role === 'client' ? 'client' : 'overview'), { replace: true });
      return;
    }
    if (route.projectId && route.projectId !== state.project.id) {
      if (attemptedProject.current === route.projectId) return;
      attemptedProject.current = route.projectId;
      void switchProject(route.projectId);
      return;
    }
    attemptedProject.current = null;
    if (location.pathname === '/') {
      void changeLocation(workspacePath(state.project.id, page, route.entityId), { replace: true });
    }
  }, [session, role, page, route, state.project.id, sync.phase, switchProject, changeLocation, location.pathname]);

  return { state, updateState, sync, localCache, conflict, retry, useServerVersion, keepLocalVersion, applyServerSnapshot, reconcileServerSnapshot, projects, switchProject, createProject, route, page };
}
