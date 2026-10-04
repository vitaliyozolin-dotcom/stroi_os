import { useState } from 'react';
import type { AppState, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import type { StageAction } from '../application/stage-control';
import { StageControlModal } from './StageControlModal';
import { ScheduleReconciliation } from './ScheduleReconciliation';
import { Modal } from './Ui';
import { formatDate } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import { confirmedSiteUpdate } from '../../sites/lib/schedule-forecast.js';

export function StageQuickUpdate({ state, stageId, role, actor, userId, onChange, onClose, onNavigate }: {
  state: AppState; stageId: string; role: UserRole; actor: string; userId?: string;
  onChange: (state: AppState) => void; onClose: () => void; onNavigate: (page: PageId) => void;
}) {
  const [action, setAction] = useState<StageAction | null>(null);
  const [review, setReview] = useState(false);
  const stage = state.stages.find(item => item.id === stageId);
  if (!stage) return null;
  const allowed = role === 'management' || role === 'foreman' && (!stage.schedule || Boolean(userId && stage.schedule.reporterId === userId));
  if (action) return <StageControlModal {...{ state, stageId, role, actor, userId, onChange, onNavigate }} action={action} onClose={() => setAction(null)} />;
  if (review) return <ScheduleReconciliation {...{ state, role, actor, userId, onChange }} initialId={stageId} onClose={() => setReview(false)} />;
  return <Modal title={stage.shortName || stage.name} subtitle={stageStatusLabel[stage.status]} onClose={onClose}>
    <div className="stage-quick">
      <p>План: <strong>{formatDate(stage.planEnd)}</strong>{confirmedSiteUpdate(stage) ? ' · проверено ' + formatDate(stage.siteUpdate!.asOf) : ' · нужно обновить состояние'}</p>
      {stage.blocker && <p className="blocker-note">{stage.blocker}</p>}
      {allowed && !['accepted', 'awaiting_inspection'].includes(stage.status) && <div className="stage-quick__actions">
        <button className="button button--secondary" onClick={() => setAction('start')}>Начали / работаем</button>
        <button className="button button--primary" onClick={() => setAction('complete')}>Работа готова</button>
        <button className="button button--ghost" onClick={() => setAction('delay')}>Есть задержка</button>
      </div>}
      {stage.status === 'awaiting_inspection' && <><p>Выполнение отмечено{stage.completedOn ? ' ' + formatDate(stage.completedOn) : ''}. Ожидает приёмки.</p>{role === 'management' && <div className="stage-quick__actions"><button className="button button--primary" onClick={() => setAction('accept')}>Принять</button><button className="button button--ghost" onClick={() => setAction('rework')}>Вернуть на доработку</button></div>}</>}
      {stage.status === 'accepted' && <p>Принято{stage.acceptedAt ? ' ' + formatDate(stage.acceptedAt.slice(0, 10)) : ''}. История сохранена.</p>}
      <button className="button button--secondary" onClick={() => setReview(true)}>{allowed ? 'Обновить остаток и прогноз' : 'Посмотреть сведения'}</button>
      <p className="muted">Короткий отчёт и дата подтверждают изменение. Готовую работу отдельно принимает управление.</p>
    </div>
  </Modal>;
}
