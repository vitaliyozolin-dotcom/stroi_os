import { useEffect, useState, type FormEvent } from 'react';
import type { AppState, Stage, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import type { StageAction } from '../application/stage-control';
import { stageRadar } from '../../sites/lib/stage-control.js';
import { baselineOverview, planDays, planToday } from '../../sites/lib/plan-baseline.js';
import { formatDate } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import { planShiftLabel } from './BaselinePanel';
import { StageControlModal } from './StageControlModal';
import { Field, Modal, SectionHeader, StatusBadge } from './Ui';

export function StageRadar({ state, role, actor, userId, onChange, onNavigate }: { state: AppState; role: UserRole; actor: string; userId?: string; onChange: (s: AppState) => void; onNavigate: (p: PageId) => void }) {
  const view = stageRadar(state), baseline = baselineOverview(state), today = planToday();
  const [action, setAction] = useState<{ id: string; action: StageAction } | null>(null);
  const [forecastForm, setForecastForm] = useState(false), [forecast, setForecast] = useState(''), [note, setNote] = useState(''), [error, setError] = useState('');
  useEffect(() => { setAction(null); setForecastForm(false); }, [state.project.id]);
  const visible = [...new Map([...view.running, ...view.due].map((s) => [s.id, s])).values()];
  const open = (s: Stage, type: StageAction) => setAction({ id: s.id, action: type });
  const saveForecast = (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim()) { setError('Укажите основание прогноза.'); return; }
    const next = structuredClone(state), now = new Date().toISOString();
    next.project = { ...next.project, workForecastDate: forecast, workForecastNote: note.trim(), workForecastUpdatedAt: now };
    next.activity.unshift({ id: crypto.randomUUID(), timestamp: now, actor, text: `Прогноз окончания работ: ${forecast}. ${note.trim()}`, tone: 'neutral' });
    onChange(next); setForecastForm(false);
  };
  return <section className="panel stage-radar"><SectionHeader title="Что происходит на стройке" action={<button type="button" className="text-button" onClick={() => onNavigate('schedule')}>Весь график</button>} />
    <div className="stage-radar__forecast"><div><small>Ожидаемое окончание работ · оценка управления</small><strong>{view.complete ? 'Все этапы приняты' : view.forecast ? formatDate(view.forecast, true) : 'Прогноз не подтверждён'}</strong><span>{view.complete ? 'Сдача проекта оформляется отдельно' : view.forecast ? `${planShiftLabel(planDays(view.forecast, baseline.end))} к исходному ППР` : 'Действующий план и План 0 показаны выше'}</span>{state.project.workForecastUpdatedAt && <small>Обновлено {formatDate(state.project.workForecastUpdatedAt.slice(0, 10))} · {state.project.workForecastUpdatedBy || actor}</small>}</div>{role === 'management' && !view.complete && <button className="button button--secondary" type="button" onClick={() => { setForecast(state.project.workForecastDate || ''); setNote(state.project.workForecastNote || ''); setError(''); setForecastForm(true); }}>Уточнить прогноз</button>}</div>
    {(view.stale || view.conflict) && <p className="blocker-note">{view.stale ? 'Прогноз устарел — подтвердите сроки заново. ' : ''}{view.conflict ? `Один из этапов ожидается позже: ${formatDate(view.lowerBound!)}. Прогноз проекта требует пересмотра.` : ''}</p>}
    {!view.complete && <p className="muted">Возможность нагнать срок пока не подтверждена: нужны оставшаяся длительность работ, зависимости и доступные бригады. Параллельный старт сам по себе не гарантирует ускорения.</p>}
    <div className="stage-radar__grid">{visible.map((s) => {
      const due = view.due.some((d) => d.id === s.id), overdue = Math.max(0, planDays(today, s.planEnd) || 0);
      return <article className="stage-radar__card" key={s.id}><StatusBadge label={stageStatusLabel[s.status]} tone={s.blocker || s.status === 'rework' ? 'danger' : 'blue'} /><h3>{s.name}</h3><p>{s.responsible} · текущий срок {formatDate(s.planEnd)}</p><p>План 0: {s.baseline?.end ? formatDate(s.baseline.end) : 'не сохранён'} · {planShiftLabel(planDays(s.planEnd, s.baseline?.end))}</p>{!s.completedOn && overdue > 0 && <p className="danger-text">Текущий срок прошёл {overdue} дн. назад{!s.completedOn ? '; выполнение не подтверждено' : ''}</p>}{s.completedOn && <p>Работы выполнены {formatDate(s.completedOn)} · {planShiftLabel(planDays(s.completedOn, s.baseline?.end))} к Плану 0</p>}{s.blocker && <p className="blocker-note">{s.blocker}</p>}{due && !s.completedOn && <strong>Срок {overdue ? 'прошёл' : 'подходит'}. Этап выполнен?</strong>}
        {role !== 'client' && <div className="stage-radar__actions">{s.status === 'awaiting_inspection' ? <>{role === 'management' && <><button className="button button--primary" type="button" onClick={() => open(s, 'accept')}>Принять</button><button className="button button--ghost" type="button" onClick={() => open(s, 'rework')}>На доработку</button></>}</> : <><button className="button button--primary" type="button" onClick={() => open(s, 'complete')}>Да, выполнен</button><button className="button button--ghost" type="button" onClick={() => open(s, 'delay')}>Есть задержка</button>{['not_ready', 'ready', 'blocked'].includes(s.status) && <button className="button button--ghost" type="button" onClick={() => open(s, 'start')}>Уже идёт / начать</button>}</>}</div>}
        {s.statusHistory?.length ? <details><summary>История этапа</summary>{s.statusHistory.slice(-5).reverse().map((h, i) => <p key={i}>{h.note}<small>{h.actor} · {formatDate(h.at.slice(0, 10))}</small></p>)}</details> : null}
      </article>;
    })}</div>
    {!visible.length && !view.complete && <p className="muted">Нет отмеченных текущих этапов. Зафиксируйте начало фактически идущих работ.</p>}
    {view.upcoming.length > 0 && <details className="stage-radar__upcoming"><summary>Можно проверить готовность к старту: {view.upcoming.length}</summary><p className="muted">Предшественник принят или зависимость не задана. Это не подтверждение технологической готовности.</p>{view.upcoming.map((s) => <div key={s.id}><span>{s.name}</span>{role !== 'client' && <button className="text-button" type="button" onClick={() => open(s, 'start')}>Зафиксировать начало</button>}</div>)}</details>}
    {action && <StageControlModal state={state} stageId={action.id} action={action.action} actor={actor} role={role} userId={userId} onChange={onChange} onClose={() => setAction(null)} onNavigate={onNavigate} />}
    {forecastForm && <Modal title="Прогноз окончания работ" subtitle="Оценка не меняет План 0 и согласованный срок сдачи." onClose={() => setForecastForm(false)}><form className="modal-form" onSubmit={saveForecast}><Field label="Ожидаемое окончание"><input required type="date" min={today} value={forecast} onChange={(e) => setForecast(e.target.value)} /></Field><Field label="Основание: этапы, причины, принятые меры"><textarea required value={note} onChange={(e) => setNote(e.target.value)} /></Field>{error && <p role="alert" className="danger-text">{error}</p>}<div className="modal__actions"><button className="button button--primary" type="submit">Сохранить оценку</button></div></form></Modal>}
  </section>;
}
