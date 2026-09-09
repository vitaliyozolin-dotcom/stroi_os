import { useState, type FormEvent } from 'react';
import type { AppState, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { applyStageControl, type StageAction } from '../application/stage-control';
import { planToday } from '../../sites/lib/plan-baseline.js';
import { stageCanStart, stageGaps } from '../../sites/lib/stage-control.js';
import { Field, Modal } from './Ui';
import { money } from '../presentation/formatting';

export function StageControlModal(props: { state: AppState; stageId: string; action: StageAction; actor: string; role: UserRole; userId?: string; onChange: (s: AppState) => void; onClose: () => void; onNavigate?: (p: PageId) => void }) {
  const stage = props.state.stages.find((s) => s.id === props.stageId);
  return stage ? <StageForm key={`${props.state.project.id}-${stage.id}-${props.action}`} {...props} /> : null;
}
function StageForm({ state, stageId, action, actor, role, userId, onChange, onClose, onNavigate }: Parameters<typeof StageControlModal>[0]) {
  const stage = state.stages.find((s) => s.id === stageId)!;
  const [date, setDate] = useState(action === 'delay' ? (stage.forecastEnd >= planToday() ? stage.forecastEnd : '') : action === 'complete' ? stage.completedOn || planToday() : planToday());
  const [note, setNote] = useState(action === 'accept' ? stage.completionNote || '' : '');
  const [tasks, setTasks] = useState<string[]>([]), [error, setError] = useState(''), [resolved, setResolved] = useState(false);
  const gaps = stageGaps(state, stageId);
  const expenses = state.financeEntries.filter((e) => e.stageId === stageId && e.kind === 'expense');
  const labels = { start: 'Работы начались', not_started: 'Работы ещё не начались', complete: 'Этап выполнен?', accept: 'Приёмка этапа', delay: 'Что задерживает этап?', rework: 'Вернуть на доработку' };
  const submit = (event: FormEvent) => { event.preventDefault(); try { onChange(applyStageControl(state, stageId, action, { date, note, tasks, blockerResolved: resolved }, actor, role, userId)); onClose(); } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить'); } };
  const open = (p: PageId) => { onClose(); onNavigate?.(p); };
  return <Modal title={labels[action]} subtitle={stage.name} onClose={onClose}><form className="modal-form stage-control-form" onSubmit={submit}>
    {action === 'start' && !stageCanStart(state, stage) && <p className="blocker-note">Готовность по зависимостям не подтверждена. Если работы уже фактически идут, укажите причину раннего начала; связи потребуется сверить.</p>}
    {action === 'not_started' && <p className="muted">Дата ниже — дата наблюдения, а не начало работ. Ожидаемый старт и остаток укажите в сверке. Факты выполнения и расходы не создаются.</p>}
    <Field label={action === 'delay' ? 'Ожидаемое окончание этапа' : action === 'accept' ? 'Дата приёмки' : action === 'start' ? 'Фактическое начало' : 'Дата факта'}><input required type="date" min={action === 'delay' ? planToday() : undefined} max={action !== 'delay' ? planToday() : undefined} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
    <Field label={action === 'delay' ? 'Причина · кто решает · ближайшее действие' : 'Результат / основание'}><textarea required rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Что сделано или что мешает; акт, замер, ссылка на подтверждение" /></Field>
    {stage.blocker && ['start', 'complete', 'accept'].includes(action) && <label className="stage-check"><input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} /><span>Препятствие устранено: {stage.blocker}</span></label>}
    {['complete', 'accept'].includes(action) && <>
      {gaps.tasks.length > 0 && <div className="stage-control-list"><strong>Отметьте действительно выполненные задачи</strong>{gaps.tasks.map((t) => <label className="stage-check" key={t.id}><input type="checkbox" disabled={role !== 'management' && t.assigneeId !== userId} checked={tasks.includes(t.id)} onChange={(e) => setTasks(e.target.checked ? [...tasks, t.id] : tasks.filter((id) => id !== t.id))} /><span>{t.title}<small>{t.assigneeName}{t.reviewerId ? ' · с отдельной проверкой' : ''}</small></span></label>)}</div>}
      {gaps.checkpoints.length > 0 && <div className="stage-control-list"><strong>Осталось принять контрольные точки</strong>{gaps.checkpoints.map((p) => <p key={p.id}>{p.title}</p>)}{onNavigate && <button type="button" className="text-button" onClick={() => open('quality')}>Открыть качество</button>}</div>}
      {role === 'foreman' && <p className="muted">Здесь показаны доступные вам задачи. Полную готовность этапа проверяет сервер; принимает управление.</p>}
      <p className="muted">{action === 'complete' ? 'Запишем выполнение и отправим этап на приёмку. Неподтверждённые задачи не закроются.' : 'Приёмка откроет зависимые этапы для начала. Уже идущие параллельные работы сохранят свой статус.'} Расходы и оплаты автоматически не проводятся.</p>
      {expenses.length > 0 && <div className="stage-control-list"><strong>Связанные расходы</strong>{expenses.map((e) => <p key={e.id}>{e.description} · {money(e.amount)}</p>)}{onNavigate && <button type="button" className="text-button" onClick={() => open('finance')}>Открыть расходы</button>}</div>}
    </>}
    {error && <p className="danger-text" role="alert">{error}</p>}
    <div className="modal__actions"><button type="button" className="button button--ghost" onClick={onClose}>Отмена</button><button className="button button--primary" type="submit">{action === 'complete' ? 'Да, выполнен — на приёмку' : action === 'accept' ? 'Подтвердить приёмку' : 'Сохранить'}</button></div>
  </form></Modal>;
}
