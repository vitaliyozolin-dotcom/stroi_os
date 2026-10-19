import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import type { AppState, AuthenticatedUser, UserRole } from '../entities/index';
import type { StateChangeSink } from '../application/state-change';
import type { RemoteProjectSnapshot } from '../application/ports';
import type { PageId } from '../presentation/navigation';
import { PageLoadBoundary } from './PageLoadBoundary';

const ClientPage = lazy(() => import('../pages/ClientPage').then((module) => ({ default: module.ClientPage })));
const FinancePage = lazy(() => import('../pages/FinancePage').then((module) => ({ default: module.FinancePage })));
const MarketingPage = lazy(() => import('../pages/MarketingPage').then((module) => ({ default: module.MarketingPage })));
const OverviewPage = lazy(() => import('../pages/OverviewPage').then((module) => ({ default: module.OverviewPage })));
const ProcurementPage = lazy(() => import('../pages/ProcurementPage').then((module) => ({ default: module.ProcurementPage })));
const QualityPage = lazy(() => import('../pages/QualityPage').then((module) => ({ default: module.QualityPage })));
const SchedulePage = lazy(() => import('../pages/SchedulePage').then((module) => ({ default: module.SchedulePage })));
const SettingsPage = lazy(() => import('../pages/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const CounterpartiesPage = lazy(() => import('../pages/CounterpartiesPage').then((module) => ({ default: module.CounterpartiesPage })));
const TasksPage = lazy(() => import('../pages/TasksPage').then((module) => ({ default: module.TasksPage })));
const ProjectPage = lazy(() => import('../pages/ProjectPage').then((module) => ({ default: module.ProjectPage })));

export function WorkspacePages({ state, session, role, focusEntityId, updateState, navigate, applyServerSnapshot, openQuestions, openProjects }: {
  state: AppState;
  session: AuthenticatedUser;
  role: UserRole;
  focusEntityId: string | null;
  updateState: StateChangeSink;
  navigate: (page: PageId, entityId?: string) => void;
  applyServerSnapshot: (snapshot: RemoteProjectSnapshot) => void;
  openQuestions: () => void;
  openProjects: () => void;
}) {
  return (
    <PageLoadBoundary>
      <Suspense fallback={<div role="status" aria-live="polite" className="task-empty">Загружаем раздел…</div>}>
          <Routes>
          <Route path="/projects/:projectId/project" element={<ProjectPage state={state} session={session} focusId={focusEntityId} onChange={updateState} onNavigate={navigate} />} />
          <Route path="/projects/:projectId/tasks" element={<TasksPage state={state} role={role} session={session} focusId={focusEntityId} onChange={updateState} onNavigate={navigate} />} />
          <Route path="/projects/:projectId/marketing" element={<MarketingPage state={state} actor={session.name} focusId={focusEntityId} onChange={updateState} />} />
          <Route path="/projects/:projectId/counterparties" element={<CounterpartiesPage state={state} actor={session.name} focusId={focusEntityId} onChange={updateState} />} />
          <Route path="/projects/:projectId/finance" element={<FinancePage role={role} onOpenQuestions={openQuestions} state={state} actor={session.name} focusId={focusEntityId} onChange={updateState} onNavigate={navigate} />} />
          <Route path="/projects/:projectId/schedule" element={<SchedulePage state={state} role={role} actor={session.name} userId={session.id} focusId={focusEntityId} onChange={updateState} />} />
          <Route path="/projects/:projectId/procurement" element={<ProcurementPage state={state} role={role} actor={session.name} focusId={focusEntityId} onChange={updateState} />} />
          <Route path="/projects/:projectId/quality" element={<QualityPage state={state} role={role} actor={session.name} focusId={focusEntityId} onChange={updateState} />} />
          <Route path="/projects/:projectId/client" element={<ClientPage state={state} onChange={updateState} />} />
          <Route path="/projects/:projectId/settings" element={<SettingsPage state={state} actor={session.name} canManageAccess={Boolean(session.isOwner)} onChange={updateState} onServerSnapshot={applyServerSnapshot} />} />
          <Route path="/projects/:projectId/overview" element={<OverviewPage state={state} role={role} actor={session.name} userId={session.id} onChange={updateState} onNavigate={navigate} onOpenProjects={openProjects} />} />
        </Routes>
      </Suspense>
    </PageLoadBoundary>
  );
}
