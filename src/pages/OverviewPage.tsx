import {
  AlertTriangle,
  ArrowUpRight,
  Banknote,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  ListTodo,
  PackageCheck,
  ShieldCheck,
  TrendingUp,
  Truck,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { financeTotals, formatDate, formatDateTime, isTaskOverdue, paidAmountFor, progressTotals, shortMoney, stageStatusLabel, taskStatusLabel } from '../domain';
import type { AppState, DashboardWidget, PageId, UserRole } from '../types';
import { MetricCard, ProgressBar, SectionHeader, StatusBadge } from '../components/Ui';

const startOfWeek = (date: Date) => {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value;
};

const shiftDays = (date: Date, days: number) => {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
};

const weekLabel = (start: Date, end: Date) => {
  const formatter = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${formatter.format(start)}–${formatter.format(end)}`;
};

export function OverviewPage({ state, role, onNavigate, onOpenProjects }: { state: AppState; role: UserRole; onNavigate: (page: PageId) => void; onOpenProjects?: () => void }) {
  const finance = financeTotals(state);
  const progress = progressTotals(state);
  const currentStage = state.stages.find((stage) => ['in_progress', 'blocked', 'rework', 'awaiting_inspection'].includes(stage.status))
    ?? state.stages.find((stage) => stage.status === 'ready')
    ?? state.stages[0];
  const reviewCount = state.checkpoints.filter((item) => item.status === 'in_review').length;
  const reworkCount = state.checkpoints.filter((item) => item.status === 'rework').length;
  const riskySupply = state.procurement.filter((item) => item.risk);
  const activeTasks = state.tasks
    .filter((task) => !['done', 'canceled'].includes(task.status))
    .sort((a, b) => Number(isTaskOverdue(b)) - Number(isTaskOverdue(a)) || a.dueDate.localeCompare(b.dueDate));
  const overdueTaskCount = activeTasks.filter((task) => isTaskOverdue(task)).length;
  const nextDecision = state.decisions.find((item) => item.status === 'waiting');
  const margin = state.project.contractValue - finance.forecast;
  const marginPercent = state.project.contractValue > 0 ? Math.round(margin / state.project.contractValue * 100) : null;
  const today = new Date();
  const cashCutoff = shiftDays(today, 30);
  const cashNeed = state.financeEntries
    .filter((entry) => entry.kind === 'expense' && paidAmountFor(entry) < entry.amount && new Date(`${entry.date}T23:59:59Z`) <= cashCutoff)
    .reduce((sum, entry) => sum + Math.max(0, entry.amount - paidAmountFor(entry)), 0);
  const currentWeek = startOfWeek(today);
  const cashflow = Array.from({ length: 6 }, (_, index) => {
    const start = shiftDays(currentWeek, (index - 5) * 7);
    const end = shiftDays(start, 6);
    return { start, end, label: weekLabel(start, end), expense: 0, income: 0 };
  });
  for (const entry of state.financeEntries) {
    const amount = paidAmountFor(entry);
    if (amount <= 0) continue;
    const paidAt = entry.paidAt || (entry.status === 'paid' ? entry.date : '');
    if (!paidAt) continue;
    const date = new Date(`${paidAt.slice(0, 10)}T12:00:00Z`);
    const point = cashflow.find((item) => date >= item.start && date <= item.end);
    if (!point) continue;
    if (entry.kind === 'income') point.income += amount / 1000;
    else point.expense += amount / 1000;
  }
  const maxCash = Math.max(1, ...cashflow.flatMap((point) => [point.expense, point.income]));
  const hasCashflow = cashflow.some((point) => point.expense > 0 || point.income > 0);
  const reworkCheckpoint = state.checkpoints.find((item) => item.status === 'rework');
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
    <div className="page-stack">
      {show('project') && <section className="project-heading">
        <div>
          <div className="project-heading__meta">
            <StatusBadge label={`${state.project.code} · активный проект`} tone="positive" />
            <span>{lastUpdated ? `Обновлено ${formatDateTime(lastUpdated)}` : 'Изменений пока нет'}</span>
          </div>
          <h1>{role === 'foreman' ? 'Сегодня на объекте' : state.project.name}</h1>
          <p>{[state.project.model, state.project.area ? `${state.project.area} м²` : '', state.project.address].filter(Boolean).join(' · ') || 'Заполните параметры первого объекта'}</p>
        </div>
      </section>}

      {(show('progress') || show('finance')) && <section className="metric-grid">
        {show('progress') &&
        <MetricCard
          label="Физический прогресс"
          value={`${progress.physical}%`}
          detail={<><ProgressBar value={progress.physical} /><span>{progress.accepted}% подтверждено контролем</span></>}
          icon={TrendingUp}
          tone="dark"
          onClick={() => onNavigate('schedule')}
        />}
        {role === 'foreman' ? (
          <>
            <MetricCard label="Текущий этап" value={`${currentStage.progress}%`} detail={<span>{currentStage.name} · до {formatDate(currentStage.forecastEnd)}</span>} icon={Clock3} onClick={() => onNavigate('schedule')} />
            <MetricCard label="Контроль качества" value={`${reviewCount + reworkCount} отчёта`} detail={<span>{reviewCount} на проверке · {reworkCount} требует доработки</span>} icon={ShieldCheck} tone={reworkCount ? 'warning' : 'positive'} onClick={() => onNavigate('quality')} />
            <MetricCard label="Поставки с риском" value={`${riskySupply.length}`} detail={<span>{riskySupply[0]?.risk ?? 'Рисков по поставкам нет'}</span>} icon={Truck} tone={riskySupply.length ? 'warning' : 'positive'} onClick={() => onNavigate('procurement')} />
          </>
        ) : show('finance') ? (
          <>
            <MetricCard
              label="Прогноз себестоимости"
              value={shortMoney(finance.forecast)}
              detail={<span className={finance.plan && finance.forecast > finance.plan ? 'negative-text' : 'positive-text'}>{!finance.plan ? 'Смета ещё не загружена' : finance.forecast > finance.plan ? `+${shortMoney(finance.forecast - finance.plan)} к плану` : 'В пределах плана'}</span>}
              icon={CircleDollarSign}
              tone={finance.forecast > finance.plan ? 'warning' : 'positive'}
              onClick={() => onNavigate('finance')}
            />
            <MetricCard
              label="Прогноз маржи"
              value={shortMoney(margin)}
              detail={<span>{marginPercent === null ? 'Стоимость договора не указана' : `${marginPercent}% от договора до налогов и финансирования`}</span>}
              icon={Banknote}
              onClick={() => onNavigate('finance')}
            />
            <MetricCard
              label="Нужно денег на 30 дней"
              value={shortMoney(cashNeed)}
              detail={<span>{shortMoney(finance.received - finance.paid)} сейчас доступно по проекту</span>}
              icon={CalendarClock}
              onClick={() => onNavigate('finance')}
            />
          </>
        ) : null}
      </section>}

      {(show('progress') || show('decisions')) && <section className="dashboard-grid dashboard-grid--main">
        {show('progress') && <article className="panel panel--progress">
          <SectionHeader
            eyebrow="Производство"
            title="Ход строительства"
            action={<button className="text-button" type="button" onClick={() => onNavigate('schedule')}>Все этапы <ChevronRight size={16} /></button>}
          />
          <div className="current-stage-card">
            <div className="current-stage-card__number">{String(currentStage.order).padStart(2, '0')}</div>
            <div className="current-stage-card__body">
              <div className="current-stage-card__top">
                <div>
                  <span>Текущий этап</span>
                  <h3>{currentStage.name}</h3>
                </div>
                <StatusBadge label={stageStatusLabel[currentStage.status]} tone={currentStage.status === 'rework' || currentStage.status === 'blocked' ? 'danger' : 'blue'} />
              </div>
              <div className="current-stage-card__progress">
                <ProgressBar value={currentStage.progress} />
                <strong>{currentStage.progress}%</strong>
              </div>
              <div className="current-stage-card__meta">
                <span><Clock3 size={15} /> прогноз до {formatDate(currentStage.forecastEnd)}</span>
                <span>Ответственный: {currentStage.responsible}</span>
              </div>
            </div>
          </div>

          <div className="stage-strip" aria-label="Этапы проекта">
            {state.stages.slice(0, 8).map((stage) => (
              <button key={stage.id} type="button" className={`stage-strip__item stage-strip__item--${stage.status}`} onClick={() => onNavigate('schedule')}>
                <span>{stage.order}</span>
                <strong>{stage.shortName}</strong>
                <small>{stage.status === 'accepted' ? '100%' : stage.progress ? `${stage.progress}%` : formatDate(stage.planStart)}</small>
              </button>
            ))}
          </div>
        </article>}

        {show('decisions') && <article className="panel decision-panel">
          <SectionHeader eyebrow="Контроль" title="Требует решения" action={<span className="count-badge">{reworkCount + riskySupply.length + (nextDecision ? 1 : 0)}</span>} />
          <div className="decision-list">
            {reworkCheckpoint && (
              <button type="button" onClick={() => onNavigate('quality')} className="decision-item decision-item--danger">
                <span className="decision-item__icon"><AlertTriangle size={18} /></span>
                <span><strong>{reworkCheckpoint.title}</strong><small>{reworkCheckpoint.zone}{reworkCheckpoint.note ? ` · ${reworkCheckpoint.note}` : ' · требуется доработка'}</small></span>
                <ChevronRight size={17} />
              </button>
            )}
            {riskySupply.slice(0, 1).map((item) => (
              <button key={item.id} type="button" onClick={() => onNavigate('procurement')} className="decision-item decision-item--warning">
                <span className="decision-item__icon"><Truck size={18} /></span>
                <span><strong>{item.item}</strong><small>{item.risk}</small></span>
                <ChevronRight size={17} />
              </button>
            ))}
            {nextDecision && (
              <div className="decision-item decision-item--static">
                <span className="decision-item__icon"><Clock3 size={18} /></span>
                <span><strong>Ответ клиента</strong><small>{nextDecision.title} · до {formatDate(nextDecision.dueDate)}</small></span>
                <StatusBadge label="Ожидаем" tone="neutral" />
              </div>
            )}
            {!reworkCheckpoint && !riskySupply.length && !nextDecision && <div className="overview-task-empty"><CheckCircle2 size={20} /> Решений, требующих внимания, нет</div>}
          </div>
          <div className="decision-panel__footer">
            <ShieldCheck size={18} />
            <p><strong>{reviewCount} работа на проверке</strong><br />Оплата станет доступна только после приёмки.</p>
          </div>
        </article>}
      </section>}

      <section className={`dashboard-grid dashboard-grid--bottom ${role === 'foreman' ? 'dashboard-grid--operations' : ''}`}>
        {role !== 'foreman' && show('cashflow') && <article className="panel cash-panel">
          <SectionHeader eyebrow="6 недель" title="Денежный поток" action={<button className="text-button" type="button" onClick={() => onNavigate('finance')}>Финансы <ChevronRight size={16} /></button>} />
          <div className="chart-legend"><span><i className="legend-dot legend-dot--income" /> Поступления</span><span><i className="legend-dot legend-dot--expense" /> Выплаты</span><small>тыс. ₽</small></div>
          {hasCashflow ? <div className="cash-chart">
            {cashflow.map((point) => (
              <div className="cash-chart__column" key={point.label}>
                <div className="cash-chart__bars">
                  <span className="cash-chart__bar cash-chart__bar--income" style={{ height: `${Math.max(2, point.income / maxCash * 100)}%` }} title={`Поступления ${point.income} тыс. ₽`} />
                  <span className="cash-chart__bar cash-chart__bar--expense" style={{ height: `${Math.max(2, point.expense / maxCash * 100)}%` }} title={`Выплаты ${point.expense} тыс. ₽`} />
                </div>
                <small>{point.label}</small>
              </div>
            ))}
          </div> : <div className="task-empty"><Banknote size={28} /><strong>Движений денег пока нет</strong><p>График начнёт строиться после первой фактической оплаты или поступления.</p></div>}
        </article>}

        {show('quality') && <article className="panel compact-panel">
          <SectionHeader eyebrow="Качество" title="Скрытые работы" />
          <div className="quality-score">
            <div className="quality-score__ring" style={{ '--score': `${progress.accepted * 3.6}deg` } as CSSProperties}><span>{progress.accepted}%</span></div>
            <div><strong>{state.checkpoints.filter((item) => item.status === 'accepted').length} акта принято</strong><p>{reviewCount} на проверке · {reworkCount} на доработке</p></div>
          </div>
          <button className="button button--secondary button--full" type="button" onClick={() => onNavigate('quality')}><CheckCircle2 size={17} /> Открыть контроль качества</button>
        </article>}

        {show('supply') && <article className="panel compact-panel">
          <SectionHeader eyebrow="Снабжение" title="Ближайшие поставки" />
          <div className="delivery-list">
            {state.procurement.filter((item) => ['ordered', 'in_transit', 'rfq'].includes(item.status)).slice(0, 3).map((item) => (
              <button type="button" key={item.id} onClick={() => onNavigate('procurement')}>
                <span className={item.risk ? 'delivery-list__icon delivery-list__icon--warning' : 'delivery-list__icon'}>{item.status === 'in_transit' ? <Truck size={17} /> : <PackageCheck size={17} />}</span>
                <span><strong>{item.item}</strong><small>Нужно к {formatDate(item.neededBy)}</small></span>
                <ChevronRight size={16} />
              </button>
            ))}
            {!state.procurement.some((item) => ['ordered', 'in_transit', 'rfq'].includes(item.status)) && <div className="overview-task-empty"><PackageCheck size={20} /> Ближайших поставок пока нет</div>}
          </div>
        </article>}
      </section>

      {show('tasks') && <section className="panel overview-task-panel">
        <SectionHeader
          eyebrow="Команда"
          title="Задачи и ответственность"
          action={<button className="text-button" type="button" onClick={() => onNavigate('tasks')}>{overdueTaskCount ? `${overdueTaskCount} просрочено` : 'Все задачи'} <ChevronRight size={16} /></button>}
        />
        <div className="overview-task-list">
          {activeTasks.slice(0, 3).map((task) => (
            <button type="button" key={task.id} className={isTaskOverdue(task) ? 'overview-task overview-task--overdue' : 'overview-task'} onClick={() => onNavigate('tasks')}>
              <span><ListTodo size={17} /></span>
              <div><strong>{task.title}</strong><small>{task.assigneeName} · {taskStatusLabel[task.status]}</small></div>
              <div><small>{isTaskOverdue(task) ? 'Просрочено' : 'Срок'}</small><strong>{formatDate(task.dueDate)}</strong></div>
              <ChevronRight size={16} />
            </button>
          ))}
          {!activeTasks.length && <div className="overview-task-empty"><CheckCircle2 size={20} /> Активных задач нет</div>}
        </div>
      </section>}

      {show('activity') && <section className="panel activity-panel">
        <SectionHeader eyebrow="Журнал проекта" title="Последние события" />
        <div className="activity-row">
          {state.activity.slice(0, 3).map((event) => (
            <div className={`activity-card activity-card--${event.tone}`} key={event.id}>
              <span className="activity-card__dot" />
              <div><strong>{event.text}</strong><p>{event.actor} · {formatDateTime(event.timestamp)}</p></div>
            </div>
          ))}
          {!state.activity.length && <div className="overview-task-empty"><Clock3 size={20} /> Журнал начнётся с первого рабочего действия</div>}
        </div>
      </section>}
    </div>
  );
}
