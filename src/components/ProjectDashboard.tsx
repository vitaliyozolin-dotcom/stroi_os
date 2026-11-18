import { ArrowUpRight, FileText, ListTodo, PackageSearch, ShieldCheck, Image } from 'lucide-react';
import type { AppState, DashboardWidget, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { automaticSchedule } from '../domain/construction/index.js';
import { constructionOverview } from '../domain/construction-overview';
import { formatDate, formatDateTime } from '../presentation/formatting';
import { useScheduleToday } from './ProjectScheduleDates';
import { SectionHeader } from './Ui';
import { useState } from 'react';
import { Modal } from './Ui';
import { ProjectFilePreview } from './ProjectFilePreview';
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
  if (view.stages.length > 0 && view.accepted === view.stages.length) return <div className="project-position"><div><small>Текущий этап</small><strong>Строительные работы приняты</strong><span>{view.accepted} из {view.stages.length} внесённых работ</span></div><div><small>Следующий шаг</small><strong>Проверить сдачу и расчёты</strong><span>Приёмка заказчиком, документы и условия завершения</span></div><button type="button" className="button button--secondary" onClick={() => onNavigate('project')}>Открыть проект <ArrowUpRight size={16} /></button></div>;
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
  const accepted = view.rows.filter(row => row.status === 'accepted').length;
  const forecastLabel = forecast.kind === 'actual' ? 'Фактическое окончание' : forecast.kind === 'observed' ? 'Готовность подтверждена на' : 'Прогноз по ППР';
  return <section className="panel overview-schedule" aria-label="Сроки проекта">
    <SectionHeader title="Сроки проекта" action={<button type="button" className="text-button" onClick={() => onNavigate('schedule')}>Полный график <ArrowUpRight size={16} /></button>} />
    <div className="overview-schedule__dates">
      <div><small>Сдача по договору</small><strong>{state.project.targetDate ? formatDate(state.project.targetDate, true) : 'Не указана'}</strong></div>
      <div><small>{forecastLabel}</small><strong>{forecast.end ? formatDate(forecast.end, true) : 'Нужны сроки'}</strong></div>
      <div><small>Относительно договора</small><strong className={view.contractDelta !== null && view.contractDelta > 0 ? 'danger-text' : ''}>{view.contractDelta === null ? 'Нужна сверка' : view.contractDelta > 0 ? `+${view.contractDelta} дней` : view.contractDelta < 0 ? `Раньше на ${Math.abs(view.contractDelta)} дн.` : 'В срок'}</strong></div>
    </div>
    <div className="overview-schedule__foot"><span>{view.rows.length ? `Принято ${accepted} из ${view.rows.length} работ` : 'План работ ещё не составлен'}</span><span>{forecast.unmappedWork.length ? `Без полного расчёта сроков: ${forecast.unmappedWork.length}` : forecast.kind === 'estimated' ? 'Предварительно · по внесённым работам' : forecast.kind === 'observed' ? 'Точная дата окончания не установлена' : 'Даты учитывают параллельные работы'}</span></div>
  </section>;
}

export function OverviewWorkCards({ state, role, show, onNavigate }: Props & { show: (widget: DashboardWidget) => boolean }) {
  const today = useScheduleToday();
  const tasks = state.tasks.filter(item => !['done', 'canceled'].includes(item.status) && !item.id.startsWith('auto-stage-'))
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const supplies = state.procurement.filter(item => !['accepted', 'issued'].includes(item.status))
    .sort((a, b) => (a.expectedDeliveryDate || a.neededBy || '9999').localeCompare(b.expectedDeliveryDate || b.neededBy || '9999'));
  const checkpoints = state.checkpoints.filter(item => role !== 'client' || item.clientVisible);
  const quality = checkpoints.filter(item => item.status !== 'accepted').sort((a, b) => ({ rework: 0, in_review: 1, pending: 2 }[a.status as 'rework' | 'in_review' | 'pending'] - { rework: 0, in_review: 1, pending: 2 }[b.status as 'rework' | 'in_review' | 'pending']));
  const documents = state.documents.filter(item => role !== 'client' || item.clientVisible).slice().sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  const awaiting = state.stages.find(item => item.status === 'awaiting_inspection' && item.schedule?.kind !== 'summary');
  const supplyLabels = { need: 'Нужно заказать', rfq: 'Выбираем поставщика', ordered: 'Заказано', in_transit: 'В пути', delivered: 'Принять поставку', accepted: 'Принято', issued: 'В работе' };
  const qualityLabels = { pending: 'Ожидает отчёта', in_review: 'На проверке', rework: 'Нужна доработка', accepted: 'Принято' };
  const docLabels = { draft: 'Черновик', current: 'Актуальный', signed: 'Подписан' };
  return <section className="overview-work-grid" aria-label="Ближайшая работа по проекту">
    {role !== 'client' && show('tasks') && <article className="panel overview-work-card overview-work-card--tasks"><header className="overview-block-heading"><ListTodo size={18} aria-hidden="true" /><h2>Ближайшие действия</h2><span>{tasks.length + (role === 'management' && awaiting ? 1 : 0)}</span></header>
      {role === 'management' && awaiting && <button type="button" className="overview-work-row" onClick={() => onNavigate('schedule', awaiting.id)}><strong>Принять: {awaiting.shortName || awaiting.name}</strong><small>Работа передана на проверку</small></button>}
      {tasks.slice(0, awaiting && role === 'management' ? 2 : 3).map(task => <button type="button" className="overview-work-row" key={task.id} onClick={() => onNavigate('tasks', task.id)}><strong>{task.title}</strong><small className={task.dueDate && task.dueDate < today ? 'danger-text' : ''}>{task.dueDate ? `${task.dueDate < today ? 'Просрочено · ' : ''}${formatDate(task.dueDate)}` : 'Срок не назначен'} · {task.assigneeName || 'Назначить ответственного'}</small></button>)}
      {!tasks.length && !(role === 'management' && awaiting) && <p className="overview-work-empty">Открытых задач пока нет. Следующий шаг — в маршруте проекта.</p>}
      <button type="button" className="text-button overview-work-link" onClick={() => onNavigate('tasks')}>Канбан задач <ArrowUpRight size={16} /></button></article>}
    {role !== 'client' && show('supply') && <article className="panel overview-work-card overview-work-card--supply"><header className="overview-block-heading"><PackageSearch size={18} aria-hidden="true" /><h2>Поставки</h2><span>{supplies.length}</span></header>
      {supplies.slice(0, 2).map(item => <button type="button" className="overview-work-row" key={item.id} onClick={() => onNavigate('procurement', item.id)}><strong>{item.item}</strong><small>{supplyLabels[item.status]} · {item.expectedDeliveryDate || item.neededBy ? formatDate(item.expectedDeliveryDate || item.neededBy) : 'Срок не указан'}</small>{item.risk && <small className="danger-text">{item.risk}</small>}</button>)}
      {!supplies.length && <p className="overview-work-empty">Нет открытых потребностей и поставок.</p>}
      <button type="button" className="text-button overview-work-link" onClick={() => onNavigate('procurement')}>Открыть снабжение <ArrowUpRight size={16} /></button></article>}
    {show('quality') && <article className="panel overview-work-card overview-work-card--quality"><header className="overview-block-heading"><ShieldCheck size={18} aria-hidden="true" /><h2>Качество</h2><span>{quality.length}</span></header>
      {quality.slice(0, 2).map(item => <button type="button" className="overview-work-row" key={item.id} onClick={() => onNavigate('quality', item.id)}><strong>{item.title}</strong><small className={item.status === 'rework' ? 'danger-text' : ''}>{qualityLabels[item.status]} · {item.assignee || 'Ответственный не назначен'}</small></button>)}
      {!quality.length && <p className="overview-work-empty">{checkpoints.length ? `Все ${checkpoints.length} внесённых контрольных точек приняты.` : 'Контрольные точки ещё не настроены.'}</p>}
      <button type="button" className="text-button overview-work-link" onClick={() => onNavigate('quality')}>Контроль качества <ArrowUpRight size={16} /></button></article>}
    <article className="panel overview-work-card overview-work-card--documents"><header className="overview-block-heading"><FileText size={18} aria-hidden="true" /><h2>Документы</h2><span>{documents.length}</span></header>
      {documents.slice(0, 2).map(item => <button type="button" className="overview-work-row" key={item.id} onClick={() => onNavigate('project', item.id)}><strong>{item.name}</strong><small>{docLabels[item.status]} · {item.fileKey ? 'Открыть оригинал' : 'Оригинал не приложен'}</small></button>)}
      {!documents.length && <p className="overview-work-empty">Документы ещё не добавлены.</p>}
      <button type="button" className="text-button overview-work-link" onClick={() => onNavigate('project')}>Документы проекта <ArrowUpRight size={16} /></button></article>
  </section>;
}

export function OverviewLatestPhoto({ state, role }: Props) {
  const { photo, photoStage } = constructionOverview(state, role);
  const [opened, setOpened] = useState(false);
  if (!photo) return null;
  const url = `/api/field-reports/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(photo.file.key)}`;
  return <section className="panel overview-latest-photo"><button type="button" className="overview-latest-photo__image" onClick={() => setOpened(true)} aria-label="Открыть последнее фото объекта"><img src={`${url}&preview=1`} alt={photo.report.note || photo.file.name} loading="lazy" /></button><div><span className="eyebrow"><Image size={16} /> Последнее фото объекта</span><h2>{photoStage?.name || 'Фотоотчёт'}</h2><p>{photo.report.note || photo.file.name}</p><small>{formatDateTime(photo.report.createdAt)} · {photo.report.author}</small><button type="button" className="text-button" onClick={() => setOpened(true)}>Открыть фото <ArrowUpRight size={16} /></button></div>{opened && <Modal wide title={photo.file.name} subtitle={photoStage?.name} onClose={() => setOpened(false)}><ProjectFilePreview url={url} name={photo.file.name} /></Modal>}</section>;
}
