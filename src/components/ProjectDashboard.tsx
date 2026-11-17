import { ArrowUpRight, CalendarRange, FileText, ListTodo, PackageSearch, ShieldCheck } from 'lucide-react';
import type { AppState, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { automaticSchedule } from '../domain/construction/index.js';
import { constructionOverview } from '../domain/construction-overview';
import { formatDate } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import { useScheduleToday } from './ProjectScheduleDates';
import { SectionHeader } from './Ui';
import { projectScheduleDashboard } from '../domain/project-dashboard.js';
import { lifecycleDefinitions, lifecycleGroupProgress, lifecyclePhaseLabels } from '../domain/project-lifecycle.js';
import './project-lifecycle-dashboard.css';

type Props = { state: AppState; role: UserRole; onNavigate: (page: PageId, id?: string) => void };

export function ProjectPosition({ state, role, onNavigate }: Props) {
  const view = constructionOverview(state, role);
  const current = view.current ?? view.next;
  const task = current ? state.tasks.find(item => item.stageId === current.id && item.status === 'in_progress') : undefined;
  const lifecycle = state.project.lifecycle;
  const processPhase = lifecycle && lifecycle.phase !== 'construction' && !(lifecycle.legacyReview && view.current);
  const checklist = lifecycleGroupProgress(state, lifecycle?.phase === 'preparation' ? 'preparation' : 'handover');
  const next = lifecycleDefinitions.find(item => item.key === checklist.pending[0]);
  if (processPhase && lifecycle) return <div className="project-position">
    <div><small>Текущий этап</small><strong>{lifecyclePhaseLabels[lifecycle.phase]}</strong><span>{checklist.total ? `Подтверждено ${checklist.completed} из ${checklist.total} условий` : state.project.foreman || 'Ответственный не назначен'}</span></div>
    <div><small>Следующий шаг</small><strong>{['closed', 'warranty'].includes(lifecycle.phase) ? 'Гарантийные обязательства и история' : next ? `${next.number} · ${next.title}` : 'Все условия подтверждены'}</strong><span>{next?.role || 'Откройте маршрут проекта'}</span></div>
    <button type="button" className="button button--secondary" onClick={() => onNavigate('project')}>Открыть этап <ArrowUpRight size={16} /></button>
  </div>;
  return <div className="project-position">
    <div><small>{view.current ? 'Текущий этап' : 'Следующий этап'}</small><strong>{current?.name || 'Подготовка проекта'}</strong><span>{task ? `Сейчас: ${task.title}` : current?.responsible || state.project.foreman || 'Ответственный не назначен'}</span></div>
    <div><small>{view.active.length > 1 ? 'Параллельно' : 'Ближайшее действие'}</small><strong>{view.active.length > 1 ? view.active.filter(item => item.id !== current?.id).map(item => item.shortName || item.name).join(' · ') : view.action?.title || 'Подготовить данные для следующего шага'}</strong><span>{view.action?.date ? `${view.action.owner || 'Ответственный не указан'} · до ${formatDate(view.action.date)}` : 'Откройте проект, чтобы проверить условия'}</span></div>
    <button type="button" className="button button--secondary" onClick={() => onNavigate(view.action?.page || 'project')}>Перейти <ArrowUpRight size={16} /></button>
  </div>;
}

export function ProjectDashboardTimeline({ state, onNavigate }: Props) {
  const today = useScheduleToday();
  const forecast = automaticSchedule(state, today);
  const view = projectScheduleDashboard(state, forecast, today);
  return <section className="panel dashboard-timeline" aria-label="Визуальный график ППР">
    <SectionHeader title="График строительства" eyebrow="ППР" action={<button type="button" className="text-button" onClick={() => onNavigate('schedule')}>Полный график <ArrowUpRight size={16} /></button>} />
    <div className="dashboard-timeline__summary">
      <div><small>Сдача по договору</small><strong>{state.project.targetDate ? formatDate(state.project.targetDate, true) : 'Не указана'}</strong></div>
      <div><small>{forecast.kind === 'actual' ? 'Фактическое окончание' : 'Прогноз по ППР'}</small><strong>{forecast.end ? formatDate(forecast.end, true) : 'Нужны сроки'}</strong></div>
      <div><small>Относительно договора</small><strong className={view.contractDelta !== null && view.contractDelta > 0 ? 'danger-text' : ''}>{view.contractDelta === null ? 'Нужна сверка' : view.contractDelta > 0 ? `Позже на ${view.contractDelta} дн.` : view.contractDelta < 0 ? `Раньше на ${Math.abs(view.contractDelta)} дн.` : 'В срок'}</strong></div>
    </div>
    {view.rows.length ? <div className="dashboard-timeline__chart">
      <div className="dashboard-timeline__axis"><span>Этап и состояние</span><span>{formatDate(view.first)}<span>{formatDate(view.last)}</span></span></div>
      {view.rows.map(row => <button type="button" className="dashboard-timeline__row" key={row.id} onClick={() => onNavigate('schedule', row.id)}>
        <span className="dashboard-timeline__label"><strong>{row.name}</strong><small>{stageStatusLabel[row.status]}{row.end ? ` · до ${formatDate(row.end)}` : ' · срок не указан'}</small></span>
        <span className="dashboard-timeline__track" aria-label={row.start && row.end ? `${formatDate(row.start)} — ${formatDate(row.end)}` : 'Даты не указаны'}>
          {row.start && row.end ? <span className={`dashboard-timeline__bar dashboard-timeline__bar--${row.status}`} style={{ left: `${row.left}%`, width: `${row.width}%` }}><span style={{ width: `${row.progress}%` }} /></span> : <span className="dashboard-timeline__unknown">Уточнить даты</span>}
          {view.todayPosition !== null && <span className="dashboard-timeline__today" style={{ left: `${view.todayPosition}%` }} />}
          {view.contractPosition !== null && <span className="dashboard-timeline__contract" style={{ left: `${view.contractPosition}%` }} />}
        </span>
      </button>)}
      <div className="dashboard-timeline__legend"><span><i /> Сегодня</span><span><i /> Срок договора</span><span>Нажмите на этап, чтобы открыть подробности</span></div>
    </div> : <div className="dashboard-timeline__empty"><CalendarRange size={25} /><p>График появится после подготовки ППР.</p><button className="button button--secondary" type="button" onClick={() => onNavigate('schedule')}>Подготовить график</button></div>}
    {forecast.unmappedWork.length > 0 && <p className="dashboard-timeline__notice">В прогнозе ещё не учтены: {forecast.unmappedWork.join(', ')}.</p>}
    {forecast.kind === 'estimated' && <p className="dashboard-timeline__notice">Предварительный прогноз по внесённым работам. Остатки и зависимости нужно подтвердить.</p>}
  </section>;
}

export function ProjectSectionCards({ state, role, onNavigate }: Props) {
  const openTasks = state.tasks.filter(item => !['done', 'canceled'].includes(item.status));
  const awaiting = state.checkpoints.filter(item => item.status !== 'accepted');
  const cards = [
    { page: 'tasks' as const, title: 'Задачи', value: `${openTasks.length}`, detail: openTasks[0]?.title || 'Нет открытых задач', icon: ListTodo },
    { page: 'project' as const, title: 'Документы и фото', value: `${state.documents.length}`, detail: `${state.fieldReports.length} фотоотчётов · открыть оригиналы`, icon: FileText },
    { page: 'procurement' as const, title: 'Снабжение', value: `${state.procurement.length}`, detail: 'Материалы и даты поставок', icon: PackageSearch },
    { page: 'quality' as const, title: 'Качество', value: `${state.checkpoints.length - awaiting.length}/${state.checkpoints.length}`, detail: 'Контрольные точки приняты', icon: ShieldCheck },
  ];
  return <section className="project-section-cards" aria-label="Разделы проекта">{cards.filter(card => role !== 'client' || ['project', 'quality'].includes(card.page)).map(card => <button key={card.page} type="button" onClick={() => onNavigate(card.page)}><span className="project-section-cards__icon"><card.icon size={21} /></span><span><small>{card.title}</small><strong>{card.value}</strong><span>{card.detail}</span></span><ArrowUpRight size={17} /></button>)}</section>;
}
