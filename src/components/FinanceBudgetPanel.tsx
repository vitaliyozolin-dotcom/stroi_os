import { ChevronDown, ChevronRight, Upload } from 'lucide-react';
import type { AppState, BudgetLine, CostGroup } from '../entities/index';
import { financeTotals, lineForecast, lineTotals, paidAmountFor, sourceEstimateTotals, unallocatedExpenses, unallocatedExpenseTotals } from '../domain/index';
import { costGroupLabels, costGroups, costGroupTotals, expenseCostGroup } from '../domain/cost-groups';
import { formatDate, money } from '../presentation/formatting';
import { CostGroups } from './CostGroups';
import './finance-budget-panel.css';

type FinanceBudgetPanelProps = {
  state: AppState;
  onChange: (next: AppState) => void;
  onOpenLine: (id: string) => void;
  onOpenUnallocated: () => void;
  onImport: () => void;
};

const deviationText = (forecast: number, plan: number) => {
  const difference = Math.round((forecast - plan) * 100) / 100;
  if (difference === 0) return 'По плану';
  return `${difference > 0 ? '+' : '−'}${money(Math.abs(difference))} к плану`;
};

function BudgetLineRow({ state, line, onOpen }: { state: AppState; line: BudgetLine; onOpen: () => void }) {
  const values = lineTotals(state, line);
  const forecast = lineForecast(state, line);
  return <button type="button" className="money-budget__line" onClick={onOpen}>
    <span className="money-budget__line-name">
      <strong>{line.name}</strong>
      {line.outsideSourceTotal && <small>Вне итога исходного файла{Number.isFinite(line.sourcePlan) ? ` · в файле ${money(line.sourcePlan!)}` : ''}</small>}
    </span>
    <span className="money-budget__number"><small>План</small>{money(line.plan)}</span>
    <span className="money-budget__number"><small>Оплачено</small>{money(values.paid)}</span>
    <span className={`money-budget__number money-budget__forecast ${forecast > line.plan ? 'money-budget__forecast--over' : ''}`}>
      <small>Прогноз</small><span>{money(forecast)}</span><span className="money-budget__deviation">{deviationText(forecast, line.plan)}</span>
    </span>
  </button>;
}

export function FinanceBudgetPanel({ state, onChange, onOpenLine, onOpenUnallocated, onImport }: FinanceBudgetPanelProps) {
  const totals = financeTotals(state);
  const groups = costGroupTotals(state);
  const source = sourceEstimateTotals(state.budgetLines);
  const unallocated = unallocatedExpenseTotals(state);
  const unallocatedCount = unallocatedExpenses(state).length;
  const outsideSource = state.budgetLines.filter(line => line.outsideSourceTotal);
  const groupHasSeparateClassification = (group: CostGroup) => state.financeEntries.some(entry => {
    if (entry.kind !== 'expense' || paidAmountFor(entry) <= 0) return false;
    const line = state.budgetLines.find(item => item.id === entry.budgetLineId);
    const lineGroup = line?.costGroup ?? 'unallocated';
    const actualGroup = expenseCostGroup(state, entry);
    return actualGroup !== lineGroup && (actualGroup === group || lineGroup === group);
  });

  return <section className="money-budget" aria-label="Смета проекта" data-tour="budget-plan">
    <header className="money-budget__heading">
      <div><h2>Смета</h2><p>План и расходы по разделам</p></div>
      <button type="button" className="button button--ghost" onClick={onImport}><Upload size={16} />Импорт сметы</button>
    </header>

    <div className="money-budget__totals">
      <div><span>План</span><strong>{money(totals.plan)}</strong></div>
      <div><span>Оплачено</span><strong>{money(totals.paid)}</strong></div>
      <div className={totals.forecast > totals.plan ? 'money-budget__total--over' : ''}><span>Предварительный прогноз</span><strong>{money(totals.forecast)}</strong><small>{deviationText(totals.forecast, totals.plan)}</small></div>
    </div>
    <p className="money-budget__forecast-note">Прогноз учитывает внесённые суммы. Стоимость оставшихся работ ещё нужно сверить.</p>

    {!state.budgetLines.length && <div className="money-budget__empty"><strong>Смета ещё не загружена</strong><p>Добавьте план, чтобы сравнивать расходы по статьям.</p></div>}

    <div className="money-budget__groups" aria-label="План и оплаты по категориям">
      <div className="money-budget__category-head" aria-hidden="true"><span>Категория</span><span>План</span><span>Оплачено</span></div>
      {costGroups.map(group => {
        const lines = state.budgetLines.filter(line => (line.costGroup ?? 'unallocated') === group);
        return <details className="money-budget__group" key={group}>
          <summary>
            <span className="money-budget__category-name"><ChevronDown size={15} /><span><strong>{costGroupLabels[group]}</strong><small>{group === 'reserve' ? 'Запас бюджета' : `Статей: ${lines.length}`}</small></span></span>
            <span className="money-budget__category-value"><small>План</small>{money(groups[group].plan)}</span>
            <span className="money-budget__category-value"><small>Оплачено</small>{group === 'reserve' ? <span aria-label="Резерв не является расходом">—</span> : money(groups[group].paid)}</span>
          </summary>
          <div className="money-budget__group-body">
            {groupHasSeparateClassification(group) && <p className="money-budget__classification-note">Часть оплат отнесена к другой категории. Здесь статьи сгруппированы по плану, а оплаты категории — по назначению расходов.</p>}
            {lines.length > 0 ? <>
              <div className="money-budget__line-head" aria-hidden="true"><span>Статья</span><span>План</span><span>Оплачено</span><span>Прогноз</span></div>
              {lines.map(line => <BudgetLineRow key={line.id} state={state} line={line} onOpen={() => onOpenLine(line.id)} />)}
            </> : <p className="money-budget__empty-group">Статей сметы в этой категории пока нет.</p>}
          </div>
        </details>;
      })}
    </div>

    {unallocatedCount > 0 && <button type="button" className="money-budget__unallocated" onClick={onOpenUnallocated}>
      <span><strong>Расходы без статьи сметы</strong><small>Записей: {unallocatedCount} · уже учтены в итогах</small></span>
      <span><small>Оплачено</small><strong>{money(unallocated.paid)}</strong></span>
      <span><small>В прогнозе</small><strong>{money(unallocated.forecast)}</strong></span>
      <ChevronRight size={17} />
    </button>}

    <div className="money-budget__references">
      <details className="money-budget__reference">
        <summary>Источник сметы <span>{state.budgetMeta.version}</span><ChevronDown size={15} /></summary>
        <div className="money-budget__reference-body">
          <p><strong>{state.budgetMeta.source || 'Источник не указан'}</strong></p>
          <p>{state.budgetMeta.approvedBy ? `Утвердил: ${state.budgetMeta.approvedBy}` : 'Смета ещё не утверждена'}{state.budgetMeta.approvedAt ? ` · ${formatDate(state.budgetMeta.approvedAt, true)}` : ''}</p>
          {state.budgetMeta.importedAt && <p>Загружена {formatDate(state.budgetMeta.importedAt, true)}</p>}
          {state.budgetMeta.note && <p>{state.budgetMeta.note}</p>}
          {source && <>
            <dl className="money-budget__source-totals"><div><dt>План в файле</dt><dd>{money(source.plan)}</dd></div><div><dt>«Факт» в файле</dt><dd>{money(source.fact)}</dd></div><div><dt>Разница с планом</dt><dd>{money(source.deviation)}</dd></div></dl>
            <p>«Факт» из файла — отдельная сверка. Он не добавляется к оплатам и не подтверждает расходование резерва.</p>
          </>}
          {outsideSource.length > 0 && <div className="money-budget__outside"><strong>Строки вне итога исходного файла</strong>{outsideSource.map(line => <button type="button" key={line.id} onClick={() => onOpenLine(line.id)}><span>{line.name}</span><strong>{Number.isFinite(line.sourcePlan) ? money(line.sourcePlan!) : 'Сумма в файле не указана'}</strong><ChevronRight size={15} /></button>)}</div>}
        </div>
      </details>
      <details className="money-budget__reference">
        <summary>Распределение строительства и накладных<ChevronDown size={15} /></summary>
        <div className="money-budget__reference-body"><CostGroups state={state} onChange={onChange} compact /></div>
      </details>
    </div>
  </section>;
}
