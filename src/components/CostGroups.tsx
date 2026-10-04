import { useState, type FormEvent } from 'react';
import type { AppState, CostGroup } from '../entities/index';
import { costGroups, costGroupLabels, costGroupTotals } from '../domain/cost-groups';
import { money } from '../presentation/formatting';
import { Modal } from './Ui';

export function CostGroups({ state, onChange, compact = false }: { state: AppState; onChange?: (state: AppState) => void; compact?: boolean }) {
  const [editing, setEditing] = useState(false);
  const totals = costGroupTotals(state);
  return <section className={`cost-groups ${compact ? 'cost-groups--compact' : 'panel'}`} aria-label="Строительные и накладные расходы">
    <div className="cost-groups__head"><h2>На что идут деньги</h2>{onChange && <button type="button" className="text-button" onClick={() => setEditing(true)}>Распределить расходы</button>}</div>
    <div className="cost-groups__grid">{costGroups.map(group => <div key={group}>
      <span>{costGroupLabels[group]}</span><strong>{money(group === 'reserve' ? totals[group].plan : totals[group].paid)}</strong>
      <small>{group === 'reserve' ? 'В бюджете · ещё не потрачено' : `Оплачено · план ${money(totals[group].plan)}`}</small>
    </div>)}</div>
    {!compact && <p className="muted">Материалы, монтаж и работы на объекте — строительство. Административные расходы — накладные. Смешанные статьи распределяются после расшифровки. Итог проекта сохраняется.</p>}
    {editing && onChange && <ClassificationEditor state={state} onChange={onChange} onClose={() => setEditing(false)} />}
  </section>;
}
function ClassificationEditor({ state, onChange, onClose }: { state: AppState; onChange: (state: AppState) => void; onClose: () => void }) {
  const [lines, setLines] = useState<Record<string, CostGroup>>(() => Object.fromEntries(state.budgetLines.map(line => [line.id, line.costGroup ?? 'unallocated'])));
  const [entries, setEntries] = useState<Record<string, CostGroup | ''>>(() => Object.fromEntries(state.financeEntries.filter(e => e.kind === 'expense').map(e => [e.id, e.costGroup ?? ''])));
  const [opened] = useState(() => JSON.stringify([state.budgetLines, state.financeEntries]));
  const [error, setError] = useState('');
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (JSON.stringify([state.budgetLines, state.financeEntries]) !== opened) { setError('Данные обновились. Откройте распределение заново.'); return; }
    onChange({ ...state, budgetLines: state.budgetLines.map(line => ({ ...line, costGroup: lines[line.id] })), financeEntries: state.financeEntries.map(e => e.kind === 'expense' ? { ...e, costGroup: entries[e.id] || undefined } : e) });
    onClose();
  };
  return <Modal title="Строительство и накладные" subtitle="Меняется только категория. Суммы, документы и оплаты сохраняются." onClose={onClose}>
    <form className="modal-form" onSubmit={save}><h3>План по смете</h3>
      {state.budgetLines.map(line => <label className="cost-classify-row" key={line.id}><span>{line.name}<small>{money(line.plan)}{line.outsideSourceTotal ? ' · вне итога исходной сметы' : ''}</small></span><select aria-label={`Категория сметы: ${line.name}`} value={lines[line.id]} onChange={e => setLines({ ...lines, [line.id]: e.target.value as CostGroup })}>{costGroups.map(g => <option key={g} value={g}>{costGroupLabels[g]}</option>)}</select></label>)}
      <h3>Фактические расходы</h3><p className="muted">По умолчанию расход наследует категорию статьи. Для смешанной статьи или расхода без статьи выберите категорию отдельно.</p>
      {state.financeEntries.filter(e => e.kind === 'expense').map(entry => <label className="cost-classify-row" key={entry.id}><span>{entry.description}<small>{money(entry.amount)} · {entry.counterparty}</small></span><select aria-label={`Категория расхода: ${entry.description}`} value={entries[entry.id]} onChange={e => setEntries({ ...entries, [entry.id]: e.target.value as CostGroup | '' })}><option value="">По статье сметы</option>{costGroups.filter(g => g !== 'reserve').map(g => <option key={g} value={g}>{costGroupLabels[g]}</option>)}</select></label>)}
      {error && <p role="alert" className="danger-text">{error}</p>}<div className="modal__actions"><button type="button" className="button button--ghost" onClick={onClose}>Отмена</button><button className="button button--primary" type="submit">Сохранить распределение</button></div>
    </form>
  </Modal>;
}
