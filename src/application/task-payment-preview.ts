import type { ConstructionSnapshot } from '../domain/contexts.ts';
import type { ModuleContext } from './module-repository.ts';
import { moduleFingerprint } from './module-repository.ts';
import { createTaskUseCases } from './tasks-runtime.js';
import type { SchedulePaymentPreview } from './schedule-payment-preview.ts';

type TaskCommands = ReturnType<typeof createTaskUseCases>;
/** Run the real task command against a disposable copy. No state sink or runtime IDs escape. */
function previewTaskCommand<S extends ConstructionSnapshot>(state: S, identity: ModuleContext['identity'], timestamp: string,
  run: (commands: TaskCommands) => ReturnType<TaskCommands['save']>): SchedulePaymentPreview<S> {
  if (identity.role !== 'management') return { ok: false, error: 'Финансовое влияние доступно управлению.' };
  let candidate = structuredClone(state), nextId = 0;
  const commands = createTaskUseCases({
    read: () => ({ ok: true, snapshot: candidate }),
    commit: change => {
      if (change.projectId !== candidate.project.id || change.expected !== moduleFingerprint(candidate)) return { ok: false, error: 'Задача обновилась. Откройте форму заново.' };
      candidate = { ...candidate, tasks: change.patch.tasks ?? candidate.tasks };
      return { ok: true };
    },
  }, {
    identity, clock: { now: () => timestamp }, ids: { next: prefix => `task-preview-${prefix}-${++nextId}` },
  });
  const result = run(commands);
  return result.ok ? { ok: true, state: candidate } : result;
}

export function previewTaskSave<S extends ConstructionSnapshot>(state: S, identity: ModuleContext['identity'], timestamp: string,
  input: Parameters<TaskCommands['save']>[0]): SchedulePaymentPreview<S> {
  return previewTaskCommand(state, identity, timestamp, commands => commands.save(input));
}

export function previewTaskStatus<S extends ConstructionSnapshot>(state: S, identity: ModuleContext['identity'], timestamp: string,
  input: Parameters<TaskCommands['status']>[0]): SchedulePaymentPreview<S> {
  return previewTaskCommand(state, identity, timestamp, commands => commands.status(input));
}
