import type { AppState, ProjectTask } from '../entities/index';

type RuntimeProgressTask = ProjectTask & {
  progressWeight?: number;
  progressMode?: 'binary' | 'quantity' | 'checklist';
  completedQuantity?: number;
  totalQuantity?: number;
  progressChecklist?: Array<{ done?: boolean }>;
};

const clamp = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

export const taskPhysicalProgress = (task: ProjectTask): number | null => {
  if (task.status === 'canceled') return null;
  const tracked = task as RuntimeProgressTask;
  if (tracked.progressMode === 'quantity' && Number(tracked.totalQuantity) > 0) {
    return clamp(Number(tracked.completedQuantity || 0) / Number(tracked.totalQuantity) * 100);
  }
  if (tracked.progressMode === 'checklist' && Array.isArray(tracked.progressChecklist) && tracked.progressChecklist.length) {
    const done = tracked.progressChecklist.filter((item) => item.done).length;
    return clamp(done / tracked.progressChecklist.length * 100);
  }
  return ['review', 'done'].includes(task.status) ? 100 : 0;
};

const taskWeight = (task: ProjectTask) => {
  const value = Number((task as RuntimeProgressTask).progressWeight);
  return Number.isFinite(value) && value > 0 ? value : 1;
};

const tasksByStage = (tasks: ProjectTask[]) => {
  const grouped = new Map<string, ProjectTask[]>();
  for (const task of tasks) {
    if (!task.stageId || task.status === 'canceled') continue;
    const stageTasks = grouped.get(task.stageId);
    if (stageTasks) stageTasks.push(task);
    else grouped.set(task.stageId, [task]);
  }
  return grouped;
};

const progressForStage = (stage: AppState['stages'][number], tasks: ProjectTask[]) => {
  if (!tasks.length) {
    const completed = stage.status === 'accepted' ? 100 : 0;
    return { physical: completed, accepted: completed };
  }
  const totalWeight = tasks.reduce((sum, task) => sum + taskWeight(task), 0);
  const physical = tasks.reduce((sum, task) => sum + taskWeight(task) * (taskPhysicalProgress(task) || 0), 0) / totalWeight;
  return {
    physical: Math.round(clamp(physical)),
    accepted: stage.status === 'accepted' ? 100 : 0,
  };
};

export const stageProgressTotals = (state: AppState, stageId: string) => {
  const stage = state.stages.find((item) => item.id === stageId);
  if (!stage) return { physical: 0, accepted: 0 };
  const tasks = state.tasks.filter((task) => task.stageId === stageId && task.status !== 'canceled');
  return progressForStage(stage, tasks);
};

export const projectProgressTotals = (state: AppState) => {
  const totalWeight = state.stages.reduce((sum, stage) => sum + Math.max(0, Number(stage.weight) || 0), 0);
  if (!totalWeight) return { physical: 0, accepted: 0 };
  const groupedTasks = tasksByStage(state.tasks);
  const totals = state.stages.reduce((result, stage) => {
    const stageProgress = progressForStage(stage, groupedTasks.get(stage.id) ?? []);
    return {
      physical: result.physical + stage.weight * stageProgress.physical,
      accepted: result.accepted + stage.weight * stageProgress.accepted,
    };
  }, { physical: 0, accepted: 0 });
  return {
    physical: Math.round(totals.physical / totalWeight),
    accepted: Math.round(totals.accepted / totalWeight),
  };
};

export const synchronizeDerivedProgress = (state: AppState): AppState => {
  let changed = false;
  const groupedTasks = tasksByStage(state.tasks);
  const stages = state.stages.map((stage) => {
    const physical = progressForStage(stage, groupedTasks.get(stage.id) ?? []).physical;
    if (stage.progress === physical) return stage;
    changed = true;
    return { ...stage, progress: physical };
  });
  return changed ? { ...state, stages } : state;
};
