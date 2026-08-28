import { addDays, dateKey } from '../lib/date.js';
import { clean } from '../lib/validation.js';
import { telegramSend } from './transport.js';

const parseTaskDate = (text) => {
  const source = clean(text, 2000).toLocaleLowerCase('ru');
  const now = new Date();
  if (/\bсегодня\b/.test(source)) return dateKey(now);
  if (/\bпослезавтра\b/.test(source)) return dateKey(addDays(now, 2));
  if (/\bзавтра\b/.test(source)) return dateKey(addDays(now, 1));
  const afterDays = source.match(/через\s+(\d{1,2})\s+(?:дн|день|дня|дней)/);
  if (afterDays) return dateKey(addDays(now, Math.min(90, Number(afterDays[1]))));
  const iso = source.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];
  const short = source.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}))?\b/);
  if (short) {
    const year = Number(short[3]) || now.getUTCFullYear();
    const candidate = new Date(Date.UTC(year, Number(short[2]) - 1, Number(short[1]), 12));
    if (!short[3] && candidate < addDays(now, -1)) candidate.setUTCFullYear(year + 1);
    return dateKey(candidate);
  }
  const weekdays = new Map([
    ['воскресенье', 0],
    ['понедельник', 1],
    ['вторник', 2],
    ['среду', 3],
    ['четверг', 4],
    ['пятницу', 5],
    ['субботу', 6],
  ]);
  for (const [word, weekday] of weekdays) {
    if (!source.includes(word)) continue;
    let delta = (weekday - now.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    return dateKey(addDays(now, delta));
  }
  return dateKey(addDays(now, 1));
};

const taskPriorityFromText = (text) => {
  const source = clean(text, 2000).toLocaleLowerCase('ru');
  if (/\b(авария|критично|критическая|немедленно)\b/.test(source)) return 'critical';
  if (/\b(срочно|важно|высокий приоритет)\b/.test(source)) return 'high';
  if (/\b(не срочно|низкий приоритет)\b/.test(source)) return 'low';
  return 'normal';
};

const taskAssigneeFromText = (state, text) => {
  const source = clean(text, 2400).toLocaleLowerCase('ru');
  const users = (state.settings?.users ?? []).filter((user) => user.status !== 'disabled' && user.role !== 'client');
  return users.find((user) => {
    const telegram = clean(user.telegram, 120).replace(/^@/, '').toLocaleLowerCase('en-US');
    const firstName = clean(user.name, 120).split(/\s+/)[0]?.toLocaleLowerCase('ru');
    return (telegram && source.includes(`@${telegram}`)) || (firstName && new RegExp(`(^|\\s)${firstName}(\\s|$)`, 'iu').test(source));
  }) ?? null;
};

const expenseSelectionFromDescription = (options, description) => {
  const source = clean(description, 500).toLocaleLowerCase('ru').replace(/ё/g, 'е');
  const matched = options.find((item) => {
    const name = clean(item.name, 200).toLocaleLowerCase('ru').replace(/ё/g, 'е');
    return name.length >= 4 && source.includes(name);
  });
  return matched?.id ?? (options.length === 1 ? options[0].id : '');
};

export const createTelegramWriteDrafts = ({
  createDraft,
  parseExpense,
  projectForBinding,
  renderExpenseDraft,
  renderTaskDraft,
}) => {
  const task = async (message, binding, body, env) => {
    const { snapshot, user } = await projectForBinding(env, binding);
    if (user.role !== 'management') {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Ставить задачи через Telegram может роль «Управление». Свои задачи доступны по /tasks.');
      return;
    }
    if (!clean(body, 2400)) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Напишите после команды саму задачу. Например:\n/task Илья, проверить геометрию свай завтра срочно');
      return;
    }
    const assignee = taskAssigneeFromText(snapshot.state, body)
      ?? (snapshot.state.settings?.users ?? []).find((item) => item.id === binding.system_user_id)
      ?? (snapshot.state.settings?.users ?? []).find((item) => item.role !== 'client' && item.status !== 'disabled');
    const dueDate = parseTaskDate(body);
    const dueOffset = Math.max(0, Math.round((new Date(`${dueDate}T12:00:00Z`).getTime() - new Date(`${dateKey()}T12:00:00Z`).getTime()) / 86_400_000));
    const draft = await createDraft(env.DB, String(message.from.id), String(message.chat.id), binding.project_id, 'task', {
      title: clean(body, 500),
      projectName: snapshot.state.project?.name ?? snapshot.state.project?.code ?? binding.project_id,
      assigneeId: assignee?.id ?? '',
      dueDate,
      dueOffset: [0, 1, 3, 7].includes(dueOffset) ? dueOffset : -1,
      priority: taskPriorityFromText(body),
    }, String(message.message_id ?? ''));
    const card = renderTaskDraft(draft, snapshot.state);
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, card.text, { reply_markup: card.replyMarkup });
  };

  const expense = async (message, binding, body, env) => {
    const { snapshot, user } = await projectForBinding(env, binding);
    if (user.role !== 'management') {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Добавлять расходы через Telegram может только роль «Управление».');
      return;
    }
    const parsed = parseExpense(body);
    if (!parsed) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
        'Не удалось определить сумму и основание расхода.',
        'Ничего не записано в ИКИОМА ОС.',
        '',
        'Пример: /expense 6000 пробное бурение',
      ].join('\n'));
      return;
    }
    const budgetLines = (snapshot.state.budgetLines ?? []).slice(0, 12).map((item) => ({
      id: item.id,
      name: item.name,
      stageIds: item.stageIds ?? [],
    }));
    const stages = (snapshot.state.stages ?? []).map((item) => ({ id: item.id, name: item.name }));
    const counterparties = (snapshot.state.counterparties ?? [])
      .filter((item) => item.status !== 'blocked')
      .slice(0, 12)
      .map((item) => ({ id: item.id, name: item.name }));
    const budgetLineId = expenseSelectionFromDescription(budgetLines, parsed.description);
    const selectedBudgetLine = budgetLines.find((item) => item.id === budgetLineId);
    const draft = await createDraft(env.DB, String(message.from.id), String(message.chat.id), binding.project_id, 'expense', {
      ...parsed,
      projectName: snapshot.state.project?.name ?? snapshot.state.project?.code ?? binding.project_id,
      budgetLines,
      stages,
      counterparties,
      budgetLineId,
      stageId: selectedBudgetLine?.stageIds?.length === 1 ? selectedBudgetLine.stageIds[0] : '',
      counterpartyId: expenseSelectionFromDescription(counterparties, parsed.description),
    }, String(message.message_id ?? ''));
    const card = renderExpenseDraft(draft);
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, card.text, { reply_markup: card.replyMarkup });
  };

  const note = async (message, binding, body, env) => {
    const { snapshot, user } = await projectForBinding(env, binding);
    const text = clean(body, 2400);
    if (!text) {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Напишите после команды, что нужно запомнить. Например:\n/note Панели привезут в пятницу после 14:00');
      return;
    }
    const draft = await createDraft(
      env.DB,
      String(message.from.id),
      String(message.chat.id),
      binding.project_id,
      'note',
      { note: text, telegramMessageId: String(message.message_id ?? '') },
      String(message.message_id ?? ''),
    );
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
      'Черновик записи в дневник объекта',
      '',
      text,
      '',
      `Проект: ${snapshot.state.project?.name ?? snapshot.state.project?.code}`,
      `Автор: ${user.name}`,
      '',
      'Пока вы не нажмёте «Сохранить запись», в ИКИОМА ОС ничего не изменится.',
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Сохранить запись', callback_data: `nc|${draft.id}` },
          { text: 'Отмена', callback_data: `nx|${draft.id}` },
        ]],
      },
    });
  };

  return { task, expense, note };
};
