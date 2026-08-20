export {
  acceptedAmountFor,
  financeTotals,
  isTaskClosed,
  isTaskOverdue,
  lineTotals,
  mergeProjectStates,
  paidAmountFor,
  projectProgressTotals as progressTotals,
  stageFinanceTotals,
  stageProgressTotals,
  synchronizeDerivedProgress,
  taskPhysicalProgress,
} from './domain/index.ts';
export { formatDate, formatDateTime, money, shortMoney } from './presentation/formatting.ts';
export { stageStatusLabel, taskPriorityLabel, taskStatusLabel } from './presentation/status-labels.ts';
export { uid } from './infrastructure/runtime.ts';
