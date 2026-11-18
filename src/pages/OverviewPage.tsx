import type { StateChangeSink } from '../application';
import {
  ArrowUpRight,
  Banknote,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  TrendingUp,
} from 'lucide-react';
import { financeWorkspaceSummary } from '../domain/finance-workspace.js';
import { useScheduleToday } from '../components/ProjectScheduleDates';
import { OverviewWorkCards } from '../components/ProjectDashboard';
import { formatDateTime, shortMoney } from '../presentation/formatting';
import type { AppState, DashboardWidget, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { MetricCard, SectionHeader, StatusBadge } from '../components/Ui';
import { ConstructionNow } from '../components/ConstructionNow';
import './overview-dashboard.css';

export function OverviewPage({ state, role, actor, userId, onChange, onNavigate, onOpenProjects }: { state: AppState; role: UserRole; actor: string; userId?: string; onChange: StateChangeSink; onNavigate: (page: PageId, entityId?: string) => void; onOpenProjects?: () => void }) {
  const today = useScheduleToday();
  const finance = financeWorkspaceSummary(state, today);
  const amount = (cents: number | null) => cents === null ? 'Не указано' : shortMoney(cents / 100);
  const show = (widget: DashboardWidget) => role === 'foreman' || state.settings.dashboardWidgets.includes(widget);

  if (state.project.status === 'workspace') {
    return (
      <div className="page-stack">
        <section className="project-heading">
          <div>
            <div className="project-heading__meta">
              <StatusBadge label="Чистое рабочее пространство" tone="neutral" />
              <span>Демонстрационные данные удалены</span>
            </div>
            <h1>Создайте первый объект</h1>
            <p>Рабочие показатели появятся только после внесения реальных данных.</p>
          </div>
          <button className="button button--light project-heading__action" type="button" onClick={onOpenProjects}>
            <ArrowUpRight size={18} /> Создать проект
          </button>
        </section>

        <section className="panel workspace-launch">
          <SectionHeader eyebrow="Быстрый запуск" title="Три шага до начала работы" />
          <div className="workspace-launch__steps">
            <button type="button" onClick={onOpenProjects}>
              <span>1</span>
              <div><strong>Создать объект</strong><small>Адрес, сроки, площадь и договор</small></div>
              <ChevronRight size={18} />
            </button>
            <div>
              <span>2</span>
              <div><strong>Загрузить смету</strong><small>План и прогноз будут считаться из её статей</small></div>
            </div>
            <div>
              <span>3</span>
              <div><strong>Назначить команду</strong><small>Ответственные увидят только свои задачи</small></div>
            </div>
          </div>
          <p className="workspace-launch__note">Подрядчики, график, закупки, оплаты, документы и контроль качества будут связаны с созданным объектом.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack overview-page">
      <ConstructionNow state={state} role={role} actor={actor} userId={userId} onChange={onChange} onNavigate={onNavigate} />
      {role === 'management' && show('finance') && <>
        <div className="overview-contract-line"><span>Цена договора <strong>{amount(finance.contractCents)}</strong></span><button type="button" className="text-button" onClick={() => onNavigate('finance')}>Открыть финансы <ArrowUpRight size={15} /></button></div>
        <section className="metric-grid overview-money" aria-label="Деньги проекта">
          <MetricCard label="Смета себестоимости" value={amount(finance.internalBudgetCents)} detail={<span>{finance.internalBudgetCents === null ? 'Нужна внутренняя смета' : finance.internalBudgetApproved ? 'Утверждённый бюджет' : 'Требует утверждения'}</span>} icon={CircleDollarSign} onClick={() => onNavigate('finance')} />
          <MetricCard label="Оплачено" value={amount(finance.paidCents)} detail={<span>{finance.paidCents === null ? 'Оплаты ещё не внесены' : 'Учтённые денежные операции'}</span>} icon={Banknote} onClick={() => onNavigate('finance')} />
          <MetricCard label="Доступно сейчас" value={amount(finance.availableCashCents)} detail={<span>{finance.availableCashCents === null ? 'Остаток не внесён' : 'Без средств на эскроу'}</span>} icon={CircleDollarSign} tone={finance.availableCashCents !== null && finance.availableCashCents < 0 ? 'warning' : 'default'} onClick={() => onNavigate('finance')} />
          <MetricCard label="Прогноз затрат" value={amount(finance.forecastCents)} detail={<span>{finance.forecastCents === null ? 'Остаток работ не оценён' : finance.forecastComplete ? 'С учётом оставшихся работ' : 'Предварительно · есть пробелы'}</span>} icon={TrendingUp} onClick={() => onNavigate('finance')} />
        </section>
      </>}
      {role === 'management' && state.project.status === 'draft' && <section className="panel"><p>Объём, сроки и стоимость этого заказа ещё уточняются. Заполните участников, объекты и условия, затем добавьте план работ.</p><button type="button" className="button button--primary" onClick={() => onNavigate('customers')}>Заполнить заказ</button></section>}

      <OverviewWorkCards state={state} role={role} show={show} onNavigate={onNavigate} />

      {show('activity') && <details className="overview-history"><summary>История проекта</summary>
        <SectionHeader eyebrow="Журнал проекта" title="История изменений" />
        <div className="activity-row">
          {state.activity.slice(0, 8).map((event) => (
            <div className={`activity-card activity-card--${event.tone}`} key={event.id}>
              <span className="activity-card__dot" />
              <div><strong>{event.text}</strong><p>{event.actor} · {formatDateTime(event.timestamp)}</p></div>
            </div>
          ))}
          {!state.activity.length && <div className="overview-task-empty"><Clock3 size={20} /> Журнал начнётся с первого рабочего действия</div>}
        </div>
      </details>}
    </div>
  );
}
