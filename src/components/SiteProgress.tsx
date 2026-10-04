import { useState, type FormEvent } from 'react';
import type { AppState, UserRole } from '../entities/index';
import { planToday } from '../../sites/lib/plan-baseline.js';
import { formatDate } from '../presentation/formatting';
import { Field, Modal } from './Ui';

export function SiteProgress({ state, role, onChange }: { state: AppState; role: UserRole; onChange: (state: AppState) => void }) {
  const [editing, setEditing] = useState(false);
  const history = state.project.siteProgressHistory ?? [], latest = history.at(-1);
  if (role === 'client') return null;
  return <section className="site-progress" aria-label="Фактическая готовность объекта">
    <div className="cost-groups__head"><h2>Готовность объекта</h2>{role === 'management' && <button type="button" className="text-button" onClick={() => setEditing(true)}>Обновить факт</button>}</div>
    {latest ? <><div className="site-progress__columns"><div><h3>Сделано</h3><ul>{latest.completed.map((item, i) => <li key={i}>{item}</li>)}</ul></div><div><h3>Осталось</h3><ul>{latest.remaining.map((item, i) => <li key={i}>{item}</li>)}</ul></div></div>
      <p className="muted">Состояние на {formatDate(latest.asOf)} · {latest.source}. Точные даты выполнения и приёмка отмечаются в этапах отдельно.</p>
      {history.length > 1 && <details><summary>История состояния ({history.length - 1})</summary>{history.slice(0, -1).reverse().map(row => <p key={row.id}><strong>{formatDate(row.asOf)}</strong> · {row.source}<br />Сделано: {row.completed.join('; ')}.<br />Осталось: {row.remaining.join('; ')}.</p>)}</details>}
    </> : <p className="muted">Укажите, что уже сделано и что осталось. Исходный ППР и приёмка сохраняются отдельно.</p>}
    {editing && <ProgressEditor state={state} onChange={onChange} onClose={() => setEditing(false)} />}
  </section>;
}
function ProgressEditor({ state, onChange, onClose }: { state: AppState; onChange: (state: AppState) => void; onClose: () => void }) {
  const latest = state.project.siteProgressHistory?.at(-1);
  const [date, setDate] = useState(planToday()), [source, setSource] = useState('');
  const [completed, setCompleted] = useState(latest?.completed.join('\n') ?? ''), [remaining, setRemaining] = useState(latest?.remaining.join('\n') ?? '');
  const [opened] = useState(() => JSON.stringify(state.project.siteProgressHistory));
  const [error, setError] = useState('');
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (opened !== JSON.stringify(state.project.siteProgressHistory)) { setError('Состояние уже обновилось. Откройте форму заново.'); return; }
    const split = (value: string) => value.split('\n').map(v => v.trim()).filter(Boolean);
    const done = split(completed), left = split(remaining);
    if (!source.trim() || !done.length && !left.length || [...done, ...left].some(v => v.length > 250) || done.length > 50 || left.length > 50) { setError('Укажите источник и работы: до 50 пунктов в каждом списке, до 250 символов на пункт.'); return; }
    onChange({ ...state, project: { ...state.project, siteProgressHistory: [...(state.project.siteProgressHistory ?? []), { id: crypto.randomUUID(), asOf: date, completed: done, remaining: left, source: source.trim() }] } });
    onClose();
  };
  return <Modal title="Что уже сделано на объекте" subtitle="Сохраняется новая запись состояния; история остаётся." onClose={onClose}><form className="modal-form" onSubmit={save}>
    <Field label="Состояние на дату"><input aria-label="Состояние на дату" type="date" required max={planToday()} value={date} onChange={e => setDate(e.target.value)} /></Field>
    <Field label="Сделано · по одному пункту на строку"><textarea aria-label="Сделано" rows={7} value={completed} onChange={e => setCompleted(e.target.value)} /></Field>
    <Field label="Осталось · по одному пункту на строку"><textarea aria-label="Осталось" rows={5} value={remaining} onChange={e => setRemaining(e.target.value)} /></Field>
    <Field label="Кто подтвердил / источник"><input aria-label="Источник состояния" required maxLength={500} value={source} onChange={e => setSource(e.target.value)} /></Field>
    <p className="muted">Это факт состояния на выбранную дату, а не дата окончания каждой работы. Приёмка и оплата не создаются.</p>
    {error && <p className="danger-text" role="alert">{error}</p>}<div className="modal__actions"><button type="button" className="button button--ghost" onClick={onClose}>Отмена</button><button className="button button--primary" type="submit">Сохранить состояние объекта</button></div>
  </form></Modal>;
}
