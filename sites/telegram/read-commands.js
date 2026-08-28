import { dateKey } from '../lib/date.js';
import { clean } from '../lib/validation.js';
import { deepLink } from '../integrations/notifications.js';
import { taskStatusLabel } from './rendering.js';
import { telegramSend } from './transport.js';

const telegramOrigin = (env) => clean(env.APP_PUBLIC_URL, 500) || 'https://stroios-work-2026.ozolin.chatgpt.site';

export const createTelegramReadCommands = ({ readSnapshot, telegramSendPhoto }) => {
  const projectForBinding = async (env, binding) => {
    const snapshot = await readSnapshot(env.DB, binding.project_id);
    if (!snapshot) throw new Error('project_not_found');
    const user = (snapshot.state.settings?.users ?? []).find((item) => item.id === binding.system_user_id);
    if (!user || user.status === 'disabled') throw new Error('access_disabled');
    return { snapshot, user };
  };

  const tasks = async (message, binding, env) => {
    const { snapshot, user } = await projectForBinding(env, binding);
    const items = (snapshot.state.tasks ?? [])
      .filter((item) => !['done', 'canceled'].includes(item.status))
      .filter((item) => user.role === 'management' || item.assigneeId === user.id)
      .sort((a, b) => clean(a.dueDate, 20).localeCompare(clean(b.dueDate, 20)))
      .slice(0, 10);
    const title = user.role === 'management' ? 'Открытые задачи проекта' : 'Ваши открытые задачи';
    const text = items.length
      ? `${title} · ${snapshot.state.project?.code ?? ''}\n\n${items.map((item) => `• ${item.dueDate} · ${taskStatusLabel(item.status)}\n  ${item.title}${user.role === 'management' ? ` — ${item.assigneeName}` : ''}\n  ${deepLink(telegramOrigin(env), binding.project_id, 'tasks', item.id)}`).join('\n\n')}`
      : `${title}: сейчас ничего открытого.`;
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, text);
  };

  const stages = async (message, binding, env) => {
    const { snapshot } = await projectForBinding(env, binding);
    const items = (snapshot.state.stages ?? []).slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    const labels = { not_ready: 'ещё не готов', ready: 'готов к запуску', in_progress: 'в работе', blocked: 'заблокирован', awaiting_inspection: 'на проверке', accepted: 'принят', rework: 'доработка' };
    const text = items.length
      ? `Этапы · ${snapshot.state.project?.code ?? ''}\n\n${items.map((item) => `• ${item.name} — ${labels[item.status] ?? item.status}\n  срок: ${item.forecastEnd ?? item.planEnd ?? 'не указан'}`).join('\n\n')}`
      : 'Этапы проекта пока не созданы.';
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, text);
  };

  const completedTasks = async (message, binding, env) => {
    const { snapshot, user } = await projectForBinding(env, binding);
    const items = (snapshot.state.tasks ?? [])
      .filter((item) => item.status === 'done')
      .filter((item) => user.role === 'management' || item.assigneeId === user.id)
      .sort((a, b) => clean(b.updatedAt ?? b.createdAt, 40).localeCompare(clean(a.updatedAt ?? a.createdAt, 40)))
      .slice(0, 10);
    const text = items.length
      ? `Последние выполненные задачи · ${snapshot.state.project?.code ?? ''}\n\n${items.map((item) => `• ${item.title}\n  ${item.assigneeName} · ${new Date(item.updatedAt ?? item.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`).join('\n\n')}`
      : 'Выполненных задач пока нет.';
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, text);
  };

  const finance = async (message, binding, env) => {
    const { snapshot, user } = await projectForBinding(env, binding);
    if (user.role !== 'management') {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Финансовая сводка доступна только роли «Управление».');
      return;
    }
    const entries = snapshot.state.financeEntries ?? [];
    const expenses = entries.filter((item) => item.kind === 'expense');
    const incomes = entries.filter((item) => item.kind === 'income');
    const committed = expenses.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    const paid = expenses.reduce((sum, item) => sum + (Number(item.paidAmount) || 0), 0);
    const expectedIncome = incomes.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    const received = incomes.reduce((sum, item) => sum + (Number(item.paidAmount) || 0), 0);
    const money = (value) => `${Math.round(value).toLocaleString('ru-RU')} ₽`;
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
      `Финансы · ${snapshot.state.project?.code ?? ''}`,
      '',
      `Расходы: обязательства ${money(committed)} · оплачено ${money(paid)}`,
      `Доходы: ожидается ${money(expectedIncome)} · получено ${money(received)}`,
      `Денежный баланс: ${money(received - paid)}`,
      '',
      deepLink(telegramOrigin(env), binding.project_id, 'finance'),
    ].join('\n'));
  };

  const projectStatus = async (message, binding, env) => {
    const { snapshot } = await projectForBinding(env, binding);
    const state = snapshot.state;
    const today = dateKey();
    const activeStages = (state.stages ?? []).filter((item) => ['in_progress', 'blocked', 'awaiting_inspection', 'rework'].includes(item.status));
    const openTasks = (state.tasks ?? []).filter((item) => !['done', 'canceled'].includes(item.status));
    const overdue = openTasks.filter((item) => clean(item.dueDate, 20) < today);
    const riskySupply = (state.procurement ?? []).filter((item) => item.risk || ['need', 'rfq'].includes(item.status));
    const accepted = (state.financeEntries ?? []).reduce((sum, item) => sum + (Number(item.acceptedAmount) || 0), 0);
    const paid = (state.financeEntries ?? []).reduce((sum, item) => sum + (Number(item.paidAmount) || 0), 0);
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
      `Статус · ${state.project?.name ?? state.project?.code}`,
      '',
      `Работы сейчас: ${activeStages.length ? activeStages.map((item) => item.name).join(', ') : 'активных этапов нет'}`,
      `Задачи: ${openTasks.length} открыто · ${overdue.length} просрочено`,
      `Снабжение: ${riskySupply.length} требуют внимания`,
      `Принято / оплачено: ${accepted.toLocaleString('ru-RU')} ₽ / ${paid.toLocaleString('ru-RU')} ₽`,
      `Прогноз сдачи: ${state.project?.forecastDate ?? 'не указан'}`,
      '',
      deepLink(telegramOrigin(env), binding.project_id, 'overview'),
    ].join('\n'));
  };

  const camera = async (message, binding, env) => {
    const { snapshot } = await projectForBinding(env, binding);
    const caption = `Камера · ${snapshot.state.project?.name ?? snapshot.state.project?.code}\n${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`;
    if (env.CAMERA_SNAPSHOT_URL) {
      const response = await telegramSendPhoto(env.TELEGRAM_BOT_TOKEN, message.chat.id, env.CAMERA_SNAPSHOT_URL, caption);
      if (response.ok) return;
    }
    if (env.CAMERA_VIEW_URL) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, `${caption}\n\nПрямой эфир доступен по кнопке:`, {
        reply_markup: { inline_keyboard: [[{ text: 'Открыть камеру', url: deepLink(telegramOrigin(env), binding.project_id, 'client', 'camera') }]] },
      });
      return;
    }
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Камера ещё не установлена. Команда уже готова и заработает после подключения оборудования.');
  };

  return { projectForBinding, tasks, stages, completedTasks, finance, projectStatus, camera };
};
