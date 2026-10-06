import '../overview-focus.css';
import { useState } from 'react';
import { ArrowUpRight, CheckCircle2, ChevronRight } from 'lucide-react';
import type { AppState, DashboardWidget, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { paidAmountFor, paymentMovements, unallocatedExpenses } from '../domain/finance';
import { recordedScheduleStatus } from '../../sites/lib/stage-control.js';
import { planToday } from '../../sites/lib/plan-baseline.js';
import { formatDate, money } from '../presentation/formatting';

type Action = { title: string; detail: string; page?: PageId; entityId?: string };

export function OverviewFocus({ state, role, show, onNavigate }: {
  state: AppState; role: UserRole; show: (widget: DashboardWidget) => boolean;
  onNavigate: (page: PageId, entityId?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const actions: Action[] = [];
  const overdue = recordedScheduleStatus(state, planToday()).tasks.overdue
    .filter(row => !row.record.id.startsWith('auto-stage-'));
  const awaiting = state.stages.filter(stage => stage.status === 'awaiting_inspection' && stage.schedule?.kind !== 'summary');
  const rework = state.checkpoints.filter(point => point.status === 'rework');
  const review = state.checkpoints.filter(point => point.status === 'in_review');
  const unallocated = unallocatedExpenses(state);
  const risks = state.procurement.filter(item => item.risk && item.status !== 'delivered');
  if (show('quality') && rework.length) actions.push({ title: 'Проверить замечания к работам', detail: `Требуют доработки: ${rework.length}`, page: 'quality' });
  if (show('tasks') && overdue.length) actions.push({ title: 'Разобрать просроченные задачи', detail: `Без отметки о завершении: ${overdue.length}`, page: 'tasks' });
  if (role === 'management' && show('progress') && awaiting.length) actions.push({ title: 'Принять выполненные этапы', detail: `Ожидают подтверждения: ${awaiting.length}`, page: 'schedule' });
  if (show('supply') && risks.length) actions.push({ title: 'Уточнить поставки с риском', detail: `Требуют внимания: ${risks.length}`, page: 'procurement' });
  if (role === 'management' && show('finance') && unallocated.length) actions.push({ title: 'Распределить расходы по смете', detail: `Без статьи сметы: ${unallocated.length}`, page: 'finance', entityId: unallocated[0].id });
  if (show('quality') && review.length) actions.push({ title: 'Проверить отчёты по качеству', detail: `На проверке: ${review.length}`, page: 'quality' });
  if (show('decisions')) state.decisions.filter(item => item.status === 'waiting').forEach(item => actions.push({ title: item.title, detail: `Ожидается решение${item.dueDate ? ` · до ${formatDate(item.dueDate)}` : ''}` }));
  const reviewTasks = state.tasks.filter(task => task.status === 'review' && !task.id.startsWith('auto-stage-') && !overdue.some(row => row.record.id === task.id));
  if (show('tasks') && reviewTasks.length) actions.push({ title: 'Проверить выполненные задачи', detail: `На проверке: ${reviewTasks.length}`, page: 'tasks' });
  const expenses = state.financeEntries.filter(entry => entry.kind === 'expense' && paidAmountFor(entry) > 0)
    .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  const supplies = state.procurement.filter(item => ['ordered', 'in_transit'].includes(item.status))
    .sort((a, b) => a.neededBy.localeCompare(b.neededBy)).slice(0, 2);
  const showActions = role !== 'client' && ['decisions', 'tasks', 'quality', 'progress', 'supply', 'finance'].some(widget => show(widget as DashboardWidget));
  const showExpenses = role === 'management' && (show('finance') || show('cashflow'));
  return <div className="overview-focus">
    {showActions && <section className="overview-focus__section" aria-label="Требует твоего внимания">
      <header className="overview-focus__header"><h2>Требует твоего внимания</h2>{actions.length > 0 && <span className="overview-focus__count">{actions.length}</span>}</header>
      <div className="overview-focus__actions">
        {(expanded ? actions : actions.slice(0, 3)).map((action, index) => {
          const content = <><span className="overview-focus__number">{String(index + 1).padStart(2, '0')}</span><span><strong>{action.title}</strong><small>{action.detail}</small></span>{action.page && <ArrowUpRight size={19} />}</>;
          return action.page ? <button className="overview-focus__action" type="button" key={index} onClick={() => onNavigate(action.page!, action.entityId)}>{content}</button> : <div className="overview-focus__action overview-focus__action--static" key={index}>{content}</div>;
        })}
        {!actions.length && <p className="overview-focus__empty"><CheckCircle2 size={18} /> По внесённым данным срочных действий нет.</p>}
      </div>
      {actions.length > 3 && <button className="text-button overview-focus__more" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Свернуть' : `Ещё ${actions.length - 3}`}</button>}
      {show('tasks') && <button type="button" className="text-button overview-focus__more" onClick={() => onNavigate('tasks')}>Все задачи <ChevronRight size={16} /></button>}
      {show('supply') && supplies.length > 0 && <div className="overview-focus__supplies"><h3>Ближайшие поставки</h3>{supplies.map(item => <button key={item.id} type="button" onClick={() => onNavigate('procurement')}><span>{item.item}</span><small>{item.neededBy ? formatDate(item.neededBy) : 'Срок уточняется'}</small><ChevronRight size={16} /></button>)}</div>}
    </section>}
    {showExpenses && <section className="overview-focus__section" aria-label="Последние расходы">
      <header className="overview-focus__header"><h2>Последние расходы</h2><button type="button" className="text-button" onClick={() => onNavigate('finance')}>Все <ArrowUpRight size={16} /></button></header>
      <p className="overview-focus__hint">По дате записи · учтённые оплаты</p>
      <div className="overview-focus__expenses">{expenses.map(entry => {
        const movements = paymentMovements(entry).filter(movement => movement.amount > 0);
        const date = movements.length === 1 ? movements[0].date : null;
        return <button className="overview-focus__expense" type="button" key={entry.id} onClick={() => onNavigate('finance', entry.id)}>
          <span><strong>{entry.description}</strong><small>{entry.counterparty || 'Контрагент не указан'} · {date ? `оплата ${formatDate(date)}` : movements.length > 1 ? 'Несколько оплат' : 'Дата оплаты не указана'}</small></span><b>{money(paidAmountFor(entry))}</b><ChevronRight size={16} />
        </button>;
      })}</div>
      {!expenses.length && <p className="overview-focus__empty">Учтённых оплат пока нет.</p>}
    </section>}
  </div>;
}
