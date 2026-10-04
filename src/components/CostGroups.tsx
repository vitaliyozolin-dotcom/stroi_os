import { useState, type FormEvent } from 'react';
import type { AppState, CostGroup } from '../entities/index';
import { costGroups, costGroupLabels, costGroupTotals } from '../domain/cost-groups';
import { money } from '../presentation/formatting';
import { Modal } from './Ui';

export function CostGroups({ state, onChange, compact = false }: { state: AppState; onChange?: (state: AppState) => void; compact?: boolean }) {
  const [editing, setEditing] = useState(false);
  const totals = costGroupTotals(state);
  const totalPlan = costGroups.reduce((sum, group) => sum + totals[group].plan, 0);
  const totalPaid = costGroups.reduce((sum, group) => sum + totals[group].paid, 0);
  return <section className={`cost-groups ${compact ? 'cost-groups--compact' : 'panel'}`} aria-label="Строительные и накладные расходы">
    <div className="cost-groups__head"><h2>Бюджет и расходы</h2>{onChange && <button type="button" className="text-button" onClick={() => setEditing(true)}>Распределить</button>}</div>
    <table className="cost-groups__table" aria-label="План и оплаты по категориям">
      <thead><tr><th scope="col">Категория</th><th scope="col">План по смете</th><th scope="col">Оплачено</th></tr></thead>
      <tbody>{costGroups.map(group => <tr key={group}>
        <th scope="row">{costGroupLabels[group]}</th><td>{money(totals[group].plan)}</td>
        <td>{group === 'reserve' ? <span aria-label="Резерв не является расходом">—</span> : money(totals[group].paid)}</td>
      </tr>)}</tbody>
      <tfoot><tr><th scope="row">Всего</th><td>{money(totalPlan)}</td><td>{money(totalPaid)}</td></tr></tfoot>
    </table>
    <p className="cost-groups__note">Резерв — часть плана. Смешанные статьи пока не распределены.</p>
    {!compact && <p className="muted">Строительство — материалы, монтаж и работы на объекте. Накладные — административные расходы. План берётся из статей сметы, оплачено — из реестра платежей.</p>}
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
