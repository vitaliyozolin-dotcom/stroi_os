const clean = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';

const statusLabels = {
  todo: 'к выполнению', in_progress: 'в работе', waiting: 'есть проблема', review: 'на проверке',
  done: 'выполнено', canceled: 'отменено', not_ready: 'не готов', ready: 'готов к старту',
  blocked: 'заблокирован', awaiting_inspection: 'ожидает приёмки', accepted: 'принято',
  rework: 'на доработке', need: 'требуется', rfq: 'запрос цен', ordered: 'заказано',
  in_transit: 'в пути', delivered: 'доставлено', issued: 'выдано', current: 'актуальный',
  signed: 'подписан', draft: 'черновик', new: 'новая', qualified: 'квалифицирована',
  site_visit: 'выезд', estimate: 'расчёт', negotiation: 'переговоры', won: 'сделка выиграна',
  lost: 'сделка проиграна', active: 'активен', completed: 'завершён', archived: 'в архиве',
};

const statusLabel = (value) => statusLabels[value] ?? clean(value, 80);
const amount = (value) => `${new Intl.NumberFormat('ru-RU').format(Number(value) || 0)} ₽`;
const event = (key, text, page, entityId, recipientId, severity = 'info') => ({ key, text, page, entityId, recipientId, severity });
const mapById = (items) => new Map((items ?? []).map((item) => [item.id, item]));

export const notificationEvents = (previous, next, options = {}) => {
  const enabled = next?.settings?.notifications?.events ?? {};
  const events = [];
  const today = clean(options.today, 10) || new Date().toISOString().slice(0, 10);

  if (enabled.projectActivity !== false && !previous && next?.project?.status !== 'workspace') {
    events.push(event('project.created', `Создан проект «${next.project?.name || next.project?.code || 'Без названия'}»`, 'project', undefined, undefined, 'positive'));
  }

  if (enabled.projectActivity !== false && previous) {
    if (previous.project?.status !== next.project?.status && ['active', 'completed', 'archived'].includes(next.project?.status)) {
      events.push(event(`project.status.${next.project.status}`, `Проект: статус → ${statusLabel(next.project.status)}`, 'project', undefined, undefined, next.project.status === 'completed' ? 'positive' : 'warning'));
    }
    if (previous.project?.targetDate !== next.project?.targetDate) {
      events.push(event(`project.target_date.${next.project?.targetDate || 'none'}`, `Срок проекта перенесён: ${previous.project?.targetDate || 'не указан'} → ${next.project?.targetDate || 'не указан'}`, 'project', undefined, undefined, 'warning'));
    }
  }

  const beforeTasks = mapById(previous?.tasks);
  for (const item of next?.tasks ?? []) {
    const before = beforeTasks.get(item.id);
    if (enabled.taskAssigned !== false && !before) events.push(event(`task.created.${item.id}`, `Задача: «${item.title}» → ${item.assigneeName}, срок ${item.dueDate}`, 'tasks', item.id, item.assigneeId));
    if (enabled.taskAssigned !== false && before && before.assigneeId !== item.assigneeId) events.push(event(`task.assignee.${item.id}.${item.assigneeId}`, `Задача «${item.title}» переназначена: ${before.assigneeName} → ${item.assigneeName}`, 'tasks', item.id, item.assigneeId));
    if (enabled.taskAssigned !== false && before && before.dueDate !== item.dueDate) events.push(event(`task.due.${item.id}.${item.dueDate}`, `Срок задачи «${item.title}»: ${before.dueDate} → ${item.dueDate}`, 'tasks', item.id, item.assigneeId, 'warning'));
    if (enabled.taskAssigned !== false && before && before.status !== item.status && ['waiting', 'review', 'done', 'canceled'].includes(item.status)) events.push(event(`task.status.${item.id}.${item.status}`, `Задача «${item.title}» → ${statusLabel(item.status)}`, 'tasks', item.id, item.assigneeId, item.status === 'done' ? 'positive' : item.status === 'waiting' ? 'critical' : 'info'));
    if (enabled.taskOverdue !== false && item.dueDate < today && !['done', 'canceled'].includes(item.status)) events.push(event(`task.overdue.${item.id}.${item.dueDate}`, `Просрочена задача «${item.title}» · ${item.assigneeName} · срок ${item.dueDate}`, 'tasks', item.id, item.assigneeId, 'critical'));
  }

  const beforeStages = mapById(previous?.stages);
  for (const item of next?.stages ?? []) {
    const before = beforeStages.get(item.id);
    if (enabled.scheduleDelay !== false && before && before.forecastEnd !== item.forecastEnd && item.forecastEnd > item.planEnd) events.push(event(`stage.delay.${item.id}.${item.forecastEnd}`, `График: «${item.name}», прогноз ${item.forecastEnd} позже плана ${item.planEnd}`, 'schedule', item.id, undefined, 'critical'));
    if (enabled.scheduleDelay !== false && before && before.status !== item.status && ['in_progress', 'blocked', 'awaiting_inspection', 'accepted', 'rework'].includes(item.status)) events.push(event(`stage.status.${item.id}.${item.status}`, `Этап «${item.name}» → ${statusLabel(item.status)}${item.blocker ? ` · ${clean(item.blocker)}` : ''}`, 'schedule', item.id, undefined, ['blocked', 'rework'].includes(item.status) ? 'critical' : item.status === 'accepted' ? 'positive' : 'info'));
  }

  const beforeFinance = mapById(previous?.financeEntries);
  for (const item of next?.financeEntries ?? []) {
    const before = beforeFinance.get(item.id);
    if (enabled.financeApproval !== false && !before) events.push(event(`finance.created.${item.id}`, `${item.kind === 'income' ? 'Доход' : 'Расход'}: «${item.description}» · ${amount(item.amount)}`, 'finance', item.id));
    if (enabled.financeApproval !== false && before && item.status === 'accepted' && before.status !== 'accepted') events.push(event(`finance.accepted.${item.id}`, `Финансы: принято «${item.description}» · ${amount(item.acceptedAmount ?? item.amount)}`, 'finance', item.id, undefined, 'positive'));
    if (enabled.financeApproval !== false && Number(item.paidAmount) > Number(before?.paidAmount ?? 0)) events.push(event(`finance.paid.${item.id}.${item.paidAmount}`, `${item.kind === 'income' ? 'Получено' : 'Оплачено'}: «${item.description}» · ${amount(item.paidAmount)}`, 'finance', item.id, undefined, 'positive'));
  }

  const beforeSupply = mapById(previous?.procurement);
  for (const item of next?.procurement ?? []) {
    const before = beforeSupply.get(item.id);
    if (enabled.supplyRisk !== false && !before) events.push(event(`supply.created.${item.id}`, `Снабжение: требуется «${item.item}» до ${item.neededBy}`, 'procurement', item.id));
    if (enabled.supplyRisk !== false && item.risk && before?.risk !== item.risk) events.push(event(`supply.risk.${item.id}.${clean(item.risk, 120)}`, `Снабжение: «${item.item}» · риск: ${clean(item.risk)}`, 'procurement', item.id, undefined, 'critical'));
    if (enabled.supplyRisk !== false && before && before.status !== item.status && ['ordered', 'in_transit', 'delivered', 'accepted'].includes(item.status)) events.push(event(`supply.status.${item.id}.${item.status}`, `Снабжение: «${item.item}» → ${statusLabel(item.status)}`, 'procurement', item.id, undefined, item.status === 'accepted' ? 'positive' : 'info'));
  }

  const beforeQuality = mapById(previous?.checkpoints);
  for (const item of next?.checkpoints ?? []) {
    const before = beforeQuality.get(item.id);
    if (enabled.qualityRework !== false && before && before.status !== item.status && ['in_review', 'accepted', 'rework'].includes(item.status)) events.push(event(`quality.status.${item.id}.${item.status}`, `Качество: «${item.title}» → ${statusLabel(item.status)}`, 'quality', item.id, undefined, item.status === 'rework' ? 'critical' : item.status === 'accepted' ? 'positive' : 'info'));
  }

  const beforeLeads = mapById(previous?.leads);
  for (const item of next?.leads ?? []) {
    const before = beforeLeads.get(item.id);
    if (enabled.leadWithoutAction !== false && !before) events.push(event(`lead.created.${item.id}`, `CRM: новая заявка · ${item.name}${clean(item.nextAction) ? ` · далее: ${clean(item.nextAction)}` : ' · нет следующего действия'}`, 'marketing', item.id, undefined, 'warning'));
    if (enabled.leadWithoutAction !== false && before && before.stage !== item.stage && ['negotiation', 'won', 'lost'].includes(item.stage)) events.push(event(`lead.stage.${item.id}.${item.stage}`, `CRM: ${item.name} → ${statusLabel(item.stage)}`, 'marketing', item.id, undefined, item.stage === 'won' ? 'positive' : item.stage === 'lost' ? 'warning' : 'info'));
  }

  const beforeDocuments = mapById(previous?.documents);
  for (const item of enabled.projectActivity !== false ? next?.documents ?? [] : []) {
    const before = beforeDocuments.get(item.id);
    if (!before) events.push(event(`document.created.${item.id}`, `Документ добавлен: «${item.name}»`, 'project', item.id));
    if (before && before.status !== 'signed' && item.status === 'signed') events.push(event(`document.signed.${item.id}`, `Документ подписан: «${item.name}»`, 'project', item.id, undefined, 'positive'));
  }

  const beforeDecisions = mapById(previous?.decisions);
  for (const item of enabled.projectActivity !== false ? next?.decisions ?? [] : []) {
    const before = beforeDecisions.get(item.id);
    if (!before) events.push(event(`decision.created.${item.id}`, `Требуется решение: «${item.title}» · до ${item.dueDate}`, 'project', item.id, undefined, 'warning'));
    if (before && before.status !== 'decided' && item.status === 'decided') events.push(event(`decision.decided.${item.id}`, `Решение принято: «${item.title}»${item.choice ? ` · ${clean(item.choice)}` : ''}`, 'project', item.id, undefined, 'positive'));
  }

  const beforeReports = new Set((previous?.fieldReports ?? []).map((item) => item.id));
  for (const item of enabled.projectActivity !== false ? next?.fieldReports ?? [] : []) if (!beforeReports.has(item.id)) events.push(event(`report.created.${item.id}`, `Полевой отчёт: ${clean(item.note, 180) || 'без комментария'} · ${item.author}`, 'project', item.id));

  const beforeCounterparties = mapById(previous?.counterparties);
  for (const item of enabled.projectActivity !== false ? next?.counterparties ?? [] : []) {
    const before = beforeCounterparties.get(item.id);
    if (before && before.status !== 'blocked' && item.status === 'blocked') events.push(event(`counterparty.blocked.${item.id}`, `Контрагент заблокирован: «${item.name}»`, 'counterparties', item.id, undefined, 'critical'));
  }

  const seen = new Set();
  return events.filter((item) => item.text && !seen.has(item.key) && seen.add(item.key)).slice(0, 16);
};

const severityIcon = (severity) => ({ critical: '🚨', warning: '⚠️', positive: '✅', info: '•' })[severity] ?? '•';

export const formatNotificationMessage = ({ project, actor, events, linkFor, occurredAt = new Date().toISOString() }) => {
  const projectTitle = [clean(project?.code, 40), clean(project?.name, 120)].filter(Boolean).join(' · ') || 'проект';
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(occurredAt));
  const lines = events.map((item) => `${severityIcon(item.severity)} ${item.text}\n${linkFor(item)}`);
  return `ИКИОМА ОС · ${projectTitle}\n${time} · ${clean(actor, 120) || 'Система'}\n\n${lines.join('\n\n')}`.slice(0, 3900);
};
