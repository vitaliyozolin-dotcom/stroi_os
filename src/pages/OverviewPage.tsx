import { OverviewFocus } from '../components/OverviewFocus';
import { ConstructionNow } from '../components/ConstructionNow';
import { CostGroups } from '../components/CostGroups';
import { ScheduleBrief } from '../components/ScheduleBrief';
import {
  ArrowUpRight,
  Banknote,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  TrendingUp,
} from 'lucide-react';
import { financeTotals, sourceEstimateTotals, projectProgressTotals as progressTotals } from '../domain/index';
import { formatDateTime, money, shortMoney } from '../presentation/formatting';
import type { AppState, DashboardWidget, UserRole } from '../entities/index';
import type { PageId } from '../presentation/navigation';
import { MetricCard, ProgressBar, SectionHeader, StatusBadge } from '../components/Ui';

export function OverviewPage({ state, role, actor, userId, onChange, onNavigate, onOpenProjects }: { state: AppState; role: UserRole; actor: string; userId?: string; onChange: (state: AppState) => void; onNavigate: (page: PageId, entityId?: string) => void; onOpenProjects?: () => void }) {
  const finance = financeTotals(state);
  const sourceEstimate = sourceEstimateTotals(state.budgetLines);
  const progress = progressTotals(state);
  const lastUpdated = state.activity[0]?.timestamp ?? state.project.createdAt;
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
      {show('project') && <section className="project-heading project-heading--overview">
        <div>
          <div className="project-heading__meta">
            <StatusBadge label={`${state.project.code} · активный проект`} tone="positive" />
            <span>{lastUpdated ? `Обновлено ${formatDateTime(lastUpdated)}` : 'Изменений пока нет'}</span>
          </div>
          <h1>{role === 'foreman' ? 'Сегодня на объекте' : state.project.name}</h1>
          <p>{[state.project.model, state.project.area ? `${state.project.area} м²` : '', state.project.address].filter(Boolean).join(' · ') || 'Заполните параметры первого объекта'}</p>
        </div>
      </section>}

      {role !== 'foreman' && show('finance') && <section className="metric-grid overview-money" aria-label="Деньги проекта">
        <MetricCard
          label="Потрачено"
          value={shortMoney(finance.paid)}
          detail={<span>Учтённые оплаты · основания в реестре</span>}
          icon={Banknote}
          onClick={() => onNavigate('finance')}
        />
        <MetricCard
          label="Остаток по учёту"
          value={shortMoney(finance.received - finance.paid)}
          detail={<span>Поступления − выплаты · счета не сверены</span>}
          icon={CircleDollarSign}
          tone={finance.received < finance.paid ? 'warning' : 'positive'}
          onClick={() => onNavigate('finance')}
        />
        <MetricCard label="Смета · план" value={shortMoney(finance.plan)} detail={<span>{sourceEstimate ? `«Факт» в смете: ${money(sourceEstimate.fact)}` : state.budgetMeta.approvedAt ? 'План принят' : 'Исходный план · нужна сверка'}</span>} icon={CircleDollarSign} onClick={() => onNavigate('finance')} />
        <MetricCard label={sourceEstimate ? 'Отклонение в смете' : 'Отклонение от сметы'} value={sourceEstimate ? `${sourceEstimate.deviation > 0 ? '+' : ''}${shortMoney(sourceEstimate.deviation)}` : finance.plan ? `${finance.forecast > finance.plan ? '+' : ''}${shortMoney(finance.forecast - finance.plan)}` : '—'} detail={<span>{sourceEstimate ? 'Колонка «Факт» − исходный план' : `Прогноз ${shortMoney(finance.forecast)}`}</span>} icon={TrendingUp} tone={(sourceEstimate?.deviation ?? finance.forecast - finance.plan) > 0 ? 'warning' : 'default'} onClick={() => onNavigate('finance')} />
        {sourceEstimate && <p className="overview-money__note">«Факт» из таблицы включает резерв и расчётные статьи. Отдельные оплаты учитываются в карточке «Потрачено».</p>}
        <p className="overview-money__note">Осталось оплатить по прогнозу: <strong>{shortMoney(Math.max(0, finance.forecast - finance.paid))}</strong>. По внесённым данным; фактическую стоимость завершения нужно сверить.</p>
      </section>}

      {role === 'management' && show('finance') && <CostGroups state={state} onChange={onChange} compact />}
      <ScheduleBrief state={state} role={role} actor={actor} userId={userId} onChange={onChange} onNavigate={onNavigate}>
        {show('progress') && <section className="overview-ppr-progress" aria-label="Выполнение ППР" style={{ width: '100%', maxWidth: 420 }}>
          <MetricCard label="Выполнение ППР" value={state.stages.length ? `${progress.physical}%` : '—'}
            detail={<><ProgressBar value={progress.physical} /><span>{state.stages.length ? 'По внесённым этапам и задачам · не готовность всего дома' : 'Добавьте этапы в график работ'}</span></>}
            icon={TrendingUp} tone="dark" onClick={() => onNavigate('schedule')} />
        </section>}
      </ScheduleBrief>
      {show('progress') && <ConstructionNow state={state} role={role} actor={actor} userId={userId} onChange={onChange} onNavigate={onNavigate} />}
      <OverviewFocus state={state} role={role} show={show} onNavigate={onNavigate} />

      {show('activity') && <details className="overview-history"><summary>История проекта</summary>
        <SectionHeader eyebrow="Журнал проекта" title="История изменений" />
        <div className="activity-row">
          {state.activity.map((event) => (
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
