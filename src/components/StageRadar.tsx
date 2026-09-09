import { useEffect, useState, type FormEvent } from 'react';
import type { AppState, Stage, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import type { StageAction } from '../application/stage-control';
import { recordedScheduleStatus, stageRadar } from '../../sites/lib/stage-control.js';
import { baselineOverview, planDays, planToday, validPlanDate } from '../../sites/lib/plan-baseline.js';
import { formatDate } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import { planShiftLabel } from './BaselinePanel';
import { StageControlModal } from './StageControlModal';
import { Field, Modal, SectionHeader, StatusBadge } from './Ui';

export function StageRadar({ state, role, actor, userId, onChange, onNavigate }: { state: AppState; role: UserRole; actor: string; userId?: string; onChange: (s: AppState) => void; onNavigate: (p: PageId) => void }) {
  const view = stageRadar(state), baseline = baselineOverview(state), today = planToday();
  const records = recordedScheduleStatus(state, today);
  const [action, setAction] = useState<{ id: string; action: StageAction } | null>(null);
  const [forecastForm, setForecastForm] = useState(false), [forecast, setForecast] = useState(''), [note, setNote] = useState(''), [error, setError] = useState('');
  useEffect(() => { setAction(null); setForecastForm(false); }, [state.project.id]);
  const overdueById = new Map(records.stages.overdue.map((row) => [row.record.id, row.days]));
  const visible = [...new Map([...view.running, ...view.due].map((s) => [s.id, s])).values()]
    .sort((a, b) => (overdueById.get(b.id) || 0) - (overdueById.get(a.id) || 0) || a.order - b.order);
  const upcoming = view.upcoming.filter((s) => !visible.some((v) => v.id === s.id));
  const open = (s: Stage, type: StageAction) => setAction({ id: s.id, action: type });
  const saveForecast = (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim()) { setError('Укажите основание прогноза.'); return; }
    const next = structuredClone(state), now = new Date().toISOString();
    next.project = { ...next.project, workForecastDate: forecast, workForecastNote: note.trim(), workForecastUpdatedAt: now };
    next.activity.unshift({ id: crypto.randomUUID(), timestamp: now, actor, text: `Прогноз окончания работ: ${forecast}. ${note.trim()}`, tone: 'neutral' });
    onChange(next); setForecastForm(false);
  };
  const renderStage = (s: Stage) => {
      const due = view.due.some((d) => d.id === s.id), overdue = overdueById.get(s.id) || 0;
      const awaiting = s.status === 'awaiting_inspection';
      const completedOn = awaiting && validPlanDate(s.completedOn) && s.completedOn <= today ? s.completedOn : null;
      const shift = planDays(s.planEnd, s.baseline?.end);
      const canReport = role === 'management' || role === 'foreman' && (!s.schedule || Boolean(userId && s.schedule.reporterId === userId));
      return <article className="stage-radar__card" key={s.id}><div className="stage-radar__card-top"><StatusBadge label={stageStatusLabel[s.status]} tone={overdue || s.blocker || s.status === 'rework' ? 'danger' : 'blue'} />{overdue > 0 && <strong className="danger-text">Срок прошёл {overdue} дн. назад</strong>}</div><h3>{s.name}</h3><p className="stage-radar__owner">{s.responsible || 'Ответственный не указан'}</p><div className="stage-radar__dates"><span>План 0 <strong>{s.baseline?.end ? formatDate(s.baseline.end) : 'нет даты'}</strong></span><span>Текущий срок <strong>{formatDate(s.planEnd)}</strong></span></div><p className="stage-radar__note">{shift === 0 ? 'Плановую дату не меняли' : shift === null ? 'Сдвиг плана неизвестен' : `Перенос плана: ${planShiftLabel(shift)}`}</p>{completedOn && <p>Выполнено {formatDate(completedOn)} · {s.baseline?.end ? `${planShiftLabel(planDays(completedOn, s.baseline.end))} к Плану 0` : 'исходный срок неизвестен'}. Ожидает приёмки.</p>}{awaiting && !completedOn && <p>Ожидает приёмки. Дата выполнения не указана — отставание по факту неизвестно.</p>}{s.blocker && <p className="blocker-note">Причина: {s.blocker}</p>}{overdue > 0 && !s.blocker && <p className="stage-radar__note">Причина не записана: работа задержалась или выполнение ещё не отметили.</p>}{due && !awaiting && <strong className="stage-radar__question">Этап уже выполнен?</strong>}
        {canReport && <div className="stage-radar__actions">{s.status === 'awaiting_inspection' ? <>{role === 'management' && <><button className="button button--primary" type="button" onClick={() => open(s, 'accept')}>Принять</button><button className="button button--ghost" type="button" onClick={() => open(s, 'rework')}>На доработку</button></>}</> : <><button className="button button--primary" type="button" onClick={() => open(s, 'complete')}>Да, выполнен</button><button className="button button--ghost" type="button" onClick={() => open(s, 'delay')}>Есть задержка</button>{['not_ready', 'ready', 'blocked'].includes(s.status) && <button className="button button--ghost" type="button" onClick={() => open(s, 'start')}>Уже идёт / начать</button>}</>}</div>}
        {!canReport && role !== 'client' && <p className="muted">Состояние подтверждает {state.settings.users.find((u) => u.id === s.schedule?.reporterId)?.name || 'управление'}.</p>}
        {s.statusHistory?.length ? <details><summary>История этапа</summary>{s.statusHistory.slice(-5).reverse().map((h, i) => <p key={i}>{h.note}<small>{h.actor} · {formatDate(h.at.slice(0, 10))}</small></p>)}</details> : null}
      </article>;
  };
  return <section className="panel stage-radar"><SectionHeader title="Этапы: что требует внимания" action={<button type="button" className="text-button" onClick={() => onNavigate('schedule')}>Весь график</button>} />
    <div className="stage-radar__forecast"><div><small>Прогноз окончания работ</small><strong>{view.complete ? 'Все этапы приняты' : view.forecast ? formatDate(view.forecast, true) : 'Пока не указан'}</strong><span>{view.complete ? 'Сдача клиенту оформляется отдельно' : view.forecast ? baseline.end ? `Оценка управления: ${planShiftLabel(planDays(view.forecast, baseline.end))} к Плану 0` : 'Нет полного Плана 0 для сравнения' : 'Отставание всего дома ещё не рассчитано'}</span>{view.forecast && <small>{state.project.workForecastNote}<br />Обновлено {formatDate(state.project.workForecastUpdatedAt!.slice(0, 10))} · {state.project.workForecastUpdatedBy || 'автор не указан'}</small>}</div>{role === 'management' && !view.complete && <button className="button button--secondary" type="button" onClick={() => { setForecast(state.project.workForecastDate || ''); setNote(state.project.workForecastNote || ''); setError(''); setForecastForm(true); }}>Уточнить прогноз</button>}</div>
    {(view.stale || view.conflict) && <p className="blocker-note">{view.stale ? 'Прогноз устарел — подтвердите сроки заново. ' : ''}{view.conflict ? `Один из этапов ожидается позже: ${formatDate(view.lowerBound!)}. Прогноз проекта требует пересмотра.` : ''}</p>}
    <div className="stage-radar__grid">{visible.slice(0, 3).map(renderStage)}</div>
    {visible.length > 3 && <details className="stage-radar__more"><summary>Остальные этапы, требующие внимания · {visible.length - 3}</summary><div className="stage-radar__grid">{visible.slice(3).map(renderStage)}</div></details>}
    {!visible.length && !view.complete && <p className="muted">Нет отмеченных текущих этапов. Зафиксируйте начало фактически идущих работ.</p>}
    {upcoming.length > 0 && <details className="stage-radar__upcoming"><summary>Готовность к старту · {upcoming.length}</summary><p>Условия заданных связей выполнены или зависимость не задана. Это не подтверждение технологической готовности, наличия бригады или фактического начала.</p>{upcoming.map((s) => <div key={s.id}><span>{s.name}</span>{(role === 'management' || role === 'foreman' && (!s.schedule || Boolean(userId && s.schedule.reporterId === userId))) && <button className="text-button" type="button" onClick={() => open(s, 'start')}>Зафиксировать начало</button>}</div>)}</details>}
    {!view.complete && <details className="stage-radar__explanation"><summary>Что нужно для прогноза и наверстывания</summary><p>Подтвердите выполнение прошедших этапов или запишите задержку с причиной. Для прогноза всего дома нужны оставшиеся длительности работ, зависимости и доступные бригады. Просрочка одной записи не равна переносу сдачи.</p></details>}
    {action && <StageControlModal state={state} stageId={action.id} action={action.action} actor={actor} role={role} userId={userId} onChange={onChange} onClose={() => setAction(null)} onNavigate={onNavigate} />}
    {forecastForm && <Modal title="Прогноз окончания работ" subtitle="Оценка не меняет План 0 и согласованный срок сдачи." onClose={() => setForecastForm(false)}><form className="modal-form" onSubmit={saveForecast}><Field label="Ожидаемое окончание"><input required type="date" min={today} value={forecast} onChange={(e) => setForecast(e.target.value)} /></Field><Field label="Основание: этапы, причины, принятые меры"><textarea required value={note} onChange={(e) => setNote(e.target.value)} /></Field>{error && <p role="alert" className="danger-text">{error}</p>}<div className="modal__actions"><button className="button button--primary" type="submit">Сохранить оценку</button></div></form></Modal>}
  </section>;
}
