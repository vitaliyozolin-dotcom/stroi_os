import type { AppState, UserRole } from '../entities/index';

export function constructionOverview(state: AppState, role: UserRole) {
  const stages = state.stages.filter((stage) => stage.schedule?.kind !== 'summary')
    .slice().sort((a, b) => a.order - b.order);
  const active = stages.filter((stage) => ['in_progress', 'blocked', 'rework', 'awaiting_inspection'].includes(stage.status));
  const current = active[0];
  const next = stages.find((stage) => stage.status !== 'accepted');
  const activeIds = new Set(active.map((stage) => stage.id));
  const photos = (state.fieldReports ?? [])
    .filter((report) => role !== 'client' || report.clientVisible)
    .flatMap((report) => report.attachments.filter((file) => /^image\/(jpeg|png|webp|gif)$/.test(file.mimeType))
      .map((file) => ({ report, file })))
    .sort((a, b) => b.report.createdAt.localeCompare(a.report.createdAt));
  const photo = photos.find(({ report }) => report.stageId && activeIds.has(report.stageId)) ?? photos[0];
  const photoStage = stages.find((stage) => stage.id === photo?.report.stageId);
  const task = role === 'client' ? undefined : state.tasks
    .filter((item) => !item.id.startsWith('auto-stage-') && !['done', 'canceled'].includes(item.status))
    .slice().sort((a, b) => Number(activeIds.has(b.stageId ?? '')) - Number(activeIds.has(a.stageId ?? ''))
      || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'))[0];
  const actionStage = role === 'client' ? undefined : active.find((stage) => stage.siteUpdate?.nextAction.trim());
  const action = actionStage ? {
    title: actionStage.siteUpdate!.nextAction,
    owner: actionStage.siteUpdate!.issueOwner || actionStage.responsible,
    date: actionStage.siteUpdate!.reviewOn,
    dateLabel: 'Проверка',
    page: 'schedule' as const,
  } : task ? { title: task.title, owner: task.assigneeName, date: task.dueDate, dateLabel: 'До', page: 'tasks' as const } : undefined;
  return { stages, active, current, next, photo, photoStage, action,
    accepted: stages.filter((stage) => stage.status === 'accepted').length };
}
