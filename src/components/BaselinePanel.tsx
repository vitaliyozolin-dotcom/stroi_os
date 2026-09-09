import { useEffect, useState, type FormEvent } from 'react';
import { CalendarDays, LockKeyhole } from 'lucide-react';
import type { AppState, UserRole } from '../entities/index';
import { baselineOverview, planDays } from '../../sites/lib/plan-baseline.js';
import { recordedScheduleStatus } from '../../sites/lib/stage-control.js';
import { formatDate } from '../presentation/formatting';
import { Field, Modal, SectionHeader } from './Ui';

export const planShiftLabel = (days: number | null) => days === null ? 'Нет исходного срока' : days > 0 ? `+${days} дн.` : days < 0 ? `${days} дн.` : '0 дн.';
export function BaselinePanel({ state, role, actor, onChange, compact = false }: {
  state: AppState; role: UserRole; actor: string; onChange: (state: AppState) => void; compact?: boolean;
}) {
  const summary = baselineOverview(state);
  const records = recordedScheduleStatus(state);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ source: 'document', note: '', start: '', end: '', targetDate: '', reason: '', stages: [] as {id: string; start: string; end: string}[] });
  const [error, setError] = useState('');
  useEffect(() => { setEditing(false); }, [state.project.id]);
  const open = () => {
    setForm({ source: 'document', note: '', start: state.project.baseline?.start || '', end: state.project.baseline?.end || '', targetDate: state.project.targetDate, reason: '',
      stages: state.stages.map((stage) => ({ id: stage.id, start: stage.baseline?.start || '', end: stage.baseline?.end || '' })) });
    setError(''); setEditing(true);
  };
  const fillCurrent = () => setForm({ ...form, source: 'snapshot', note: 'Текущая версия сроков на дату фиксации. Исторический ППР не восстанавливался.',
    start: state.project.baseline?.start || state.project.startDate, end: state.project.baseline?.end || state.project.targetDate,
    stages: state.stages.map((stage) => ({ id: stage.id, start: stage.baseline?.start || stage.planStart, end: stage.baseline?.end || stage.planEnd })) });
  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = structuredClone(state), now = new Date().toISOString();
    let additions = 0;
    const baseline = (start: string, end: string) => ({ start: start || undefined, end, source: form.source as 'document' | 'snapshot', note: form.note.trim(), recordedAt: now, recordedBy: actor });
    if (!next.project.baseline && form.end) { next.project.baseline = baseline(form.start, form.end); additions++; }
    for (const stage of next.stages) {
      const dates = form.stages.find((row) => row.id === stage.id);
      if (!stage.baseline && dates?.end) { stage.baseline = baseline(dates.start, dates.end); additions++; }
    }
    if (additions && !form.note.trim()) { setError('Укажите источник исходных дат: документ или договорённость.'); return; }
    if (form.targetDate !== state.project.targetDate && !form.reason.trim()) { setError('Укажите причину переноса действующего срока.'); return; }
    if (!additions && form.targetDate === state.project.targetDate) { setEditing(false); return; }
    next.project.targetDate = form.targetDate;
    next.project.planChangeReason = form.reason.trim();
    next.activity.unshift({ id: crypto.randomUUID(), timestamp: now, actor, text: `План 0: зафиксировано исходных сроков — ${additions}.${form.reason.trim() ? ` Действующая сдача: ${form.targetDate}. ${form.reason.trim()}` : ''}`, tone: 'neutral' });
    onChange(next); setEditing(false);
  };
  const handover = <div className="baseline-metrics baseline-metrics--handover">
    <div><small>Сдача клиенту · План 0</small><strong>{state.project.baseline ? formatDate(state.project.baseline.end, true) : 'Не зафиксирована'}</strong><span>{state.project.baseline?.source === 'snapshot' ? 'Версия на дату фиксации' : state.project.baseline?.note || 'Не подменяется датой окончания ППР'}</span></div>
    <div><small>Сдача клиенту · текущая</small><strong>{formatDate(state.project.targetDate, true)}</strong><span>{state.project.baseline ? `Сдвиг срока: ${planShiftLabel(planDays(state.project.targetDate, state.project.baseline.end))}` : 'Сдвиг неизвестен без исходной даты'}</span></div>
  </div>;
  return <section className={`panel baseline-panel${compact ? ' baseline-panel--compact' : ''}`} data-tour="plan-zero">
    <SectionHeader title="План 0 и сроки" action={role === 'management' ? <button type="button" className="button button--ghost" onClick={open}><CalendarDays size={16} /> Исходные даты</button> : <LockKeyhole size={19} />} />
    <div className="schedule-records">
      <p className="schedule-records__label">Просрочка по записям · на {formatDate(records.today)}</p>
      <div className="schedule-records__grid">{([{ label: 'Этапы', group: records.stages }, { label: 'Задачи', group: records.tasks }]).map(({ label, group }) => <div className={group.overdue.length ? 'schedule-records__metric schedule-records__metric--late' : 'schedule-records__metric'} key={label}>
        <span>{label} · {group.overdue.length}</span><strong>{!group.recordCount ? 'Нет записей' : group.overdue.length ? `до ${group.maxDays} дн.` : group.missingDue ? 'Есть пробелы' : '0 дн.'}</strong>
        {group.recordCount > 0 && <small>По Плану 0: {group.missingBaseline && !group.baselineOverdue.length ? 'нет полных данных' : `${group.baselineOverdue.length} · до ${group.maxBaselineDays} дн.`}{group.missingBaseline ? `; без исходной даты: ${group.missingBaseline}` : ''}</small>}
      </div>)}</div>
      <p className="schedule-records__note">{records.stages.overdue.length || records.tasks.overdue.length ? 'Срок прошёл, выполнение не отмечено. Максимум по одной записи, не по всему дому.' : !records.stages.recordCount && !records.tasks.recordCount ? 'Добавьте этапы и задачи, чтобы сравнить сроки с выполнением.' : 'По известным действующим срокам открытой просрочки нет. Это не прогноз сдачи дома.'}</p>
      <details className="schedule-records__details"><summary>Расшифровка{records.stages.awaitingReview || records.tasks.awaitingReview ? ' · есть ожидающие приёмки' : ''}</summary>
      {records.stages.overdue[0] && <p className="schedule-records__source">Самый старый срок этапа: <strong>{records.stages.overdue[0].record.name}</strong> · {formatDate(records.stages.overdue[0].record.planEnd)}.</p>}
      {records.tasks.overdue[0] && <p className="schedule-records__source">Самый старый срок задачи: <strong>{records.tasks.overdue[0].record.title}</strong> · {formatDate(records.tasks.overdue[0].record.dueDate)}.</p>}
      <p className="schedule-records__note">Дни считаются по незакрытым записям. Это не отставание всего дома; дни параллельных работ не складываются.</p>
      {(records.stages.awaitingReview > 0 || records.tasks.awaitingReview > 0) && <p className="schedule-records__note">Отдельно ждут приёмки: этапов — {records.stages.awaitingReview}, задач — {records.tasks.awaitingReview}. В просрочку работ выше не включены.</p>}
      {(records.stages.missingDue > 0 || records.tasks.missingDue > 0) && <p className="schedule-records__note">Без действующего срока: этапов — {records.stages.missingDue}, задач — {records.tasks.missingDue}. Их просрочка неизвестна.</p>}
      <p className="schedule-records__note">Считаются действующие сроки, отдельно — План 0. Выполненные, отменённые и служебные задачи этапов не включены.</p>
      </details>
    </div>
    <div className="baseline-metrics">
      <div><small>Окончание работ · План 0</small><strong>{summary.end ? formatDate(summary.end, true) : 'Недостаточно дат'}</strong><span>Исходный ППР: {summary.recorded} из {summary.total} этапов</span></div>
      <div><small>Окончание работ · план</small><strong>{summary.currentEnd ? formatDate(summary.currentEnd, true) : 'Недостаточно дат'}</strong><span>{summary.shift === null ? `Для сравнения нужны все даты ППР (текущих: ${summary.currentRecorded} из ${summary.total})` : summary.shift === 0 ? 'Дату в плане не меняли' : `Сдвиг плана: ${planShiftLabel(summary.shift)}`}</span></div>
    </div>
    {compact ? <details className="baseline-handover"><summary>Сдача клиенту · {formatDate(state.project.targetDate)}</summary>{handover}<p className="baseline-caption">Сдача клиенту и окончание работ по ППР — разные сроки. Разница между ними не является отставанием.</p></details> : handover}
    <details className="baseline-explanation"><summary>Как читать сроки и переносы</summary><p>План показывает записанные даты, а не фактическую готовность. Даже при неизменном плане могут быть просроченные работы.</p><p>Позже Плана 0 перенесено: этапов — {summary.shiftedStages.length}, задач — {summary.shiftedTasks.length}. Это количество этапов и задач с перенесённым сроком, не дни отставания. Все дни — календарные.</p></details>
    {editing && <Modal wide title="План 0 · первоначальные сроки" subtitle="Укажите даты из исходного ППР. Уже зафиксированные даты защищены от перезаписи." onClose={() => setEditing(false)}><form className="modal-form baseline-form" onSubmit={save}>
      <div className="baseline-form__intro"><p>Известные исходные сроки уже заполнены. Неизвестные можно оставить пустыми.</p><button type="button" className="button button--secondary" onClick={fillCurrent}>Зафиксировать текущую версию</button></div>
      <div className="form-grid"><Field label="Источник дат"><select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}><option value="document">Первоначальный ППР / договорённость</option><option value="snapshot">Текущая версия на дату фиксации</option></select></Field><Field label="Документ или договорённость"><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Например: ППР.xlsx, согласован 17 августа" /></Field></div>
      <div className="form-grid"><Field label="План 0 проекта · начало"><input disabled={Boolean(state.project.baseline)} type="date" value={form.start} max={form.end || undefined} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field><Field label="План 0 проекта · сдача"><input disabled={Boolean(state.project.baseline)} type="date" value={form.end} min={form.start || undefined} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field></div>
      <div className="baseline-table-wrap"><table className="baseline-table"><thead><tr><th>Этап</th><th>Исходное начало</th><th>Исходное окончание</th><th>Действующее окончание</th></tr></thead><tbody>{state.stages.map((stage) => {
        const dates = form.stages.find((row) => row.id === stage.id);
        if (!dates) return null;
        const change = (field: 'start' | 'end', value: string) => setForm({ ...form, stages: form.stages.map((row) => row.id === stage.id ? { ...row, [field]: value } : row) });
        return <tr key={stage.id}><td><strong>{stage.name}</strong>{stage.baseline && <small>{stage.baseline.note}</small>}</td><td><input aria-label={`Исходное начало: ${stage.name}`} disabled={Boolean(stage.baseline)} type="date" value={dates.start} max={dates.end || undefined} onChange={(e) => change('start', e.target.value)} /></td><td><input aria-label={`Исходное окончание: ${stage.name}`} disabled={Boolean(stage.baseline)} type="date" value={dates.end} min={dates.start || undefined} onChange={(e) => change('end', e.target.value)} /></td><td>{formatDate(stage.planEnd, true)}</td></tr>;
      })}</tbody></table></div>
      <div className="form-grid"><Field label="Действующий срок сдачи проекта"><input required type="date" min={state.project.startDate} value={form.targetDate} onChange={(e) => setForm({ ...form, targetDate: e.target.value })} /></Field><Field label="Причина переноса действующего срока"><input required={form.targetDate !== state.project.targetDate} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field></div>
      {state.project.planHistory?.length ? <div className="baseline-history"><strong>История изменения плана</strong>{state.project.planHistory.slice(-6).reverse().map((h, i) => <p key={i}>{h.before || '—'} → {h.after || '—'} · {h.reason}<small>{h.actor} · {formatDate(h.at.slice(0, 10))}</small></p>)}</div> : null}
      {error && <p role="alert" className="danger-text">{error}</p>}
      <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditing(false)}>Отмена</button><button type="submit" className="button button--primary">Сохранить План 0</button></div>
    </form></Modal>}
  </section>;
}
