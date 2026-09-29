import { ArrowUpRight, Check, Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';
import type { AppState, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { constructionOverview } from '../domain/construction-overview';
import { formatDate } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';

export function ConstructionNow({ state, role, onNavigate }: { state: AppState; role: UserRole; onNavigate: (page: PageId) => void }) {
  const view = constructionOverview(state, role);
  const [failedPhoto, setFailedPhoto] = useState('');
  const photoUrl = view.photo ? `/api/field-reports/file?projectId=${encodeURIComponent(state.project.id)}&key=${encodeURIComponent(view.photo.file.key)}&preview=1` : '';
  const hasPhoto = photoUrl && failedPhoto !== photoUrl;
  const allAccepted = view.stages.length > 0 && view.accepted === view.stages.length;
  return <section className="construction-now" aria-label="Стройка сейчас">
    <div className="construction-now__head"><h2>Стройка сейчас</h2><button className="text-button" type="button" onClick={() => onNavigate('schedule')}>Все этапы <ArrowUpRight size={16} /></button></div>
    <div className="construction-now__body">
      <button type="button" className="construction-now__photo" onClick={() => onNavigate('project')} aria-label="Открыть полевой дневник объекта">
        {hasPhoto ? <img src={photoUrl} alt={view.photoStage ? `Фото из отчёта: ${view.photoStage.name}` : 'Последнее фото объекта из полевого дневника'} onError={() => setFailedPhoto(photoUrl)} /> : <span className="construction-now__empty-photo"><ImageIcon size={30} /><span>{photoUrl ? 'Фото недоступно' : 'Фото объекта пока нет'}</span></span>}
        {hasPhoto && view.photo && <span className="construction-now__caption">{view.photoStage?.shortName || 'Последнее фото объекта'} · отчёт {formatDate(view.photo.report.createdAt.slice(0, 10))}</span>}
      </button>
      <div className="construction-now__focus">
        <span className="construction-now__eyebrow">{view.current ? view.active.length > 1 ? `Активных этапов: ${view.active.length}` : stageStatusLabel[view.current.status] : allAccepted ? 'Все этапы приняты' : 'Текущий этап не отмечен'}</span>
        <h3>{view.current?.name || (allAccepted ? 'Работы приняты' : view.next ? `Далее: ${view.next.shortName}` : 'Добавьте этапы работ')}</h3>
        <p>{view.current ? `${view.current.responsible || 'Ответственный не указан'}${view.current.planEnd ? ` · план до ${formatDate(view.current.planEnd)}` : ''}` : view.next ? 'Начало работ ещё не подтверждено' : 'График появится после заполнения ППР'}</p>
        {view.current?.blocker && <p className="construction-now__blocker">{view.current.blocker}</p>}
        {role !== 'client' && <button type="button" className="construction-now__action" onClick={() => onNavigate(view.action?.page || 'schedule')}>
          <span><small>Ближайшее действие</small><strong>{view.action?.title || 'Следующий шаг не записан'}</strong><span>{view.action ? [view.action.owner, view.action.date ? `${view.action.dateLabel} ${formatDate(view.action.date)}` : 'Срок не указан'].filter(Boolean).join(' · ') : 'Уточнить в графике работ'}</span></span><ArrowUpRight size={19} />
        </button>}
      </div>
    </div>
    {view.stages.length > 0 && <>
      <ol className="construction-now__stages" aria-label="Этапы от начала до завершения">
        {view.stages.map((stage, index) => <li key={stage.id}><button type="button" className={`construction-stage construction-stage--${stage.status}`} onClick={() => onNavigate('schedule')} aria-label={`${stage.name}: ${stageStatusLabel[stage.status]}`} title={`${stage.name} · ${stageStatusLabel[stage.status]}`}>
          <span className="construction-stage__line" /><span className="construction-stage__point">{stage.status === 'accepted' ? <Check size={12} /> : String(index + 1).padStart(2, '0')}</span><span className="construction-stage__name">{stage.shortName || stage.name}</span>
        </button></li>)}
      </ol>
      <div className="construction-now__legend"><span>Начало</span><span>{view.accepted} из {view.stages.length} приняты · выделены активные</span><span>Завершение</span></div>
    </>}
  </section>;
}
