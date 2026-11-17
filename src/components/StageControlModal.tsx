import { useModuleRepository } from '../useModuleRepository';
import { createConstructionRepository } from '../infrastructure/module-project';
import { systemClock, runtimeIdGenerator } from '../infrastructure/runtime';
import { useState, type FormEvent } from 'react';
import type { AppState, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { createStageControlUseCases, stageCommandSnapshot, type StageAction } from '../application/stage-control';
import { planToday } from '../domain/construction/index.js';
import { stageCanStart, stageGaps } from '../domain/construction/index.js';
import { Field, Modal } from './Ui';
import { SchedulePaymentImpact } from './SchedulePaymentImpact';
import { previewStageControl } from '../application/schedule-payment-preview';
import { constructionLaunchBlockers } from '../domain/project-lifecycle.js';
import './project-lifecycle-dashboard.css';

export function StageControlModal(props: { state: AppState; stageId: string; action: StageAction; actor: string; role: UserRole; userId?: string; onChange: (s: AppState) => void; onClose: () => void; onNavigate?: (p: PageId) => void }) {
  const stage = props.state.stages.find((s) => s.id === props.stageId);
  if (!stage) return null;
  if (stage.status === 'accepted' && ['complete', 'accept', 'owner_accept'].includes(props.action)) return <Modal title="Этап уже принят" subtitle={stage.name} onClose={props.onClose}><p>Повторное подтверждение не требуется.</p><button className="button button--primary" type="button" onClick={props.onClose}>Готово</button></Modal>;
  const action = props.action === 'owner_accept' ? stage.status === 'awaiting_inspection' ? 'accept' : 'complete' : props.action;
  return <StageForm key={`${props.state.project.id}-${stage.id}-${action}`} {...props} action={action} />;
}
function StageForm({ state, stageId, action, actor, role, userId, onChange, onClose, onNavigate }: Parameters<typeof StageControlModal>[0]) {
  const commands = createStageControlUseCases(useModuleRepository(createConstructionRepository, state, onChange), { name: actor, role, id: userId }, systemClock, runtimeIdGenerator);
  const stage = state.stages.find((s) => s.id === stageId)!;
  const [date, setDate] = useState(action === 'delay' ? (stage.forecastEnd >= planToday() ? stage.forecastEnd : '') : action === 'complete' ? stage.completedOn || planToday() : action === 'start' ? stage.actualStart || planToday() : planToday());
  const [note, setNote] = useState(action === 'accept' ? stage.completionNote || 'Результат проверен и принят.' : action === 'complete' ? 'Исполнитель подтвердил выполнение работы.' : '');
  const [unknownDate, setUnknownDate] = useState(false);
  const [tasks, setTasks] = useState<string[]>([]), [error, setError] = useState(''), [resolved, setResolved] = useState(false);
  const [remaining, setRemaining] = useState('');
  const [readyOn, setReadyOn] = useState(planToday());
  const [nextAction, setNextAction] = useState('');
  const [issueOwner, setIssueOwner] = useState(stage.responsible || '');
  const [openedState] = useState(() => stageCommandSnapshot(state, stageId));
  const hasRemaining = Boolean(stage.schedule && ['start', 'delay'].includes(action));
  const gaps = stageGaps(state, stageId);
  const preview = role === 'management' && state.treasury?.enabled ? previewStageControl(state, { stageId, action, input: { date, note, tasks: unknownDate ? [] : tasks, completionDateUnknown: unknownDate, blockerResolved: resolved, ...(hasRemaining ? { remainingDays: Number(remaining), readyOn, nextAction, issueOwner } : {}) }, expected: openedState }, { name: actor, role, id: userId }, systemClock.now()) : null;
  const labels = { start: 'Работы начались', not_started: 'Работы ещё не начались', complete: 'Подтверждаешь выполнение?', accept: 'Подтверждаешь приёмку?', owner_accept: 'Подтвердить выполнение', delay: 'Что задерживает этап?', rework: 'Вернуть на доработку' };
  const submit = (event: FormEvent) => { event.preventDefault(); try {
    if (stageCommandSnapshot(state, stageId) !== openedState) throw new Error('Этап обновился, пока форма была открыта. Откройте его заново перед сохранением.');
    if (action === 'start') { const launch = constructionLaunchBlockers(state); if (launch.length) throw new Error(`Сначала завершите подготовку: ${launch.join('; ')}`); }
    const result = commands.control({ stageId, action, input: { date, note, tasks: unknownDate ? [] : tasks, completionDateUnknown: unknownDate, blockerResolved: resolved, ...(hasRemaining ? { remainingDays: Number(remaining), readyOn, nextAction, issueOwner } : {}) }, expected: openedState });
    if (!result.ok) throw new Error(result.error);
    onClose();
  } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); } };
  const open = (p: PageId) => { onClose(); onNavigate?.(p); };
  return <Modal title={labels[action]} subtitle={stage.name} onClose={onClose}><form className="modal-form stage-control-form" onSubmit={submit}>
    {action === 'start' && !stageCanStart(state, stage) && <p className="blocker-note">Начало заблокировано: сначала выполните обязательные условия предыдущих работ.</p>}
    {action === 'not_started' && <p className="muted">Дата ниже — дата наблюдения, а не начало работ. Ожидаемый старт и остаток укажите в сверке. Факты выполнения и расходы не создаются.</p>}
    {['complete', 'accept'].includes(action) && <p className="stage-confirm-question">{stage.name}</p>}
    <details className="stage-confirm-details" open={!['complete', 'accept'].includes(action)}><summary>{unknownDate ? 'Дата наблюдения' : action === 'accept' ? 'Дата приёмки' : 'Дата факта'}: {date || 'не указана'} · изменить</summary>
    {action === 'complete' && role === 'management' && !stage.completedOn && stage.schedule?.kind !== 'summary' && <label className="stage-check"><input type="checkbox" checked={unknownDate} onChange={e => setUnknownDate(e.target.checked)} /><span>Работа выполнена, точная дата окончания неизвестна</span></label>}
    <Field label={unknownDate ? 'Дата наблюдения — к этому дню уже сделано' : action === 'delay' ? 'Ожидаемое окончание этапа' : action === 'accept' ? 'Дата приёмки' : action === 'start' ? 'Фактическое начало' : 'Дата факта'}><input required type="date" min={action === 'delay' ? planToday() : undefined} max={action !== 'delay' ? planToday() : undefined} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
    {unknownDate && <p className="muted">Запишем готовность на дату наблюдения. Точная дата выполнения, задачи и приёмка остаются неподтверждёнными.</p>}
    {hasRemaining && <><Field label="Осталось рабочих дней"><input required type="number" min={1} max={730} step={1} value={remaining} onChange={event => setRemaining(event.target.value)} /><small>Остаток на конец сегодня. Общий прогноз учитывает связи и бригады.</small></Field>
      {action === 'delay' && <><Field label="С какого дня можем продолжить"><input required type="date" min={planToday()} value={readyOn} onChange={event => setReadyOn(event.target.value)} /></Field><Field label="Ближайшее действие"><input required maxLength={1000} value={nextAction} onChange={event => setNextAction(event.target.value)} /></Field><Field label="Кто решает"><input required maxLength={120} value={issueOwner} onChange={event => setIssueOwner(event.target.value)} /></Field></>}
    </>}
    <Field label={action === 'delay' ? 'Причина · кто решает · ближайшее действие' : 'Результат / основание'}><textarea required rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Что сделано или что мешает; акт, замер, ссылка на подтверждение" /></Field>
    </details>
    {stage.blocker && ['start', 'complete', 'accept'].includes(action) && <label className="stage-check"><input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} /><span>Препятствие устранено: {stage.blocker}</span></label>}
    {['complete', 'accept'].includes(action) && <>
      {!unknownDate && gaps.tasks.length > 0 && <div className="stage-control-list"><strong>Отметьте действительно выполненные задачи</strong>{gaps.tasks.map((t) => <label className="stage-check" key={t.id}><input type="checkbox" disabled={role !== 'management' && t.assigneeId !== userId} checked={tasks.includes(t.id)} onChange={(e) => setTasks(e.target.checked ? [...tasks, t.id] : tasks.filter((id) => id !== t.id))} /><span>{t.title}<small>{t.assigneeName}{t.reviewerId ? ' · с отдельной проверкой' : ''}</small></span></label>)}</div>}
      {gaps.checkpoints.length > 0 && <div className="stage-control-list"><strong>Осталось принять контрольные точки</strong>{gaps.checkpoints.map((p) => <p key={p.id}>{p.title}</p>)}{onNavigate && <button type="button" className="text-button" onClick={() => open('quality')}>Открыть качество</button>}</div>}
      {role === 'foreman' && <p className="muted">Здесь показаны доступные вам задачи. Полную готовность этапа проверяет сервер; принимает управление.</p>}
      <p className="muted">{action === 'complete' ? 'Выполнение будет передано на проверку.' : 'Принятый результат откроет зависимые работы.'}</p>

    </>}
    <SchedulePaymentImpact before={state} preview={preview} role={role} />
    {error && <p className="danger-text" role="alert">{error}</p>}
    <div className="modal__actions"><button type="button" className="button button--ghost" onClick={onClose}>{action === 'complete' ? 'Не выполнено' : 'Отмена'}</button><button className="button button--primary" type="submit">{['complete', 'accept'].includes(action) ? 'Подтверждаю' : 'Сохранить'}</button></div>
  </form></Modal>;
}
