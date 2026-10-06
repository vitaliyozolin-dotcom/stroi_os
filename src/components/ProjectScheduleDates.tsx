import { useEffect, useState, type ReactNode } from 'react';
import { automaticSchedule, plannedStageDays } from '../../sites/lib/automatic-schedule.js';
import { planToday } from '../../sites/lib/plan-baseline.js';
import type { AppState } from '../entities/index';
import { formatDate } from '../presentation/formatting';
import { SectionHeader } from './Ui';

export function useScheduleToday() {
  const [today, setToday] = useState(planToday);
  useEffect(() => { const timer = setInterval(() => setToday(planToday()), 60_000); return () => clearInterval(timer); }, []);
  return today;
}

export function ProjectScheduleDates({ state, action, onReview, children }: { state: AppState; action?: ReactNode; onReview?: () => void; children?: ReactNode }) {
  const today = useScheduleToday(), view = automaticSchedule(state, today);
  const observed = view.kind === 'observed', complete = observed || view.kind === 'actual';
  const delay = view.baselineShift;
  const remaining = state.stages.filter(stage => stage.schedule?.kind !== 'summary' && !['accepted', 'awaiting_inspection'].includes(stage.status));
  return <section className="panel overview-dates" aria-label="Сроки проекта">
    <SectionHeader title="Сроки" action={action} />
    {children}
    <div className="overview-dates__grid">
      <div><small>Исходный план</small><strong>{view.baselineEnd ? formatDate(view.baselineEnd, true) : 'Не указан'}</strong><span>Окончание работ по ППР</span></div>
      <div><small>{view.kind === 'actual' ? 'Работы по ППР выполнены' : observed ? 'Готовность подтверждена' : 'Плановая готовность по ППР'}</small><strong>{view.end ? formatDate(view.end, true) : 'Нужны сроки'}</strong><span>{view.kind === 'estimated' ? 'Автоматический расчёт · предварительно' : view.kind === 'confirmed' ? 'Расчёт по уточнённым остаткам' : observed ? 'Точная дата выполнения неизвестна' : view.kind === 'actual' ? 'По датам выполнения' : view.issues[0]?.message || 'Добавьте этапы и длительности'}</span></div>
      <div className={delay !== null && delay > 0 ? 'overview-dates__delay overview-dates__delay--late' : 'overview-dates__delay'}><small>{complete ? 'Оставшиеся работы по ППР' : 'До готовности по ППР'}</small><strong>{view.remainingDays === null ? '—' : view.remainingDays === 0 ? 'Выполнены' : `${view.remainingDays} дн.`}</strong><span>{view.remainingDays ? 'Календарных дней, включая сегодня' : complete ? 'Приёмка учитывается отдельно' : 'Остаток пока не рассчитан'}</span></div>
    </div>
    <div className="overview-dates__footer">
      <span>{observed ? 'Сроки фактического отставания уточняются' : delay === null ? 'Отставание пока не рассчитано' : `${complete ? 'Отклонение' : 'Прогноз отклонения'} от ППР: ${delay > 0 ? '+' : ''}${delay} дн.`}</span>
      <span>Сдача по договору: <strong>{state.project.targetDate ? formatDate(state.project.targetDate, true) : 'Не указана'}</strong></span>
    </div>
    {view.unmappedWork.length > 0 && <div className="automatic-schedule__scope"><strong>До сдачи дома ещё: {view.unmappedWork.join(', ').toLocaleLowerCase('ru')}.</strong><span>Для этих работ не найдены отдельные сроки в ППР. Дата выше пока не включает их.</span></div>}
    <details className="automatic-schedule__details"><summary>{remaining.length ? `Из чего складывается срок · этапов осталось: ${remaining.length}` : 'Как рассчитан срок'}</summary>
      {remaining.length > 0 && <div className="automatic-schedule__table"><table aria-label="Оставшиеся этапы и длительности"><thead><tr><th scope="col">Этап</th><th scope="col">Длительность</th><th scope="col">Окончание</th></tr></thead><tbody>{remaining.map(stage => {
        const row = view.rows.find(item => item.id === stage.id), days = row?.remainingDays ?? plannedStageDays(stage);
        return <tr key={stage.id}><th scope="row">{stage.shortName || stage.name}</th><td>{days === null ? 'Не указана' : `${days} дн.`}<small>{row?.source === 'remaining' ? 'Уточнённый остаток' : 'По длительности ППР'}{stage.schedule?.calendar && stage.schedule.calendar !== 'daily' ? ' · рабочих' : ' · календарных'}</small></td><td>{row ? formatDate(row.end) : 'Уточнить'}</td></tr>;
      })}</tbody></table></div>}
      <p>Дата обновляется при отметке выполнения, изменении графика и наступлении нового дня. Это оценка по внесённым этапам; договорная дата сохраняется.</p>
      {view.notes.map(note => <p key={note}>{note}</p>)}
      {view.issues.map((issue, index) => <p className="danger-text" key={`${issue.stageId}-${index}`}>{state.stages.find(stage => stage.id === issue.stageId)?.shortName}: {issue.message}.</p>)}
      {onReview && <button type="button" className="text-button" onClick={onReview}>Уточнить остатки и зависимости</button>}
    </details>
  </section>;
}
