import { ArrowUpRight, Check, ChevronDown, Image as ImageIcon, LockKeyhole } from 'lucide-react';
import { useId, useState } from 'react';
import { StageQuickUpdate } from './StageQuickUpdate';
import { SiteProgress } from './SiteProgress';
import type { AppState, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { constructionOverview } from '../domain/construction-overview';
import { formatDate } from '../presentation/formatting';
import { constructionLaunchBlockers, lifecycleDefinitions, lifecycleGroupProgress } from '../domain/project-lifecycle.js';
import { PreparationWizard } from './PreparationWizard';
import { Modal } from './Ui';
import { stageStatusLabel } from '../presentation/status-labels';

export function ConstructionNow({ state, role, actor, userId, onChange, onNavigate, preparationStep, onPreparationStep }: { state: AppState; role: UserRole; actor: string; userId?: string; onChange: (state: AppState) => void; onNavigate: (page: PageId, entityId?: string) => void; preparationStep: string | null; onPreparationStep: (key: string | null) => void }) {
  const stagesId = useId();
  const [stagesExpanded, setStagesExpanded] = useState(false);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const preparing = state.project.lifecycle?.phase === 'preparation' && !state.project.lifecycle.legacyReview;
  const preparation = lifecycleGroupProgress(state);
  const nextStep = lifecycleDefinitions.find(item => item.key === preparation.pending[0]);
  const nextItem = state.project.lifecycle?.items.find(item => item.key === nextStep?.key);
  const launchLocked = preparing && constructionLaunchBlockers(state).length > 0;
  const view = constructionOverview(state, role);
  const [failedPhoto, setFailedPhoto] = useState('');
  const photoUrl = view.photo ? `/api/field-reports/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(view.photo.file.key)}&preview=1` : '';
  const hasPhoto = photoUrl && failedPhoto !== photoUrl;
  const allAccepted = view.stages.length > 0 && view.accepted === view.stages.length;
  return <section className="construction-now" aria-label="Текущий этап">
    {preparing ? <div className="launch-summary">
      <span className="launch-summary__number">00</span>
      <div><h2>До стройки</h2>
        <p>{preparation.completed} из {preparation.total} подтверждено</p>
        {nextStep && <p>{nextStep.title} · {nextItem?.owner || 'Назначить ответственного'}{nextItem?.planEnd ? ` · до ${formatDate(nextItem.planEnd)}` : ''}</p>}
      </div>
      <button className="button button--light" type="button" onClick={() => onPreparationStep(nextStep?.key || 'brief')}>Открыть чек-лист <ArrowUpRight size={14} /></button>
      <progress value={preparation.completed} max={preparation.total || 1} aria-label="Готовность к строительству" />
    </div> : <div className={`construction-now__body${hasPhoto ? "" : " construction-now__body--no-photo"}`}>
      {hasPhoto && <button type="button" className="construction-now__photo" onClick={() => onNavigate('project')} aria-label="Открыть полевой дневник объекта">
        {hasPhoto ? <img src={photoUrl} alt={view.photoStage ? `Фото из отчёта: ${view.photoStage.name}` : 'Последнее фото объекта из полевого дневника'} onError={() => setFailedPhoto(photoUrl)} /> : <span className="construction-now__empty-photo"><ImageIcon size={30} /><span>{photoUrl ? 'Фото недоступно' : 'Фото объекта пока нет'}</span></span>}
        {hasPhoto && view.photo && <span className="construction-now__caption">{view.photoStage?.shortName || 'Последнее фото объекта'} · отчёт {formatDate(view.photo.report.createdAt.slice(0, 10))}</span>}
      </button>}
      <div className="construction-now__focus">
        <div className="construction-now__status">
        <span className="construction-now__eyebrow">{view.current ? view.active.length > 1 ? `Активных этапов: ${view.active.length}` : stageStatusLabel[view.current.status] : allAccepted ? 'Все этапы приняты' : 'Текущий этап не отмечен'}</span><button className="text-button" type="button" onClick={() => onNavigate('schedule')}>Все этапы <ArrowUpRight size={14} /></button></div>
        <h3>{view.current?.name || (allAccepted ? 'Работы приняты' : view.next ? `Далее: ${view.next.shortName}` : 'Добавьте этапы работ')}</h3>
        <p>{view.current ? `${view.current.responsible || 'Ответственный не указан'}${view.current.planEnd ? ` · план до ${formatDate(view.current.planEnd)}` : ''}` : view.next ? 'Начало работ ещё не подтверждено' : 'График появится после заполнения ППР'}</p>
        {view.current?.blocker && <p className="construction-now__blocker">{view.current.blocker}</p>}
        {role !== 'client' && <button type="button" className="construction-now__action" onClick={() => onNavigate(view.action?.page || 'schedule')}>
          <span><small>Ближайшее действие</small><strong>{view.action?.title || 'Следующий шаг не записан'}</strong><span>{view.action ? [view.action.owner, view.action.date ? `${view.action.dateLabel} ${formatDate(view.action.date)}` : 'Срок не указан'].filter(Boolean).join(' · ') : 'Уточнить в графике работ'}</span></span><ArrowUpRight size={19} />
        </button>}
        {role !== 'client' && view.stages.length > 0 && <button className="button button--primary" type="button" onClick={() => setSelectedStage((view.current || view.next || view.stages[0]).id)}>Отметить ход работ</button>}
        <SiteProgress state={state} actor={actor} role={role} onChange={onChange} compact />
      </div>
    </div>}
    {view.stages.length > 0 && <>
      <button type="button" className="construction-now__mobile-toggle" aria-expanded={stagesExpanded} aria-controls={stagesId} onClick={() => setStagesExpanded(value => !value)}>
        Этапы строительства <ChevronDown size={16} aria-hidden="true" />
      </button>
      <ol id={stagesId} className="construction-now__stages" data-expanded={stagesExpanded} aria-label="Этапы от начала до завершения">
        {state.project.lifecycle && <li><button type="button" className={`construction-stage${preparing ? ' construction-stage--current' : ''}`} onClick={() => onPreparationStep(nextStep?.key || 'brief')}><span className="construction-stage__point">00</span><span className="construction-stage__name">До стройки</span></button></li>}
        {view.stages.map((stage, index) => <li key={stage.id}><button type="button" className={`construction-stage construction-stage--${stage.status}`} onClick={() => setSelectedStage(stage.id)} aria-label={`${stage.name}: ${stageStatusLabel[stage.status]}`} title={`${stage.name} · ${stageStatusLabel[stage.status]}`}>
          <span className="construction-stage__line" /><span className="construction-stage__point">{launchLocked && index === 0 ? <LockKeyhole size={13} /> : stage.status === 'accepted' ? <Check size={12} /> : String(index + 1).padStart(2, '0')}</span><span className="construction-stage__name">{stage.shortName || stage.name}</span>
        </button></li>)}
      </ol>
      {launchLocked && <p className="launch-hint">Этап 01 доступен после закрытия этапа 00</p>}
      <div className="construction-now__legend"><span>Начало</span><span>{view.accepted} из {view.stages.length} приняты · выделены активные</span><span>Завершение</span></div>
    </>}
    {preparationStep && <Modal side title="00 · До стройки" onClose={() => onPreparationStep(null)}>
      {role === 'management' && preparing ? <PreparationWizard state={state} actor={actor} role={role} onChange={onChange} defaultExpanded initialStep={preparationStep} embedded /> :
        <dl className="stage-facts">{lifecycleDefinitions.filter(def => def.group === 'preparation' && !(def.escrow && state.project.lifecycle?.usesEscrow === 'no')).map(def => {
          const item = state.project.lifecycle?.items.find(row => row.key === def.key);
          return <div key={def.key}><dt>{def.title}</dt><dd>{item?.owner ? `${item.owner} · ` : ''}{preparation.pending.includes(def.key) ? 'Не подтверждено' : item?.status === 'not_applicable' ? 'Не применяется' : 'Подтверждено'}</dd></div>;
        })}</dl>}
    </Modal>}
    {selectedStage && <StageQuickUpdate {...{state, role, actor, userId, onChange, onNavigate}} stageId={selectedStage} onClose={() => setSelectedStage(null)} />}
  </section>;
}
