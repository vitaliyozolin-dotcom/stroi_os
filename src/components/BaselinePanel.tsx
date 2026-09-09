import { useEffect, useState, type FormEvent } from 'react';
import { CalendarDays, LockKeyhole } from 'lucide-react';
import type { AppState, UserRole } from '../entities/index';
import { baselineOverview, planDays } from '../../sites/lib/plan-baseline.js';
import { formatDate } from '../presentation/formatting';
import { Field, Modal, SectionHeader } from './Ui';

export const planShiftLabel = (days: number | null) => days === null ? 'Нет исходного срока' : days > 0 ? `+${days} дн.` : days < 0 ? `${days} дн.` : 'Без переноса';
export function BaselinePanel({ state, role, actor, onChange, compact = false }: {
  state: AppState; role: UserRole; actor: string; onChange: (state: AppState) => void; compact?: boolean;
}) {
  const summary = baselineOverview(state);
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
  return <section className="panel baseline-panel" data-tour="plan-zero">
    <SectionHeader eyebrow="Исходные обязательства сохраняются" title="План 0" action={role === 'management' ? <button type="button" className="button button--ghost" onClick={open}><CalendarDays size={16} /> ППР и исходные сроки</button> : <LockKeyhole size={19} />} />
    <div className="baseline-metrics">
      <div><small>Окончание исходного ППР</small><strong>{summary.end ? formatDate(summary.end, true) : 'Не зафиксировано полностью'}</strong><span>{summary.recorded} из {summary.total} этапов с исходными датами</span></div>
      <div><small>Окончание текущего ППР</small><strong>{summary.currentEnd ? formatDate(summary.currentEnd, true) : 'Нет этапов'}</strong><span>{planShiftLabel(summary.shift)} к исходному ППР</span></div>
      <div><small>Исходный срок сдачи проекта</small><strong>{state.project.baseline ? formatDate(state.project.baseline.end, true) : 'Не зафиксирован'}</strong><span>{state.project.baseline?.source === 'snapshot' ? 'Версия на дату фиксации' : state.project.baseline?.note || 'Дата сдачи фиксируется отдельно от ППР'}</span></div>
      <div><small>Действующий срок сдачи</small><strong>{formatDate(state.project.targetDate, true)}</strong><span>{planShiftLabel(planDays(state.project.targetDate, state.project.baseline?.end))}</span></div>
    </div>
    <p className="baseline-caption">Перенесено позже исходного срока: этапов — {summary.shiftedStages.length}, задач — {summary.shiftedTasks.length}. Отклонения указаны в календарных днях.</p>
    {!compact && <p className="muted">План 0 показывает первоначальные даты. Прогноз и фактическое выполнение учитываются отдельно; перенос действующего срока не меняет План 0.</p>}
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
