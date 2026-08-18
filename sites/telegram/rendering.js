import { clean } from '../lib/validation.js';

export const renderTaskDraft = (draft, state) => {
  const payload = draft.payload;
  const assignee = (state.settings?.users ?? []).find((user) => user.id === payload.assigneeId);
  const priorityLabels = { low: 'низкий', normal: 'обычный', high: 'высокий', critical: 'критический' };
  const users = (state.settings?.users ?? []).filter((user) => user.status !== 'disabled' && user.role !== 'client').slice(0, 8);
  const rows = [];
  for (let index = 0; index < users.length; index += 2) {
    rows.push(users.slice(index, index + 2).map((user) => ({
      text: `${user.id === payload.assigneeId ? '✓ ' : ''}${user.name}`,
      callback_data: `ta|${draft.id}|${users.indexOf(user)}`,
    })));
  }
  rows.push([
    { text: payload.dueOffset === 0 ? '✓ Сегодня' : 'Сегодня', callback_data: `td|${draft.id}|0` },
    { text: payload.dueOffset === 1 ? '✓ Завтра' : 'Завтра', callback_data: `td|${draft.id}|1` },
    { text: payload.dueOffset === 3 ? '✓ +3 дня' : '+3 дня', callback_data: `td|${draft.id}|3` },
    { text: payload.dueOffset === 7 ? '✓ +7 дней' : '+7 дней', callback_data: `td|${draft.id}|7` },
  ]);
  rows.push([
    { text: 'Создать задачу', callback_data: `tc|${draft.id}` },
    { text: 'Отмена', callback_data: `tx|${draft.id}` },
  ]);
  return {
    text: [
      'Черновик задачи',
      '',
      `Проект: ${payload.projectName}`,
      `Что: ${payload.title}`,
      `Ответственный: ${assignee?.name ?? 'выберите ниже'}`,
      `Срок: ${payload.dueDate}`,
      `Приоритет: ${priorityLabels[payload.priority] ?? payload.priority}`,
      '',
      'ИКИОМА ОС ничего не сохранит, пока вы не нажмёте «Создать задачу».',
    ].join('\n'),
    replyMarkup: { inline_keyboard: rows },
    users,
  };
};

export const renderFileDraft = (draft) => {
  const payload = draft.payload;
  const isDocument = draft.kind === 'document';
  return {
    text: [
      isDocument ? 'Черновик документа' : 'Черновик записи в дневник объекта',
      '',
      `Проект: ${payload.projectName}`,
      `Файл: ${payload.fileName}`,
      isDocument ? `Категория: ${payload.typeLabel}` : `Комментарий: ${payload.note || 'без комментария'}`,
      '',
      'Файл будет перенесён в защищённое хранилище ИКИОМА ОС только после подтверждения.',
    ].join('\n'),
    replyMarkup: {
      inline_keyboard: [[
        { text: isDocument ? 'Сохранить документ' : 'Добавить в дневник', callback_data: `fc|${draft.id}` },
        { text: 'Отмена', callback_data: `fx|${draft.id}` },
      ]],
    },
  };
};

export const telegramHelp = (role = 'foreman') => [
  'ИКИОМА ОС · что понимает бот',
  '',
  '🟢 ТОЛЬКО ПОКАЗЫВАЕТ — в ОС ничего не меняет',
  '/status — сводка по объекту',
  '/tasks — открытые задачи',
  '/stages — этапы и сроки',
  '/done — выполненные задачи',
  role === 'management' ? '/finance — расходы, доходы и баланс' : null,
  '/camera — камера объекта',
  '/project — выбранный объект',
  '',
  '🟡 ЗАПИШЕТ ТОЛЬКО ПОСЛЕ ВАШЕГО ПОДТВЕРЖДЕНИЯ',
  role === 'management' ? '/task текст — черновик новой задачи' : null,
  role === 'management' ? '/expense сумма описание — черновик расхода' : null,
  '/note текст — черновик записи в дневник объекта',
  'Фото или голос + подпись /report — черновик фотоотчёта',
  'Документ + подпись /doc — черновик документа',
  '',
  '⚪ НЕ ЗАПИСЫВАЕТ',
  '• обычную переписку в общем чате;',
  '• сообщения непривязанных участников;',
  '• текст, который бот не смог понять.',
  '',
  'В общем чате обращайтесь к @ikioma_bot, отвечайте на сообщение бота или используйте команду. В личном чате можно писать без упоминания.',
  'Если свободная фраза с @ikioma_bot не получает ответа, в Telegram включён Privacy Mode: используйте /expense@ikioma_bot, /note@ikioma_bot, /task@ikioma_bot или отключите Privacy Mode через @BotFather.',
  'Если команда написана с ошибкой или смысл неясен, бот ответит «ничего не записано» и предложит подсказку. Молчание никогда не означает сохранение.',
  '',
  '/help — показать эту памятку',
].filter(Boolean).join('\n');

export const taskStatusLabel = (status) => ({
  todo: 'к выполнению',
  in_progress: 'в работе',
  waiting: 'ожидает',
  review: 'на проверке',
  done: 'выполнено',
  canceled: 'отменено',
}[status] ?? status);

export const telegramTaskActionKey = (projectId, taskId) => {
  let hash = 0xcbf29ce484222325n;
  for (const character of `${clean(projectId, 100)}\u0000${clean(taskId, 160)}`) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

export const taskActionMarkup = (projectId, taskId, role) => {
  const actionKey = telegramTaskActionKey(projectId, taskId);
  return {
    inline_keyboard: role === 'management'
      ? [[
        { text: 'В работу', callback_data: `ts|${actionKey}|ip` },
        { text: 'Выполнено', callback_data: `ts|${actionKey}|done` },
        { text: 'Есть проблема', callback_data: `ts|${actionKey}|wait` },
      ]]
      : [[
        { text: 'Принял', callback_data: `ts|${actionKey}|ip` },
        { text: 'На проверку', callback_data: `ts|${actionKey}|review` },
        { text: 'Есть проблема', callback_data: `ts|${actionKey}|wait` },
      ]],
  };
};

export const renderExpenseDraft = (draft) => {
  const payload = draft.payload;
  const budgetLine = payload.budgetLines?.find((item) => item.id === payload.budgetLineId);
  const stage = payload.stages?.find((item) => item.id === payload.stageId);
  const counterparty = payload.counterparties?.find((item) => item.id === payload.counterpartyId);
  const rows = [];
  for (let index = 0; index < (payload.budgetLines ?? []).length; index += 1) {
    const item = payload.budgetLines[index];
    rows.push([{ text: `${item.id === payload.budgetLineId ? '✓ ' : ''}Статья: ${item.name}`, callback_data: `eb|${draft.id}|${index}` }]);
  }
  for (let index = 0; index < (payload.counterparties ?? []).length; index += 2) {
    rows.push(payload.counterparties.slice(index, index + 2).map((item) => ({
      text: `${item.id === payload.counterpartyId ? '✓ ' : ''}${item.name}`,
      callback_data: `ec|${draft.id}|${payload.counterparties.indexOf(item)}`,
    })));
  }
  const allowedStages = (payload.stages ?? []).filter((item) => budgetLine?.stageIds?.includes(item.id));
  if (allowedStages.length > 1) {
    for (let index = 0; index < allowedStages.length; index += 2) {
      rows.push(allowedStages.slice(index, index + 2).map((item) => ({
        text: `${item.id === payload.stageId ? '✓ ' : ''}Этап: ${item.name}`,
        callback_data: `es|${draft.id}|${payload.stages.indexOf(item)}`,
      })));
    }
  }
  rows.push([
    { text: 'Сохранить расход', callback_data: `xc|${draft.id}` },
    { text: 'Отмена', callback_data: `xx|${draft.id}` },
  ]);
  return {
    text: [
      'Черновик расхода',
      '',
      `Проект: ${payload.projectName}`,
      `Сумма: ${Number(payload.amount).toLocaleString('ru-RU')} ₽`,
      `Основание: ${payload.description}`,
      `Статья: ${budgetLine?.name ?? 'выберите ниже'}`,
      `Этап: ${stage?.name ?? (budgetLine ? 'выберите ниже' : 'сначала выберите статью')}`,
      `Контрагент: ${counterparty?.name ?? (payload.counterparties?.length ? 'выберите ниже' : 'сначала добавьте в ИКИОМА ОС')}`,
      '',
      'Это обязательство. Оплата и приёмка не фиксируются автоматически.',
      'В ИКИОМА ОС ничего не изменится, пока вы не нажмёте «Сохранить расход».',
    ].join('\n'),
    replyMarkup: { inline_keyboard: rows },
  };
};
