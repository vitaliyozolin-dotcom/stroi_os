import type { ProjectTask, TaskPriority, TaskStatus } from '../entities/index';
import type { ConstructionSnapshot, ConstructionPatch } from '../domain/contexts.ts';
import { saveTask, changeTaskStatus, addTaskComment, type ConstructionMutation } from '../domain/mutations.ts';
import { taskBaselineEnd, validPlanDate } from '../domain/construction/index.js';
import { validateBaselineChanges } from '../domain/construction/index.js';
import { moduleChange, executeModule, type ModuleContext, type ModuleRepository } from './module-repository.ts';
export interface TaskDraft { title: string; description: string; priority: TaskPriority; assigneeId: string; reviewerId: string; dueDate: string; plannedStart: string; baselineEnd: string; baselineNote: string; reason: string; stageId: string; counterpartyId: string; procurementItemId: string; checkpointId: string }
export const taskSnapshot = (state: Pick<ConstructionSnapshot, 'project' | 'tasks'>, taskId = '') => JSON.stringify([state.project.id, taskId ? state.tasks.find(task => task.id === taskId) : null]);
const formatTaskDate = (value: string) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date) : 'Дата не указана'; };
const buildTask = (state: ConstructionSnapshot, draft: TaskDraft, editingId: string | undefined, context: ModuleContext): ConstructionMutation => {
 const { clock, ids } = context, actor = context.identity.name;
 const timestamp = clock.now();
 const mutationContext = { actor, timestamp, nextId: (prefix: string) => ids.next(prefix) };
 const internalUsers = state.settings.users.filter(user => user.status !== 'disabled' && user.role !== 'client');
  const assignee = internalUsers.find((user) => user.id === draft.assigneeId);
  if (!draft.title.trim() || !assignee || !validPlanDate(draft.dueDate)) throw new Error('Укажите название, ответственного и корректный срок.');
  const reviewer = internalUsers.find((user) => user.id === draft.reviewerId);

  if (!editingId) {
    const task: ProjectTask = {
      id: ids.next('task'),
      title: draft.title.trim(),
      description: draft.description.trim() || undefined,
      status: 'todo',
      priority: draft.priority,
      assigneeId: assignee.id,
      assigneeName: assignee.name,
      reviewerId: reviewer?.id,
      reviewerName: reviewer?.name,
      createdBy: actor,
      createdAt: timestamp,
      updatedAt: timestamp,
      dueDate: draft.dueDate,
      plannedStart: draft.plannedStart || undefined,
      planChangeReason: draft.reason.trim(),
      originalDueDate: draft.dueDate,
      baseline: { start: draft.plannedStart || undefined, end: draft.dueDate, source: 'initial', note: 'Первоначальный срок при постановке задачи', recordedAt: timestamp, recordedBy: actor },
      stageId: draft.stageId || undefined,
      counterpartyId: draft.counterpartyId || undefined,
      procurementItemId: draft.procurementItemId || undefined,
      checkpointId: draft.checkpointId || undefined,
      rescheduleCount: 0,
      history: [{ id: ids.next('task-history'), timestamp, actor, kind: 'created', text: `Создал задачу и назначил ${assignee.name}` }],
    };
    return saveTask(state, { task, isNew: true }, mutationContext);
  } else {
    const previous = state.tasks.find((task) => task.id === editingId);
    if (!previous) throw new Error('Задача удалена. Откройте список заново.');
    if ((previous.dueDate !== draft.dueDate || (previous.plannedStart || '') !== draft.plannedStart) && !draft.reason.trim()) throw new Error('Укажите причину изменения срока.');
    if (!taskBaselineEnd(previous) && draft.baselineEnd && !draft.baselineNote.trim()) throw new Error('Укажите источник первоначального срока.');
    const changes = [];
    if (previous.assigneeId !== assignee.id) changes.push({ id: ids.next('task-history'), timestamp, actor, kind: 'assignee' as const, text: `Ответственный изменён: ${previous.assigneeName} → ${assignee.name}` });
    if (previous.dueDate !== draft.dueDate) changes.push({ id: ids.next('task-history'), timestamp, actor, kind: 'due_date' as const, text: `Срок изменён: ${formatTaskDate(previous.dueDate)} → ${formatTaskDate(draft.dueDate)} · ${draft.reason.trim()}` });
    if (previous.title !== draft.title.trim() || previous.description !== (draft.description.trim() || undefined) || previous.priority !== draft.priority) changes.push({ id: ids.next('task-history'), timestamp, actor, kind: 'edited' as const, text: 'Обновлены содержание или приоритет задачи' });
    const task: ProjectTask = {
      ...previous,
      originalDueDate: previous.originalDueDate || draft.baselineEnd,
      baseline: previous.baseline || (!previous.originalDueDate && draft.baselineEnd ? { end: draft.baselineEnd, source: 'document' as const, note: draft.baselineNote.trim(), recordedAt: timestamp, recordedBy: actor } : undefined),
      title: draft.title.trim(),
      description: draft.description.trim() || undefined,
      priority: draft.priority,
      assigneeId: assignee.id,
      assigneeName: assignee.name,
      reviewerId: reviewer?.id,
      reviewerName: reviewer?.name,
      dueDate: draft.dueDate,
      plannedStart: draft.plannedStart,
      planChangeReason: draft.reason.trim(),
      stageId: draft.stageId || undefined,
      counterpartyId: draft.counterpartyId || undefined,
      procurementItemId: draft.procurementItemId || undefined,
      checkpointId: draft.checkpointId || undefined,
      updatedAt: timestamp,
      rescheduleCount: previous.rescheduleCount + (previous.dueDate !== draft.dueDate ? 1 : 0),
      history: [...changes, ...previous.history],
    };
    return saveTask(state, { task, isNew: false }, mutationContext);
  }
};
export const createTaskUseCases = (repository: ModuleRepository<ConstructionSnapshot, ConstructionPatch>, context: ModuleContext) => {
 const execute = (command: (state: ConstructionSnapshot) => ConstructionMutation) => executeModule(repository, state => {
  try {
   if (context.identity.role === 'client') throw new Error('Задачи доступны команде проекта.');
   const result = command(state);
   const candidate = { ...state, tasks: result.patch.tasks ?? state.tasks };
   const error = validateBaselineChanges(state, structuredClone(candidate), context.identity, context.clock.now());
   if (error) throw new Error(error);
   const change = moduleChange(state, result.patch, result.action, result.summary, context, result.event?.tone, false);
   return { ok: true as const, change: { ...change, event: result.event } };
  } catch (failure) { return { ok: false as const, error: failure instanceof Error ? failure.message : 'Не удалось изменить задачу.' }; }
 });
 const currentTask = (state: ConstructionSnapshot, taskId: string, expected: string) => {
  const task = state.tasks.find(task => task.id === taskId);
  if (!task || taskSnapshot(state, taskId) !== expected) throw new Error('Задача обновилась. Откройте карточку заново.');
  if (context.identity.role !== 'management' && task.assigneeId !== context.identity.id && task.assigneeName !== context.identity.name) throw new Error('Изменяйте только свои задачи.');
  return task;
 };
 return {
  save: (input: { taskId?: string; expected: string; draft: TaskDraft }) => execute(state => {
   if (context.identity.role !== 'management') throw new Error('Задачи создаёт и редактирует управление.');
   if (input.expected !== taskSnapshot(state, input.taskId)) throw new Error('Задача или проект обновились. Откройте форму заново.');
   for (const [key, rows] of [['stageId', state.stages], ['counterpartyId', state.counterparties], ['procurementItemId', state.procurement], ['checkpointId', state.checkpoints]] as const) if (input.draft[key] && !rows.some(row => row.id === input.draft[key])) throw new Error('Связанная запись больше недоступна. Откройте форму заново.');
   return buildTask(state, input.draft, input.taskId, context);
  }),
  status: (input: { taskId: string; expected: string; status: TaskStatus; text: string; extra?: Pick<Partial<ProjectTask>, 'completionNote' | 'blockerReason'> }) => execute(state => {
   const task = currentTask(state, input.taskId, input.expected);
   if (!['todo', 'in_progress', 'waiting', 'review', 'done', 'canceled'].includes(input.status)) throw new Error('Неизвестный статус задачи.');
   if (input.status === 'done' && task.reviewerId && context.identity.role !== 'management') throw new Error('Задача требует отдельной приёмки управления.');
   return changeTaskStatus(state, input, { actor: context.identity.name, timestamp: context.clock.now(), nextId: prefix => context.ids.next(prefix) });
  }),
  comment: (input: { taskId: string; expected: string; text: string }) => execute(state => {
   currentTask(state, input.taskId, input.expected);
   if (!input.text.trim()) throw new Error('Напишите комментарий.');
   return addTaskComment(state, { ...input, text: input.text.trim() }, { actor: context.identity.name, timestamp: context.clock.now(), nextId: prefix => context.ids.next(prefix) });
  }),
 };
};
