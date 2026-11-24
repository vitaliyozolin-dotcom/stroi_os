import { useState } from 'react';
import type { AppState, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import type { StageAction } from '../application/stage-control';
import { StageControlModal } from './StageControlModal';
import { ScheduleReconciliation } from './ScheduleReconciliation';
import { Modal } from './Ui';
import { formatDate } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import { confirmedSiteUpdate } from '../domain/construction/index.js';
import { constructionLaunchBlockers } from '../domain/project-lifecycle.js';
import { planToday } from '../domain/construction/index.js';

export function StageQuickUpdate({ state, stageId, role, actor, userId, onChange, onClose, onNavigate }: {
  state: AppState; stageId: string; role: UserRole; actor: string; userId?: string;
  onChange: (state: AppState) => void; onClose: () => void; onNavigate: (page: PageId) => void;
}) {
  const [action, setAction] = useState<StageAction | null>(null);
  const [review, setReview] = useState(false);
  const stage = state.stages.find(item => item.id === stageId);
  if (!stage) return null;
  const allowed = role === 'management' || role === 'foreman' && (!stage.schedule || Boolean(userId && stage.schedule.reporterId === userId));
  const launchLocked = state.project.lifecycle?.phase === 'preparation' && constructionLaunchBlockers(state).length > 0;
  const supplies = state.procurement.filter(item => item.stageId === stage.id);
  const quotes = state.supplierQuotes.filter(quote => supplies.some(item => item.id === quote.procurementItemId));
  const isSitePreparation = /^(?:\d+[.·\s-]+)?подготовк[аи](?:\s|$)/i.test(stage.shortName || stage.name);
  const stageTasks = state.tasks.filter(task => task.stageId === stage.id && task.status !== 'canceled');
  const ownerCanConfirm = role === 'management' && userId === 'owner' && stage.schedule?.kind !== 'summary';
  if (action) return <StageControlModal {...{ state, stageId, role, actor, userId, onChange, onNavigate }} action={action} onClose={() => setAction(null)} />;
  if (review) return <ScheduleReconciliation {...{ state, role, actor, userId, onChange }} initialId={stageId} onClose={() => setReview(false)} />;
  return <Modal side title={stage.shortName || stage.name} subtitle={stageStatusLabel[stage.status]} onClose={onClose}>
    <div className="stage-quick">
      {isSitePreparation && <details open>
        <summary>Готовность площадки</summary>
        <ul>
          <li>Электричество или генератор</li>
          <li>Бытовка</li>
          <li>Бригада и дата выхода</li>
          <li>Подъезд и разгрузка</li>
          <li>Место хранения материалов</li>
        </ul>
        {stageTasks.length > 0 && <dl className="stage-facts">
          {stageTasks.map(task => <div key={task.id}><dt>{task.title}</dt><dd>{task.status === 'done' ? 'Выполнено' : 'Открыто'}{task.assigneeName ? ` · ${task.assigneeName}` : ''}</dd></div>)}
        </dl>}
        <button type="button" className="text-button" onClick={() => onNavigate('tasks')}>Открыть задачи</button>
      </details>}
      <dl className="stage-facts">
        {!isSitePreparation && <>
          <div><dt>КП</dt><dd>{quotes.length ? <button type="button" className="text-button" onClick={() => onNavigate('procurement')}>{quotes.length} получено · {quotes.filter(quote => quote.status === 'selected').length} выбрано</button> : 'Нет связанных КП'}</dd></div>
          <div><dt>Поставка</dt><dd>{supplies.length ? <button type="button" className="text-button" onClick={() => onNavigate('procurement')}>{supplies.length} позиций</button> : 'Нет связанных поставок'}</dd></div>
        </>}
        <div><dt>Дата начала работ</dt><dd>{formatDate(stage.actualStart || stage.planStart)}{stage.actualStart ? ' · факт' : stage.planStart ? ' · план' : ''}</dd></div>
        <div><dt>Плановое завершение</dt><dd>{formatDate(stage.planEnd)}</dd></div>
        <div><dt>Фактическое завершение</dt><dd>{formatDate(stage.completedOn || stage.actualEnd || '')}</dd></div>
      </dl>
      {confirmedSiteUpdate(stage) && <p className="muted">Состояние проверено {formatDate(stage.siteUpdate!.asOf)}</p>}
      {launchLocked && <p className="blocker-note">Факт работ доступен после закрытия этапа 00.</p>}
      {stage.blocker && <p className="blocker-note">{stage.blocker}</p>}
      {stage.completionObservedOn && !stage.completedOn && <p>Готовность подтверждена на {formatDate(stage.completionObservedOn)}. Точная дата выполнения неизвестна.</p>}
      {allowed && !launchLocked && !['accepted', 'awaiting_inspection'].includes(stage.status) && <div className="stage-quick__actions">
        <button className="button button--secondary" onClick={() => setAction('start')}>Начали / работаем</button>
        <button className="button button--primary" onClick={() => setAction('complete')}>{ownerCanConfirm ? 'Подтвердить выполнение' : 'Работа готова'}</button>
        <button className="button button--ghost" onClick={() => setAction('delay')}>Есть задержка</button>
      </div>}
      {stage.status === 'awaiting_inspection' && <><p>Выполнение отмечено{stage.completedOn ? ' ' + formatDate(stage.completedOn) : ''}. Ожидает приёмки.</p>{role === 'management' && <div className="stage-quick__actions"><button className="button button--primary" onClick={() => setAction('accept')}>{ownerCanConfirm ? 'Подтвердить выполнение' : 'Принять'}</button><button className="button button--ghost" onClick={() => setAction('rework')}>Вернуть на доработку</button></div>}</>}
      {stage.status === 'accepted' && <p>{stage.ownerAcceptance ? `Принято владельцем: ${stage.ownerAcceptance.by || stage.acceptedBy || actor}` : 'Принято'}{stage.acceptedAt ? ' · ' + formatDate(planToday(new Date(stage.acceptedAt))) : ''}. История сохранена.</p>}
      <button className="button button--secondary" onClick={() => setReview(true)}>{allowed ? 'Обновить остаток и прогноз' : 'Посмотреть сведения'}</button>
      {!ownerCanConfirm && <p className="muted">Короткий отчёт и дата подтверждают изменение. Готовую работу отдельно принимает управление.</p>}
    </div>
  </Modal>;
}
