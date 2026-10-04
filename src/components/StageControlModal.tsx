import { useState, type FormEvent } from 'react';
import type { AppState, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { applyStageControl, type StageAction } from '../application/stage-control';
import { planToday } from '../../sites/lib/plan-baseline.js';
import { stageCanStart, stageGaps, stageControlFingerprint } from '../../sites/lib/stage-control.js';
import { Field, Modal } from './Ui';
import { money } from '../presentation/formatting';

export function StageControlModal(props: { state: AppState; stageId: string; action: StageAction; actor: string; role: UserRole; userId?: string; onChange: (s: AppState) => void; onClose: () => void; onNavigate?: (p: PageId) => void }) {
  const stage = props.state.stages.find((s) => s.id === props.stageId);
  if (stage && props.role === 'management' && props.userId === 'owner' && ['complete', 'accept', 'owner_accept'].includes(props.action) && stage.schedule?.kind !== 'summary') {
    return <OwnerAcceptanceForm key={`${props.state.project.id}-${stage.id}`} {...props} />;
  }
  return stage ? <StageForm key={`${props.state.project.id}-${stage.id}-${props.action}`} {...props} /> : null;
}

function OwnerAcceptanceForm({ state, stageId, actor, role, userId, onChange, onClose }: Parameters<typeof StageControlModal>[0]) {
  const stage = state.stages.find(s => s.id === stageId)!;
  const [exactDate, setExactDate] = useState(Boolean(stage.completedOn));
  const [date, setDate] = useState(stage.completedOn || stage.completionObservedOn || planToday());
  const [note, setNote] = useState('');
  const [openedState, setOpenedState] = useState(() => stageControlFingerprint(stage));
  const [error, setError] = useState('');
  const changed = stageControlFingerprint(stage) !== openedState;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) { setError('Сведения об этапе изменились. Проверьте обновление перед подтверждением.'); return; }
    try {
      onChange(applyStageControl(state, stageId, 'owner_accept', { date: exactDate ? date : planToday(), note, tasks: [], completionDateUnknown: !exactDate }, actor, role, userId));
      onClose();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); }
  };
  if (stage.status === 'accepted') return <Modal title="Этап уже подтверждён" subtitle={stage.name} onClose={onClose}><p>Подтверждение сохранено. Повторно закрывать этап не нужно.</p><button className="button button--primary" type="button" onClick={onClose}>Готово</button></Modal>;
  return <Modal title="Подтвердить выполнение" subtitle={stage.name} onClose={onClose}>
    <form className="modal-form stage-control-form" onSubmit={submit}>
      <p>Ты подтверждаешь, что этап выполнен. Запишем твоё решение и дату подтверждения.</p>
      {!stage.completedOn && <label className="stage-check"><input type="checkbox" checked={exactDate} onChange={e => setExactDate(e.target.checked)} /><span>Знаю точную дату выполнения</span></label>}
      {exactDate && <Field label="Дата выполнения"><input type="date" required value={date} min={stage.actualStart} max={stage.completionObservedOn || planToday()} readOnly={Boolean(stage.completedOn)} onChange={e => setDate(e.target.value)} /></Field>}
      {!exactDate && <p className="muted">Точная дата выполнения останется неизвестной.</p>}
      <Field label="Комментарий · необязательно"><textarea rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="Что проверил или что важно сохранить" /></Field>
      <p className="muted">Фото и отчёт прораба не нужны для этого подтверждения. Задачи, контроль качества и оплаты сохраняют свои записи.</p>
      {error && <p className="danger-text" role="alert">{error}</p>}
      {changed && <div className="stage-control-list"><p>Текущий результат: {stage.completionNote || 'пока не указан'}{stage.blocker ? ` · ${stage.blocker}` : ''}</p><button className="text-button" type="button" onClick={() => { setOpenedState(stageControlFingerprint(stage)); setExactDate(Boolean(stage.completedOn)); setDate(stage.completedOn || stage.completionObservedOn || planToday()); setError(''); }}>Обновить сведения, сохранив комментарий</button></div>}
      <div className="modal__actions"><button type="button" className="button button--ghost" onClick={onClose}>Отмена</button><button type="submit" className="button button--primary">Подтверждаю, этап выполнен</button></div>
    </form>
  </Modal>;
}
function StageForm({ state, stageId, action, actor, role, userId, onChange, onClose, onNavigate }: Parameters<typeof StageControlModal>[0]) {
  const stage = state.stages.find((s) => s.id === stageId)!;
  const [date, setDate] = useState(action === 'delay' ? (stage.forecastEnd >= planToday() ? stage.forecastEnd : '') : action === 'complete' ? stage.completedOn || planToday() : action === 'start' ? stage.actualStart || planToday() : planToday());
  const [note, setNote] = useState(action === 'accept' ? stage.completionNote || '' : '');
  const [unknownDate, setUnknownDate] = useState(false);
  const [tasks, setTasks] = useState<string[]>([]), [error, setError] = useState(''), [resolved, setResolved] = useState(false);
  const [remaining, setRemaining] = useState('');
  const [readyOn, setReadyOn] = useState(planToday());
  const [nextAction, setNextAction] = useState('');
  const [issueOwner, setIssueOwner] = useState(stage.responsible || '');
  const [openedState] = useState(() => stageControlFingerprint(stage));
  const hasRemaining = Boolean(stage.schedule && ['start', 'delay'].includes(action));
  const gaps = stageGaps(state, stageId);
  const expenses = state.financeEntries.filter((e) => e.stageId === stageId && e.kind === 'expense');
  const labels = { start: 'Работы начались', not_started: 'Работы ещё не начались', complete: 'Этап выполнен?', accept: 'Приёмка этапа', owner_accept: 'Подтвердить выполнение', delay: 'Что задерживает этап?', rework: 'Вернуть на доработку' };
  const submit = (event: FormEvent) => { event.preventDefault(); try {
    if (stageControlFingerprint(stage) !== openedState) throw new Error('Этап обновился, пока форма была открыта. Откройте его заново перед сохранением.');
    onChange(applyStageControl(state, stageId, action, { date, note, tasks: unknownDate ? [] : tasks, completionDateUnknown: unknownDate, blockerResolved: resolved, ...(hasRemaining ? { remainingDays: Number(remaining), readyOn, nextAction, issueOwner } : {}) }, actor, role, userId)); onClose();
  } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); } };
  const open = (p: PageId) => { onClose(); onNavigate?.(p); };
  return <Modal title={labels[action]} subtitle={stage.name} onClose={onClose}><form className="modal-form stage-control-form" onSubmit={submit}>
    {action === 'start' && !stageCanStart(state, stage) && <p className="blocker-note">Готовность по зависимостям не подтверждена. Если работы уже фактически идут, укажите причину раннего начала; связи потребуется сверить.</p>}
    {action === 'not_started' && <p className="muted">Дата ниже — дата наблюдения, а не начало работ. Ожидаемый старт и остаток укажите в сверке. Факты выполнения и расходы не создаются.</p>}
    {action === 'complete' && role === 'management' && !stage.completedOn && stage.schedule?.kind !== 'summary' && <label className="stage-check"><input type="checkbox" checked={unknownDate} onChange={e => setUnknownDate(e.target.checked)} /><span>Работа выполнена, точная дата окончания неизвестна</span></label>}
    <Field label={unknownDate ? 'Дата наблюдения — к этому дню уже сделано' : action === 'delay' ? 'Ожидаемое окончание этапа' : action === 'accept' ? 'Дата приёмки' : action === 'start' ? 'Фактическое начало' : 'Дата факта'}><input required type="date" min={action === 'delay' ? planToday() : undefined} max={action !== 'delay' ? planToday() : undefined} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
    {unknownDate && <p className="muted">Запишем готовность на дату наблюдения. Точная дата выполнения, задачи и приёмка остаются неподтверждёнными.</p>}
    {hasRemaining && <><Field label="Осталось рабочих дней"><input required type="number" min={1} max={730} step={1} value={remaining} onChange={event => setRemaining(event.target.value)} /><small>Остаток на конец сегодня. Общий прогноз учитывает связи и бригады.</small></Field>
      {action === 'delay' && <><Field label="С какого дня можем продолжить"><input required type="date" min={planToday()} value={readyOn} onChange={event => setReadyOn(event.target.value)} /></Field><Field label="Ближайшее действие"><input required maxLength={1000} value={nextAction} onChange={event => setNextAction(event.target.value)} /></Field><Field label="Кто решает"><input required maxLength={120} value={issueOwner} onChange={event => setIssueOwner(event.target.value)} /></Field></>}
    </>}
    <Field label={action === 'delay' ? 'Причина · кто решает · ближайшее действие' : 'Результат / основание'}><textarea required rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Что сделано или что мешает; акт, замер, ссылка на подтверждение" /></Field>
    {stage.blocker && ['start', 'complete', 'accept'].includes(action) && <label className="stage-check"><input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} /><span>Препятствие устранено: {stage.blocker}</span></label>}
    {['complete', 'accept'].includes(action) && <>
      {!unknownDate && gaps.tasks.length > 0 && <div className="stage-control-list"><strong>Отметьте действительно выполненные задачи</strong>{gaps.tasks.map((t) => <label className="stage-check" key={t.id}><input type="checkbox" disabled={role !== 'management' && t.assigneeId !== userId} checked={tasks.includes(t.id)} onChange={(e) => setTasks(e.target.checked ? [...tasks, t.id] : tasks.filter((id) => id !== t.id))} /><span>{t.title}<small>{t.assigneeName}{t.reviewerId ? ' · с отдельной проверкой' : ''}</small></span></label>)}</div>}
      {gaps.checkpoints.length > 0 && <div className="stage-control-list"><strong>Осталось принять контрольные точки</strong>{gaps.checkpoints.map((p) => <p key={p.id}>{p.title}</p>)}{onNavigate && <button type="button" className="text-button" onClick={() => open('quality')}>Открыть качество</button>}</div>}
      {role === 'foreman' && <p className="muted">Здесь показаны доступные вам задачи. Полную готовность этапа проверяет сервер; принимает управление.</p>}
      <p className="muted">{action === 'complete' ? 'Запишем выполнение и отправим этап на приёмку. Неподтверждённые задачи не закроются.' : 'Приёмка откроет зависимые этапы для начала. Уже идущие параллельные работы сохранят свой статус.'} Расходы и оплаты автоматически не проводятся.</p>
      {expenses.length > 0 && <div className="stage-control-list"><strong>Связанные расходы</strong>{expenses.map((e) => <p key={e.id}>{e.description} · {money(e.amount)}</p>)}{onNavigate && <button type="button" className="text-button" onClick={() => open('finance')}>Открыть расходы</button>}</div>}
    </>}
    {error && <p className="danger-text" role="alert">{error}</p>}
    <div className="modal__actions"><button type="button" className="button button--ghost" onClick={onClose}>Отмена</button><button className="button button--primary" type="submit">{action === 'complete' ? 'Да, выполнен — на приёмку' : action === 'accept' ? 'Подтвердить приёмку' : 'Сохранить'}</button></div>
  </form></Modal>;
}
