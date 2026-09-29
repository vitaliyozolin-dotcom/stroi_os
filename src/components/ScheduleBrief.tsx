import { useState } from 'react';
import type { AppState, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { forecastSchedule, simulateSchedule, type ScheduleForecast } from '../../sites/lib/schedule-forecast.js';
import { recordedScheduleStatus, stageRadar } from '../../sites/lib/stage-control.js';
import { formatDate, money } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import { BaselinePanel } from './BaselinePanel';
import { StageRadar } from './StageRadar';
import { ScheduleReconciliation } from './ScheduleReconciliation';
import { Field, SectionHeader } from './Ui';

export const scheduleDeltaLabel = (days: number | null) => days === null ? 'Нет полного исходного ППР для сравнения' : days > 0 ? `Позже Плана 0 на ${days} календ. дн.` : days < 0 ? `Раньше Плана 0 на ${Math.abs(days)} календ. дн.` : 'В срок по Плану 0';

export function ScheduleBrief({ state, role, actor, userId, onChange, onNavigate }: { state: AppState; role: UserRole; actor: string; userId?: string; onChange: (s: AppState) => void; onNavigate: (p: PageId) => void }) {
  const view = forecastSchedule(state), records = recordedScheduleStatus(state), manual = stageRadar(state);
  const [review, setReview] = useState<string | null>(null);
  const issueIds = [...new Set(view.issues.map((i) => i.stageId))];
  const cuts = view.rows.filter((row) => row.source === 'calculation').map((row) => state.stages.find((s) => s.id === row.id)!.siteUpdate!);
  const cutDates = cuts.map((u) => u.asOf).sort(), nextReview = cuts.map((u) => u.reviewOn).sort()[0];
  const focus = state.stages.filter((s) => s.schedule?.kind !== 'summary' && (s.blocker || view.criticalIds.includes(s.id) && !['accepted', 'awaiting_inspection'].includes(s.status)));
  const details = <>
    <section className="panel schedule-brief">
      <SectionHeader eyebrow="Стройка сегодня" title={view.kind === 'actual' ? 'Работы выполнены' : 'Сроки и состояние работ'} action={<button className="text-button" type="button" onClick={() => onNavigate('schedule')}>Весь ППР</button>} />
      <div className="schedule-brief__dates"><div><small>План 0 · окончание работ</small><strong>{view.baselineEnd ? formatDate(view.baselineEnd, true) : 'Исходный срок не подтверждён'}</strong></div><div><small>{view.kind === 'actual' ? 'Фактическое окончание работ' : 'Расчётное окончание работ'}</small><strong>{view.end ? formatDate(view.end, true) : 'Нужна сверка'}</strong><span className={view.baselineShift !== null && view.baselineShift > 0 ? 'danger-text' : ''}>{view.end ? scheduleDeltaLabel(view.baselineShift) : 'Отставание всего проекта пока неизвестно'}</span></div></div>
      <p className="schedule-brief__subline">Действующий ППР: {view.currentEnd ? formatDate(view.currentEnd) : 'не все даты указаны'}. Сдача клиенту: {state.project.targetDate ? formatDate(state.project.targetDate) : 'дата не указана'} — отдельное обязательство.</p>
      {view.end && cuts.length > 0 && <p className="schedule-brief__subline">Расчёт по сверкам на {formatDate(cutDates[0])}{cutDates.at(-1) !== cutDates[0] ? ` — ${formatDate(cutDates.at(-1)!)}` : ''}. Ближайшая проверка сведений: {formatDate(nextReview)}.</p>}
      {!view.end && manual.forecast && <p className="schedule-brief__subline">Оценка управления: {formatDate(manual.forecast)}{manual.stale ? ' · устарела' : ''}{manual.conflict ? ' · противоречит срокам этапов' : ''}. Это не расчёт по остаткам работ.</p>}
      {view.total > 0 ? <p className="schedule-brief__subline">Принято {view.accepted} из {view.total} несводных строк ППР. Это количество записей, не процент готовности дома.</p> : <p>ППР пока не заполнен. Добавьте исходный график, затем подтвердите фактическое состояние.</p>}
      {issueIds.length > 0 && <div className="schedule-brief__attention"><strong>Уточнить сведения по {issueIds.length} строкам ППР</strong><p>{state.stages.find((s) => s.id === view.issues[0].stageId)?.name}: {view.issues[0].message.toLocaleLowerCase('ru')}.</p><button type="button" className="button button--primary" onClick={() => setReview(view.issues[0].stageId)}>{role === 'client' ? 'Посмотреть, чего не хватает' : 'Сверить состояние работ'}</button>{issueIds.length > 1 && <details><summary>Остальные вопросы к прогнозу</summary>{issueIds.slice(1).map((id) => <button className="schedule-brief__issue" type="button" key={id} onClick={() => setReview(id)}><strong>{state.stages.find((s) => s.id === id)?.name}</strong><span>{view.issues.filter((i) => i.stageId === id).map((i) => i.message).join('. ')}</span></button>)}</details>}</div>}
      {view.phases.length > 0 && <div className="schedule-brief__phases"><h3>На каких этапах работаем</h3>{view.phases.map((phase) => <details key={phase.name} open={phase.name !== 'Структура не сверена' && (phase.running.length > 0 || phase.blocked.length > 0)}><summary><strong>{phase.name}</strong><span>{phase.blocked.length ? `Препятствия: ${phase.blocked.length} · ` : ''}{phase.running.length ? `В работе: ${phase.running.length} · ` : ''}выполнено {phase.completed}/{phase.ids.length}, принято {phase.accepted}</span></summary>{phase.ids.map((id) => {
        const stage = state.stages.find((s) => s.id === id)!, row = view.rows.find((r) => r.id === id);
        return <button className="schedule-brief__issue" type="button" key={id} onClick={() => setReview(id)}><strong>{stage.name}</strong><span>{stageStatusLabel[stage.status]}{row ? ` · ${row.source === 'fact' ? 'факт' : view.end ? 'расчёт' : 'предварительно'} ${formatDate(row.end)}` : ' · срок требует уточнения'}</span></button>;
      })}</details>)}</div>}
      {focus.length > 0 && <details className="schedule-brief__drivers" open><summary>{view.end ? 'Что определяет срок и мешает работе' : 'Записанные препятствия'}</summary>{focus.map((s) => <div key={s.id}><strong>{s.name}</strong><p>{s.blocker || 'Работа лежит на цепочке, определяющей окончание проекта.'}</p><p>{s.siteUpdate?.nextAction ? `Действие: ${s.siteUpdate.nextAction}. Ответственный: ${s.siteUpdate.issueOwner || 'не указан'}.` : 'Следующее действие ещё не записано.'}</p><button type="button" className="text-button" onClick={() => setReview(s.id)}>Уточнить состояние</button></div>)}</details>}
      {view.end && role !== 'client' && <button type="button" className="button button--secondary" onClick={() => setReview(state.stages[0]?.id || '')}>Обновить сверку</button>}
      {role === 'management' && view.kind === 'calculated' && <RecoveryScenario state={state} view={view} />}
      <details className="schedule-brief__explain"><summary>Как читать отставание</summary><p>Сравниваем окончание всех работ с окончанием исходного ППР. Перенос утверждённого плана, просроченная запись и отставание всего проекта — разные показатели. Задержки параллельных работ не складываются.</p><p>Срок прошёл, но выполнение не подтверждено: {records.stages.overdue.length} строк ППР, {records.tasks.overdue.length} задач. Это повод уточнить факты, а не доказательство такого же переноса сдачи.</p><p>Расчёт использует подтверждённые остатки, связи, приёмку, рабочие календари и доступность бригад. Конфликт одной бригады на нескольких работах требует решения. Проверка сведений — не реже раза в 7 календарных дней.</p></details>
    </section>
    <details className="panel schedule-brief__details"><summary>Исходные сроки, история переносов и отдельные записи</summary><BaselinePanel compact state={state} role={role} actor={actor} onChange={onChange} /><StageRadar state={state} role={role} actor={actor} userId={userId} onChange={onChange} onNavigate={onNavigate} /></details>
  </>;
  const delay = view.baselineShift;
  return <>
    <section className="panel overview-dates" aria-label="Сроки проекта">
      <SectionHeader title="Сроки" action={<button className="text-button" type="button" onClick={() => onNavigate('schedule')}>График работ</button>} />
      <div className="overview-dates__grid">
        <div><small>Исходное окончание работ</small><strong>{view.baselineEnd ? formatDate(view.baselineEnd, true) : 'Не указано'}</strong><span>По исходному ППР</span></div>
        <div><small>{view.kind === 'actual' ? 'Работы выполнены' : 'Прогноз окончания работ'}</small><strong>{view.end ? formatDate(view.end, true) : 'Нужна сверка'}</strong><span>{view.end ? view.kind === 'actual' ? 'По подтверждённым фактам' : 'По подтверждённому остатку работ' : 'Дата пока не рассчитана'}</span></div>
        <div className={delay !== null && delay > 0 ? 'overview-dates__delay overview-dates__delay--late' : 'overview-dates__delay'}><small>Отклонение от исходного ППР</small><strong>{delay === null ? 'Неизвестно' : delay > 0 ? `+${delay} дн.` : delay < 0 ? `−${Math.abs(delay)} дн.` : 'В срок'}</strong><span>{delay === null ? 'Появится после расчёта' : delay > 0 ? 'Позже исходного срока' : delay < 0 ? 'Раньше исходного срока' : 'Срок работ не изменился'}</span></div>
      </div>
      <div className="overview-dates__footer">
        <span>Сдача клиенту по договору: <strong>{state.project.targetDate ? formatDate(state.project.targetDate, true) : 'Не указана'}</strong></span>
        {issueIds.length > 0 && <button type="button" className="text-button" onClick={() => setReview(view.issues[0].stageId)}>{role === 'client' ? 'Что нужно для прогноза' : 'Уточнить прогноз'} · {issueIds.length}</button>}
      </div>
    </section>
    <details className="panel overview-schedule-details">
      <summary>Подробности сроков и сверка ППР</summary>
      <div className="page-stack">{details}</div>
    </details>
    {review !== null && <ScheduleReconciliation key={state.project.id} state={state} role={role} actor={actor} userId={userId} initialId={review} onChange={onChange} onClose={() => setReview(null)} />}
  </>;
}

function RecoveryScenario({ state, view }: { state: AppState; view: ScheduleForecast }) {
  const eligible = state.stages.filter((s) => s.schedule?.kind !== 'summary' && s.siteUpdate && !['accepted', 'awaiting_inspection'].includes(s.status));
  const [id, setId] = useState(eligible[0]?.id || ''), [days, setDays] = useState(''), [crew, setCrew] = useState(''), [cost, setCost] = useState(''), [owner, setOwner] = useState('');
  const selected = eligible.find((s) => s.id === id);
  const result = selected && Number.isInteger(Number(days)) && Number(days) > 0 && Number(days) <= 730 ? simulateSchedule(state, { stageId: id, remainingDays: Number(days), ...(crew.trim() ? { crew: crew.trim() } : {}) }) : null;
  return <details className="schedule-brief__scenario"><summary>Можно ли нагнать? Проверить сценарий</summary><p>Пробный расчёт одной меры. План, факты, назначения и деньги не меняются; вариант не сохраняется. Новую бригаду и стоимость ещё нужно подтвердить.</p><div className="schedule-review__grid"><Field label="Работа для изменения"><select value={id} onChange={(e) => { setId(e.target.value); setDays(''); setCrew(''); }}>{eligible.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label={`Остаток в сценарии, раб. дн. (сейчас ${selected?.siteUpdate?.remainingDays ?? '—'})`}><input type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} /></Field><Field label="Другая бригада, если нужна"><input maxLength={100} value={crew} onChange={(e) => setCrew(e.target.value)} placeholder={selected?.schedule?.crew || 'Без изменения ресурса'} /></Field><Field label="Дополнительная стоимость, ₽"><input type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Неизвестна — оставить пустым" /></Field><Field label="Кто проверит выполнимость меры"><input maxLength={120} value={owner} onChange={(e) => setOwner(e.target.value)} /></Field></div>
    {result?.forecast?.end ? <div className="schedule-brief__attention"><strong>{formatDate(view.end!)} → {formatDate(result.forecast.end)}</strong><p>{result.gainedDays === 0 ? 'Выигрыш 0 дней: окончание проекта не изменилось. Другие работы по-прежнему определяют срок.' : result.gainedDays !== null && result.gainedDays > 0 ? `Можно выиграть ${result.gainedDays} календарных дней при указанных условиях.` : `Сценарий ухудшает срок на ${Math.abs(result.gainedDays!)} календарных дней.`}</p><p>{scheduleDeltaLabel(result.forecast.baselineShift)}. Доп. стоимость: {cost === '' ? 'не определена' : money(Number(cost))}. Проверяет: {owner.trim() || 'не назначен'}.</p></div> : result && <p className="blocker-note">Сценарий не рассчитан: {result.forecast?.issues[0]?.message || 'недостаточно подтверждённых данных'}.</p>}
  </details>;
}
