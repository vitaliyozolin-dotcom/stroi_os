import { addCalendarDays, isoDate } from '../lib/date.js';
import { clean } from '../lib/validation.js';

const activeAutomationUser = (state, preferredName = '') => {
  const users = (state.settings?.users ?? []).filter((user) => user.status === 'active');
  const preferred = clean(preferredName, 120).toLocaleLowerCase('ru');
  return users.find((user) => clean(user.name, 120).toLocaleLowerCase('ru') === preferred)
    ?? users.find((user) => user.role === 'foreman')
    ?? users.find((user) => user.role === 'management')
    ?? { id: 'user-owner', name: 'Виталий Озолин', role: 'management', status: 'active' };
};

export const applyBattleAutomations = (previous, next, actor) => {
  if (!previous || next.project?.status === 'workspace') return next;
  next.tasks = Array.isArray(next.tasks) ? next.tasks : [];
  next.activity = Array.isArray(next.activity) ? next.activity : [];
  const now = new Date().toISOString();
  const tomorrow = isoDate(addCalendarDays(new Date(), 1));
  const automated = [];

  const ensureTask = ({ id, title, description, dueDate, priority, assignee, links }) => {
    const existing = next.tasks.find((task) => task.id === id);
    if (existing) {
      if (['done', 'canceled'].includes(existing.status)) {
        existing.status = 'todo';
        existing.completedAt = undefined;
        existing.completionNote = undefined;
        existing.updatedAt = now;
        existing.dueDate = dueDate || tomorrow;
        existing.rescheduleCount = Number(existing.rescheduleCount ?? 0) + 1;
        existing.history = [
          ...(existing.history ?? []),
          {
            id: crypto.randomUUID(),
            timestamp: now,
            actor: 'ИКИОМА ОС',
            kind: 'reopened',
            text: `Автоматически переоткрыта после нового события · ${actor}`,
          },
        ];
        automated.push(`Переоткрыта задача «${title}»`);
      }
      return;
    }
    next.tasks.unshift({
      id,
      title,
      description,
      status: 'todo',
      priority,
      assigneeId: assignee.id,
      assigneeName: assignee.name,
      createdBy: 'ИКИОМА ОС',
      createdAt: now,
      updatedAt: now,
      dueDate: dueDate || tomorrow,
      originalDueDate: dueDate || tomorrow,
      rescheduleCount: 0,
      ...links,
      history: [{
        id: crypto.randomUUID(),
        timestamp: now,
        actor: 'ИКИОМА ОС',
        kind: 'created',
        text: `Создана автоматически после изменения · ${actor}`,
      }],
    });
    automated.push(`Создана задача «${title}»`);
  };

  const beforeCheckpoints = new Map((previous.checkpoints ?? []).map((item) => [item.id, item]));
  for (const checkpoint of next.checkpoints ?? []) {
    const before = beforeCheckpoints.get(checkpoint.id);
    if (checkpoint.status !== 'rework' || before?.status === 'rework') continue;
    const stage = (next.stages ?? []).find((item) => item.id === checkpoint.stageId);
    const assignee = activeAutomationUser(next, checkpoint.assignee || stage?.responsible);
    ensureTask({
      id: `auto-quality-${checkpoint.id}`,
      title: `Устранить замечание: ${checkpoint.title}`,
      description: checkpoint.note || `Проверка качества возвращена на доработку${checkpoint.zone ? ` · ${checkpoint.zone}` : ''}.`,
      dueDate: tomorrow,
      priority: 'high',
      assignee,
      links: { stageId: checkpoint.stageId, checkpointId: checkpoint.id },
    });
  }

  const beforeSupply = new Map((previous.procurement ?? []).map((item) => [item.id, item]));
  for (const item of next.procurement ?? []) {
    const before = beforeSupply.get(item.id);
    if (!item.risk || before?.risk === item.risk) continue;
    const assignee = activeAutomationUser(next, item.owner);
    ensureTask({
      id: `auto-supply-${item.id}`,
      title: `Снять риск поставки: ${item.item}`,
      description: item.risk,
      dueDate: item.neededBy || tomorrow,
      priority: 'high',
      assignee,
      links: { stageId: item.stageId, procurementItemId: item.id },
    });
  }

  const beforeStages = new Map((previous.stages ?? []).map((item) => [item.id, item]));
  for (const stage of next.stages ?? []) {
    const before = beforeStages.get(stage.id);
    if (stage.status !== 'in_progress' || before?.status === 'in_progress') continue;
    const assignee = activeAutomationUser(next, stage.responsible);
    if (!(next.checkpoints ?? []).some((checkpoint) => checkpoint.stageId === stage.id)) {
      const reviewer = (next.settings?.users ?? []).find((user) => user.status === 'active' && user.role === 'management')
        ?? activeAutomationUser(next, '');
      next.checkpoints = Array.isArray(next.checkpoints) ? next.checkpoints : [];
      next.checkpoints.push({
        id: `auto-checkpoint-${stage.id}`,
        stageId: stage.id,
        title: `Фотофиксация: ${stage.shortName || stage.name}`,
        zone: 'Весь этап',
        status: 'pending',
        requiredShots: [
          'Общий вид зоны',
          'Средний план работы',
          'Крупный план узла',
          'Замер с читаемым прибором',
          'Маркировка материала',
          'Результат испытания',
          'Итог после устранения замечаний',
        ],
        photos: [],
        assignee: assignee.name,
        reviewer: reviewer.name,
        clientVisible: false,
      });
      automated.push(`Создана контрольная точка «${stage.shortName || stage.name}»`);
    }
    ensureTask({
      id: `auto-stage-${stage.id}`,
      title: `Вести этап: ${stage.name}`,
      description: 'Контролировать ход этапа, сроки, фотофиксацию и закрывающие документы.',
      dueDate: stage.forecastEnd || stage.planEnd || tomorrow,
      priority: 'normal',
      assignee,
      links: { stageId: stage.id },
    });
  }

  if (automated.length) {
    next.activity.unshift({
      id: crypto.randomUUID(),
      timestamp: now,
      actor: 'ИКИОМА ОС',
      text: automated.join('. '),
      tone: 'neutral',
    });
  }
  return next;
};
