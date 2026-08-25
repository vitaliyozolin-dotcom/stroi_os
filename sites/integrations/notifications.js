import { clean } from '../lib/validation.js';
import { telegramDurableSend } from '../telegram/outbox.js';
import { taskActionMarkup } from '../telegram/rendering.js';

const notificationStatusLabels = {
  ordered: 'заказано', in_transit: 'в пути', delivered: 'доставлено', accepted: 'принято',
  blocked: 'заблокировано', rework: 'доработка', waiting: 'ожидает', review: 'на проверке', done: 'выполнено',
};

export const notificationEvent = (text, page, entityId, recipientId) => ({ text, page, entityId, recipientId });

export const notificationEvents = (previous, next, today = new Date().toISOString().slice(0, 10)) => {
  if (!previous) return [];
  const enabled = next.settings?.notifications?.events ?? {};
  const events = [];
  const beforeCheckpoints = new Map((previous.checkpoints ?? []).map((item) => [item.id, item]));
  for (const item of next.checkpoints ?? []) {
    const before = beforeCheckpoints.get(item.id);
    if (enabled.qualityRework && item.status === 'rework' && before?.status !== 'rework') events.push(notificationEvent(`Качество: «${item.title}» возвращено на доработку`, 'quality', item.id));
    if (enabled.qualityRework && item.status === 'accepted' && before?.status !== 'accepted') events.push(notificationEvent(`Качество: «${item.title}» принято`, 'quality', item.id));
  }
  const beforeSupply = new Map((previous.procurement ?? []).map((item) => [item.id, item]));
  for (const item of next.procurement ?? []) {
    const before = beforeSupply.get(item.id);
    if (enabled.supplyRisk && item.risk && before?.risk !== item.risk) events.push(notificationEvent(`Снабжение: «${item.item}» — ${item.risk}`, 'procurement', item.id));
    if (enabled.supplyRisk && before && before.status !== item.status && ['ordered', 'in_transit', 'delivered', 'accepted'].includes(item.status)) events.push(notificationEvent(`Снабжение: «${item.item}» → ${notificationStatusLabels[item.status] ?? item.status}`, 'procurement', item.id));
  }
  const beforeFinance = new Map((previous.financeEntries ?? []).map((item) => [item.id, item]));
  for (const item of next.financeEntries ?? []) {
    const before = beforeFinance.get(item.id);
    if (enabled.financeApproval && item.kind === 'expense' && item.status === 'accepted' && before?.status !== 'accepted') events.push(notificationEvent(`Финансы: принято «${item.description}», ${item.amount} ₽`, 'finance', item.id));
    if (enabled.financeApproval && item.kind === 'expense' && Number(item.paidAmount) > Number(before?.paidAmount ?? 0)) events.push(notificationEvent(`Финансы: оплачено «${item.description}», всего ${Number(item.paidAmount)} ₽`, 'finance', item.id));
    if (enabled.financeApproval && item.kind === 'income' && Number(item.paidAmount) > Number(before?.paidAmount ?? 0)) events.push(notificationEvent(`Финансы: получено «${item.description}», всего ${Number(item.paidAmount)} ₽`, 'finance', item.id));
  }
  const beforeStages = new Map((previous.stages ?? []).map((item) => [item.id, item]));
  for (const item of next.stages ?? []) {
    const before = beforeStages.get(item.id);
    if (enabled.scheduleDelay && item.forecastEnd > item.planEnd && before?.forecastEnd !== item.forecastEnd) events.push(notificationEvent(`График: «${item.name}», прогноз ${item.forecastEnd} позже плана ${item.planEnd}`, 'schedule', item.id));
    if (enabled.scheduleDelay && before && before.status !== item.status && ['blocked', 'accepted', 'rework'].includes(item.status)) events.push(notificationEvent(`Этап: «${item.name}» → ${notificationStatusLabels[item.status] ?? item.status}`, 'schedule', item.id));
  }
  const beforeLeads = new Set((previous.leads ?? []).map((item) => item.id));
  for (const item of next.leads ?? []) if (enabled.leadWithoutAction && !beforeLeads.has(item.id)) events.push(notificationEvent(`CRM: новая заявка ${item.name}${clean(item.nextAction) ? `, далее: ${clean(item.nextAction)}` : ' без следующего действия'}`, 'marketing', item.id));
  const beforeTasks = new Map((previous.tasks ?? []).map((item) => [item.id, item]));
  for (const item of next.tasks ?? []) {
    const before = beforeTasks.get(item.id);
    if (enabled.taskAssigned && (!before || before.assigneeId !== item.assigneeId)) events.push(notificationEvent(`Задача: «${item.title}» → ${item.assigneeName}, срок ${item.dueDate}`, 'tasks', item.id, item.assigneeId));
    if (enabled.taskAssigned && before && before.dueDate !== item.dueDate) events.push(notificationEvent(`Срок задачи «${item.title}» перенесён: ${before.dueDate} → ${item.dueDate}`, 'tasks', item.id, item.assigneeId));
    if (enabled.taskAssigned && before && before.status !== item.status && ['waiting', 'review', 'done'].includes(item.status)) events.push(notificationEvent(`Задача: «${item.title}» → ${notificationStatusLabels[item.status] ?? item.status}`, 'tasks', item.id, item.assigneeId));
    if (enabled.taskOverdue && item.dueDate < today && !['done', 'canceled'].includes(item.status) && (!before || before.dueDate >= today || ['done', 'canceled'].includes(before.status))) events.push(notificationEvent(`Просрочена задача: «${item.title}», ответственный ${item.assigneeName}`, 'tasks', item.id, item.assigneeId));
  }
  const beforeDocuments = new Map((previous.documents ?? []).map((item) => [item.id, item]));
  for (const item of next.documents ?? []) {
    const before = beforeDocuments.get(item.id);
    if (before && before.status !== 'signed' && item.status === 'signed') events.push(notificationEvent(`Документ подписан: «${item.name}»`, 'project', item.id));
  }
  return events.slice(0, 8);
};

export const deepLink = (origin, projectId, page, entityId) => {
  const url = new URL('/', origin);
  url.searchParams.set('projectId', projectId);
  url.searchParams.set('page', page);
  if (entityId) url.searchParams.set('entity', entityId);
  return url.toString();
};

export const createNotificationService = ({ resolveTelegramConnection, sha256 }) => {
  const buildPlan = async (previous, next, env, actor, origin, summary, eventKey = '', recoveryEvents = []) => {
    let events = notificationEvents(previous, next);
    if (!events.length && Array.isArray(recoveryEvents) && recoveryEvents.length) events = recoveryEvents.slice(0, 8);
    const channels = next.settings?.notifications?.channels ?? {};
    const allActivity = next.settings?.notifications?.events?.projectActivity !== false;
    if (!events.length && allActivity && clean(summary, 300)) events = [notificationEvent(clean(summary, 300), 'overview')];
    if (!events.length) return { channels, message: '', deliveries: [] };
    const lines = events.map((event) => `• ${event.text}\n  ${deepLink(origin, next.project.id, event.page, event.entityId)}`);
    const message = `ИКИОМА ОС · ${next.project?.code ?? 'проект'}\nИзменил: ${actor}\n\n${lines.join('\n')}`;
    const deliveryKey = clean(eventKey, 120) || clean(next.activity?.[0]?.id, 120) || crypto.randomUUID();
    const deliveries = [];
    const telegramConnection = channels.telegram && env.TELEGRAM_BOT_TOKEN ? await resolveTelegramConnection(env, { discover: false }) : null;
    const commonChatId = clean(telegramConnection?.chat?.id, 120);
    if (channels.telegram && env.TELEGRAM_BOT_TOKEN && commonChatId) deliveries.push({
      chatId: commonChatId, text: message, options: {},
      stableId: `telegram-notification-${(await sha256(`${next.project.id}:${deliveryKey}:${commonChatId}`)).slice(0, 40)}`,
    });
    if (channels.telegram && env.TELEGRAM_BOT_TOKEN) {
      const users = new Map((next.settings?.users ?? []).map((user) => [clean(user.id, 100), user]));
      const directByChat = new Map();
      for (const event of events) {
        if (!event.recipientId) continue;
        const user = users.get(clean(event.recipientId, 100));
        let chatId = clean(user?.telegramChatId, 120);
        if (!chatId && env.DB && user?.id) {
          const binding = await env.DB.prepare(`
            SELECT private_chat_id FROM telegram_bindings
            WHERE project_id = ? AND system_user_id = ?
            ORDER BY updated_at DESC LIMIT 1
          `).bind(next.project.id, user.id).first();
          chatId = clean(binding?.private_chat_id, 120);
        }
        if (!chatId || user?.status === 'disabled') continue;
        const personalEvents = directByChat.get(chatId) ?? [];
        personalEvents.push({ ...event, role: user.role });
        directByChat.set(chatId, personalEvents);
      }
      for (const [chatId, personalEvents] of directByChat) {
        const personalText = `ИКИОМА ОС · ${next.project?.code ?? 'проект'}\nУведомление по вашим задачам\n\n${personalEvents.map((event) => `• ${event.text}\n  ${deepLink(origin, next.project.id, event.page, event.entityId)}`).join('\n')}`;
        const taskEvent = personalEvents.length === 1 && personalEvents[0].page === 'tasks' && personalEvents[0].entityId ? personalEvents[0] : null;
        deliveries.push({
          chatId, text: personalText,
          options: taskEvent ? { reply_markup: taskActionMarkup(next.project.id, taskEvent.entityId, taskEvent.role) } : {},
          stableId: `telegram-personal-${(await sha256(`${next.project.id}:${deliveryKey}:${chatId}`)).slice(0, 40)}`,
        });
      }
    }
    return { channels, message, deliveries };
  };

  const dispatch = async (previous, next, env, actor, origin, summary, eventKey = '', preparedPlan = null, recoveryEvents = []) => {
    const plan = preparedPlan ?? await buildPlan(previous, next, env, actor, origin, summary, eventKey, recoveryEvents);
    if (!plan.message) return;
    await Promise.all(plan.deliveries.map((delivery) => telegramDurableSend(env, delivery.chatId, delivery.text, delivery.options, delivery.stableId, false)));
    if (plan.channels.email && env.RESEND_API_KEY && env.EMAIL_FROM) {
      const recipients = (next.settings?.users ?? []).filter((user) => user.status === 'active' && user.role === 'management' && /^\S+@\S+\.\S+$/.test(user.email)).map((user) => user.email);
      if (recipients.length) await Promise.allSettled([fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients, subject: `ИКИОМА ОС: требуется внимание · ${next.project?.code ?? ''}`, text: plan.message }),
      })]);
    }
  };
  return { buildPlan, dispatch };
};
