import type { AppState } from '../entities/index';

export const normalizeAppStateWithFallback = (state: AppState, fallback: AppState): AppState => {
  const sourceWidgets = Array.isArray(state.settings?.dashboardWidgets)
    ? state.settings.dashboardWidgets
    : fallback.settings.dashboardWidgets;
  const dashboardWidgets = Number(state.settings?.schemaVersion) >= 2 || sourceWidgets.includes('tasks')
    ? sourceWidgets
    : [...sourceWidgets, 'tasks' as const];

  return {
    ...state,
    budgetMeta: state.budgetMeta ?? fallback.budgetMeta,
    procurement: state.procurement.map((item) => ({
      ...item,
      budgetLineId: item.budgetLineId ?? state.budgetLines.find((line) => line.stageIds.includes(item.stageId))?.id,
      deliveryAddress: item.deliveryAddress ?? `Объект ${state.project.code}`,
    })),
    counterparties: Array.isArray(state.counterparties) ? state.counterparties : fallback.counterparties,
    supplierQuotes: Array.isArray(state.supplierQuotes) ? state.supplierQuotes : fallback.supplierQuotes,
    leads: Array.isArray(state.leads) ? state.leads : fallback.leads,
    tasks: (Array.isArray(state.tasks)
      ? state.tasks
      : state.project.id === fallback.project.id
        ? fallback.tasks
        : []
    ).map((task) => ({
      ...task,
      originalDueDate: task.originalDueDate ?? task.dueDate,
      rescheduleCount: Number(task.rescheduleCount) || 0,
      attachments: Array.isArray(task.attachments) ? task.attachments : [],
      history: Array.isArray(task.history) ? task.history : [],
    })),
    fieldReports: Array.isArray(state.fieldReports) ? state.fieldReports : [],
    settings: {
      schemaVersion: 17,
      users: Array.isArray(state.settings?.users) ? state.settings.users : fallback.settings.users,
      notifications: {
        channels: { ...fallback.settings.notifications.channels, ...state.settings?.notifications?.channels },
        events: { ...fallback.settings.notifications.events, ...state.settings?.notifications?.events },
      },
      dashboardWidgets,
    },
  };
};
