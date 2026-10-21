import { clean } from '../lib/validation.js';
import { addDays, dateKey } from '../lib/date.js';
import { telegramSend } from './transport.js';
import { telegramDurableSend } from './outbox.js';
import { commandFromText, naturalTelegramCommand, telegramCommandSuggestion, telegramCommandTargetsBot, TELEGRAM_COMMAND_NAMES } from './commands.js';
import { renderExpenseDraft, renderTaskDraft, telegramHelp, telegramTaskActionKey } from './rendering.js';
import { assertTelegramDraftLease, claimTelegramDraft, readClaimedTelegramDraft, readTelegramDraft, releaseTelegramDraft, saveClaimedTelegramDraftPayload, updateTelegramDraft } from './drafts.js';
import { saveTelegramProjectSelection } from './bindings.js';
import { telegramAnswerCallback, telegramConfirmVisible, telegramEditMessage } from './visibility.js';

export const telegramMessageMentionsBot = (message, botUsername) => {
  const expected = `@${clean(botUsername, 120).replace(/^@/u, '').toLocaleLowerCase('en-US')}`;
  if (expected === '@') return false;
  const text = clean(message?.text, 3000);
  if (new RegExp(`${expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'iu').test(text)) return true;
  return (message?.entities ?? []).some((entity) => {
    if (entity?.type !== 'mention') return false;
    return text.slice(Number(entity.offset) || 0, (Number(entity.offset) || 0) + (Number(entity.length) || 0)).toLocaleLowerCase('en-US') === expected;
  });
};

export const createTelegramUpdateProcessor = ({ readSnapshot, bindingsForTelegramUser, bindingForTelegramUser, bindingForTelegramProject, telegramBotUsername, telegramGroupChatAuthorized, bindTelegramUser, createTelegramDraft, telegramReadCommands, telegramWriteDrafts, telegramAttachmentDrafts, telegramConfirmTask, telegramConfirmNote, telegramConfirmExpense, telegramConfirmFile, telegramChangeTaskStatus }) => {
  const runClaimedTelegramDraft = async (callback, draft, env, action) => {
    const lease = await claimTelegramDraft(env.DB, draft);
    if (!lease) {
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Черновик уже обрабатывается или закрыт.', true);
      return false;
    }
    let claimedDraft = null;
    try {
      claimedDraft = await readClaimedTelegramDraft(env.DB, draft, lease);
      await action(claimedDraft);
      return true;
    } catch (error) {
      await releaseTelegramDraft(env.DB, claimedDraft ?? { ...draft, updated_at: lease });
      throw error;
    }
  };

  const telegramProjectsForBindings = async (env, bindings) => {
    const projects = [];
    for (const item of bindings.slice(0, 12)) {
      const snapshot = await readSnapshot(env.DB, item.project_id);
      if (snapshot) projects.push({ id: item.project_id, name: snapshot.state.project?.name ?? snapshot.state.project?.code ?? item.project_id });
    }
    return projects;
  };

  const telegramSelectProject = async (message, binding, env, options = {}) => {
    const bindings = options.bindings ?? await bindingsForTelegramUser(env.DB, String(message.from.id));
    if (!bindings.length) return;
    const projects = await telegramProjectsForBindings(env, bindings);
    if (projects.length === 1 && !options.pending) {
      await saveTelegramProjectSelection(env.DB, String(message.from.id), String(message.chat.id), projects[0].id);
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, `Текущий объект: ${projects[0].name}`);
      return;
    }
    const current = projects.find((item) => item.id === binding?.project_id);
    const draft = await createTelegramDraft(
      env.DB,
      String(message.from.id),
      String(message.chat.id),
      binding?.project_id ?? projects[0]?.id,
      'project',
      { projects, pending: options.pending ?? null },
      String(message.message_id ?? ''),
    );
    const prompt = options.prompt
      || [current ? `Сейчас выбран: ${current.name}` : '', 'Выберите объект для этого чата:'].filter(Boolean).join('\n\n');
    await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, prompt, {
      reply_markup: {
        inline_keyboard: projects.map((item, index) => [{
          text: `${item.id === current?.id ? '✓ ' : ''}${item.name}`,
          callback_data: `ps|${draft.id}|${index}`,
        }]),
      },
    });
  };

  const TELEGRAM_WRITE_COMMANDS = new Set(['task', 'note', 'expense']);

  const telegramHandleCommand = async (message, binding, command, env, options = {}) => {
    const bindings = options.bindings ?? await bindingsForTelegramUser(env.DB, String(message.from.id));
    if (command.name === 'start') {
      const role = binding?.role ?? bindings[0]?.role ?? 'foreman';
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
        bindings.length ? `Telegram подключён. Доступно проектов: ${bindings.length}.` : 'Telegram пока не связан с пользователем ИКИОМА ОС.',
        '',
        telegramHelp(role),
      ].join('\n'));
      if (bindings.length > 1) await telegramSelectProject(message, binding, env, { bindings });
      return;
    }
    if (command.name === 'help') {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, telegramHelp(binding?.role ?? bindings[0]?.role ?? 'foreman'));
      return;
    }
    if (command.name === 'project') return telegramSelectProject(message, binding, env, { bindings });
    if (!TELEGRAM_COMMAND_NAMES.includes(command.name)) {
      const suggestion = telegramCommandSuggestion(command.name);
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
        `Команда /${command.name} не распознана.`,
        suggestion ? `Возможно, вы имели в виду /${suggestion}.` : null,
        'Ничего не записано в ИКИОМА ОС.',
        '',
        'Отправьте /help, чтобы увидеть все команды.',
      ].filter(Boolean).join('\n'));
      return;
    }
    if (bindings.length > 1 && TELEGRAM_WRITE_COMMANDS.has(command.name) && !options.projectConfirmed) {
      await telegramSelectProject(message, binding, env, {
        bindings,
        pending: { type: 'command', command, sourceMessageId: String(message.message_id ?? '') },
        prompt: 'К какому проекту относится это действие?',
      });
      return;
    }
    if (!binding) {
      await telegramSelectProject(message, binding, env, {
        bindings,
        pending: { type: 'command', command, sourceMessageId: String(message.message_id ?? '') },
        prompt: `Выберите проект для команды /${command.name}:`,
      });
      return;
    }
    if (command.name === 'task') return telegramWriteDrafts.task(message, binding, command.body, env);
    if (command.name === 'tasks') return telegramReadCommands.tasks(message, binding, env);
    if (command.name === 'stages') return telegramReadCommands.stages(message, binding, env);
    if (command.name === 'done') return telegramReadCommands.completedTasks(message, binding, env);
    if (command.name === 'finance') return telegramReadCommands.finance(message, binding, env);
    if (command.name === 'expense') return telegramWriteDrafts.expense(message, binding, command.body, env);
    if (command.name === 'status') return telegramReadCommands.projectStatus(message, binding, env);
    if (command.name === 'note') return telegramWriteDrafts.note(message, binding, command.body, env);
    if (command.name === 'camera') return telegramReadCommands.camera(message, binding, env);
    if (command.name === 'doc') {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Пришлите файл в личный чат с ботом. В общем чате приложите к документу подпись /doc. Бот покажет категорию и попросит подтверждение.');
      return;
    }
    if (command.name === 'report') {
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Пришлите фото или голосовое сообщение в личный чат. В общем чате добавьте подпись /report и комментарий. Запись попадёт в дневник объекта только после подтверждения.');
      return;
    }
  };

  const telegramHandleMessage = async (message, env) => {
    if (!message?.chat?.id || !message?.from?.id || message.from.is_bot) return;
    const command = commandFromText(message.text);
    const isPrivate = message.chat.type === 'private';
    const botUsername = isPrivate ? '' : await telegramBotUsername(env);
    if (!isPrivate && !telegramCommandTargetsBot(command, botUsername)) return;
    if (!isPrivate && !await telegramGroupChatAuthorized(env, message.chat.id)) {
      const addressed = Boolean(command) || telegramMessageMentionsBot(message, botUsername);
      if (addressed) {
        await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, 'Этот чат не подключён к ИКИОМА ОС. Попросите руководителя выбрать и подтвердить общий Telegram-чат в настройках ОС.');
      }
      return;
    }
    if (command?.name === 'start' && command.body) {
      await bindTelegramUser(message, command.body, env);
      return;
    }

    const rawText = clean(message.text, 3000);
    let mentioned = false;
    if (!command && !isPrivate) {
      mentioned = telegramMessageMentionsBot(message, botUsername);
    }
    const replyAuthor = message.reply_to_message?.from;
    const repliedToBot = Boolean(
      replyAuthor?.is_bot
      && clean(replyAuthor.username, 120).replace(/^@/u, '').toLocaleLowerCase('en-US') === botUsername.toLocaleLowerCase('en-US'),
    );
    const addressedToBot = isPrivate || Boolean(command) || mentioned || repliedToBot;
    const bindings = await bindingsForTelegramUser(env.DB, String(message.from.id));
    const binding = await bindingForTelegramUser(env.DB, String(message.from.id), String(message.chat.id));

    if (!bindings.length) {
      if (command?.name === 'help' || command?.name === 'start') {
        await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, telegramHelp('management'));
      }
      if (addressedToBot && command?.name !== 'help') {
        await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
          'Сообщение не записано в ИКИОМА ОС.',
          'Ваш Telegram ещё не связан с пользователем системы.',
          '',
          'Руководитель может выпустить персональную ссылку: ИКИОМА ОС → Настройки → Доступы.',
          'Справка по доступным действиям: /help',
        ].join('\n'));
      }
      return;
    }

    if (message.document || message.photo || message.voice) {
      const captionCommand = commandFromText(message.caption);
      const acceptedAttachment = isPrivate || (
        telegramCommandTargetsBot(captionCommand, botUsername)
        && ['doc', 'report'].includes(captionCommand?.name)
      );
      if (!acceptedAttachment) return;
      if (bindings.length > 1) {
        await telegramSelectProject(message, binding, env, {
          bindings,
          pending: { type: 'attachment', message: telegramAttachmentDrafts.payload(message) },
          prompt: 'К какому проекту относится этот файл или отчёт?',
        });
        return;
      }
      await telegramAttachmentDrafts.prepare(message, binding, env);
      return;
    }
    if (command) {
      await telegramHandleCommand(message, binding, command, env, { bindings });
      return;
    }
    if (addressedToBot) {
      const addressedText = rawText
        .replace(botUsername ? new RegExp(`@${botUsername}\\b`, 'giu') : /$^/, '')
        .trim();
      const naturalCommand = naturalTelegramCommand(addressedText);
      if (naturalCommand) {
        await telegramHandleCommand(message, binding, naturalCommand, env, { bindings });
        return;
      }
      await telegramSend(env.TELEGRAM_BOT_TOKEN, message.chat.id, [
        'Я не понял, что нужно сделать.',
        'Ничего не записано в ИКИОМА ОС.',
        '',
        'Переформулируйте сообщение или отправьте /help.',
      ].join('\n'));
    }
  };

  const telegramHandleCallback = async (callback, env) => {
    if (!callback?.id || !callback?.from?.id || !callback?.message?.chat?.id) return;
    const parts = clean(callback.data, 200).split('|');
    const action = parts[0];
    const telegramUserId = String(callback.from.id);
    const chatId = String(callback.message.chat.id);
    if (callback.message.chat.type !== 'private' && !await telegramGroupChatAuthorized(env, chatId)) {
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Этот чат не подключён к ИКИОМА ОС.', true);
      return;
    }
    const bindings = await bindingsForTelegramUser(env.DB, telegramUserId);
    if (!bindings.length) {
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сначала подключите личный Telegram в ИКИОМА ОС.', true);
      return;
    }
    if (action === 'ts') {
      const taskMatches = [];
      for (const item of bindings) {
        const snapshot = await readSnapshot(env.DB, item.project_id);
        for (const task of snapshot?.state?.tasks ?? []) {
          if (telegramTaskActionKey(item.project_id, task.id) === parts[1]) {
            taskMatches.push({ binding: item, taskId: task.id });
          }
        }
      }
      if (taskMatches.length !== 1) throw new Error('action_denied');
      await telegramChangeTaskStatus(callback, taskMatches[0].binding, taskMatches[0].taskId, parts[2], env);
      return;
    }
    const draft = await readTelegramDraft(env.DB, parts[1], telegramUserId);
    if (!draft) {
      await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Черновик уже закрыт или устарел.', true);
      return;
    }
    if (String(draft.chat_id) !== chatId) throw new Error('action_denied');
    if (action === 'ps') {
      const requestedProject = draft.payload.projects?.[Number(parts[2])];
      if (!requestedProject) throw new Error('project_not_found');
      await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
        await assertTelegramDraftLease(env.DB, claimedDraft);
        const lockedProject = claimedDraft.payload.selectedProjectId
          ? claimedDraft.payload.projects?.find((item) => item.id === claimedDraft.payload.selectedProjectId)
          : null;
        const project = lockedProject ?? requestedProject;
        const selectedBinding = bindings.find((item) => item.project_id === project.id);
        if (!selectedBinding) throw new Error('action_denied');
        if (!claimedDraft.payload.selectedProjectId) {
          claimedDraft.payload = {
            ...claimedDraft.payload,
            selectedProjectId: project.id,
            selectedProjectName: project.name,
          };
          Object.assign(claimedDraft, await saveClaimedTelegramDraftPayload(env.DB, claimedDraft, claimedDraft.payload));
        }
        await saveTelegramProjectSelection(env.DB, telegramUserId, chatId, project.id);
        const pending = claimedDraft.payload.pending;
        if (pending?.type === 'command') {
          await telegramHandleCommand({
            chat: callback.message.chat,
            from: callback.from,
            message_id: pending.sourceMessageId || callback.message.message_id,
          }, selectedBinding, pending.command, env, { bindings, projectConfirmed: true });
        } else if (pending?.type === 'attachment' && pending.message) {
          await telegramAttachmentDrafts.prepare({ ...pending.message, chat: callback.message.chat, from: callback.from }, selectedBinding, env);
        }
        // Selection remains resumable until the child draft/card is created.
        // If Telegram or storage fails above, runClaimed releases it for retry.
        await updateTelegramDraft(env.DB, claimedDraft, claimedDraft.payload, 'confirmed');
        await telegramConfirmVisible(env, callback.message.chat.id, callback.message.message_id, `Проект выбран: ${project.name}`);
        await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
      });
      return;
    }
    const binding = await bindingForTelegramProject(env.DB, telegramUserId, draft.project_id);
    if (!binding) throw new Error('action_denied');
    if (action === 'tx' || action === 'fx' || action === 'nx' || action === 'xx') {
      await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
        await updateTelegramDraft(env.DB, claimedDraft, claimedDraft.payload, 'canceled');
        await telegramConfirmVisible(env, callback.message.chat.id, callback.message.message_id, 'Черновик отменён.');
        await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
      });
      return;
    }
    if (action === 'tc') {
      await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
        await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Создаю задачу…');
        await telegramConfirmTask(callback, claimedDraft, binding, env);
      });
      return;
    }
    if (action === 'fc') {
      await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
        await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сохраняю файл…');
        await telegramConfirmFile(callback, claimedDraft, binding, env);
      });
      return;
    }
    if (action === 'nc') {
      await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
        await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сохраняю запись…');
        await telegramConfirmNote(callback, claimedDraft, binding, env);
      });
      return;
    }
    if (action === 'xc') {
      await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
        if (!claimedDraft.payload.budgetLineId || !claimedDraft.payload.stageId || !claimedDraft.payload.counterpartyId) {
          throw new Error('expense_details_missing');
        }
        await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, 'Сохраняю расход…');
        await telegramConfirmExpense(callback, claimedDraft, binding, env);
      });
      return;
    }
    if (action === 'eb' || action === 'ec' || action === 'es') {
      await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
        const options = action === 'eb'
          ? claimedDraft.payload.budgetLines
          : action === 'ec'
            ? claimedDraft.payload.counterparties
            : claimedDraft.payload.stages;
        const selected = options?.[Number(parts[2])];
        if (!selected) throw new Error('expense_details_missing');
        if (action === 'eb') {
          claimedDraft.payload.budgetLineId = selected.id;
          claimedDraft.payload.stageId = selected.stageIds?.length === 1 ? selected.stageIds[0] : '';
        } else if (action === 'ec') {
          claimedDraft.payload.counterpartyId = selected.id;
        } else {
          const budgetLine = claimedDraft.payload.budgetLines?.find((item) => item.id === claimedDraft.payload.budgetLineId);
          if (!budgetLine?.stageIds?.includes(selected.id)) throw new Error('action_denied');
          claimedDraft.payload.stageId = selected.id;
        }
        const editingDraft = await saveClaimedTelegramDraftPayload(env.DB, claimedDraft, claimedDraft.payload);
        try {
          const card = renderExpenseDraft(editingDraft);
          await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, callback.message.chat.id, callback.message.message_id, card.text, card.replyMarkup);
          await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
        } finally {
          await releaseTelegramDraft(env.DB, editingDraft);
        }
      });
      return;
    }
    if (action === 'ta' || action === 'td') {
      await runClaimedTelegramDraft(callback, draft, env, async (claimedDraft) => {
        const snapshot = await readSnapshot(env.DB, claimedDraft.project_id);
        if (!snapshot) throw new Error('project_not_found');
        if (action === 'ta') {
          const users = (snapshot.state.settings?.users ?? []).filter((user) => user.status !== 'disabled' && user.role !== 'client').slice(0, 8);
          const assignee = users[Number(parts[2])];
          if (assignee) claimedDraft.payload.assigneeId = assignee.id;
        } else {
          const offset = Number(parts[2]);
          if (![0, 1, 3, 7].includes(offset)) throw new Error('invalid_due_date');
          claimedDraft.payload.dueOffset = offset;
          claimedDraft.payload.dueDate = dateKey(addDays(new Date(), offset));
        }
        const editingDraft = await saveClaimedTelegramDraftPayload(env.DB, claimedDraft, claimedDraft.payload);
        try {
          const card = renderTaskDraft(editingDraft, snapshot.state);
          await telegramEditMessage(env.TELEGRAM_BOT_TOKEN, callback.message.chat.id, callback.message.message_id, card.text, card.replyMarkup);
          await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id);
        } finally {
          await releaseTelegramDraft(env.DB, editingDraft);
        }
      });
      return;
    }
  };

  const processTelegramUpdate = async (update, env) => {
    try {
      if (update.callback_query) return await telegramHandleCallback(update.callback_query, env);
      if (update.message) return await telegramHandleMessage(update.message, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'processing_failed';
      const handledErrors = new Set([
        'access_disabled',
        'action_denied',
        'assignee_missing',
        'draft_state_conflict',
        'expense_details_missing',
        'invalid_due_date',
        'invalid_note',
        'payload_too_large',
        'project_not_found',
        'storage_unavailable',
        'telegram_file_too_large',
        'telegram_file_unavailable',
      ]);
      const terminalTelegramError = /^telegram_[^:]+_failed:(?:400|401|403|404):/u.test(message);
      if (!handledErrors.has(message) && !terminalTelegramError) throw error;
      const userText = message === 'telegram_file_too_large'
        ? 'Файл больше 20 МБ и не может быть сохранён.'
        : message === 'storage_unavailable'
          ? 'Хранилище проекта временно недоступно.'
          : message === 'expense_details_missing'
            ? 'Для расхода нужно выбрать статью бюджета, этап и контрагента.'
            : message === 'assignee_missing'
              ? 'Выбранный ответственный больше недоступен. Выберите другого участника.'
              : message === 'draft_state_conflict'
                ? 'Черновик уже обрабатывается или был изменён. Откройте актуальную карточку.'
                : message === 'project_not_found' || message === 'access_disabled'
                  ? 'Проект или доступ к нему больше недоступен.'
                  : message === 'payload_too_large'
                    ? 'Данные слишком велики для сохранения.'
                    : message === 'telegram_file_unavailable'
                      ? 'Telegram не смог передать файл. Ничего не сохранено — отправьте файл ещё раз.'
                      : terminalTelegramError
                        ? 'Telegram отклонил ответ бота. Ничего нового не записано; повторите команду или откройте /help.'
          : message === 'action_denied'
            ? 'Для этого действия недостаточно прав.'
            : 'Не удалось выполнить действие. Повторите через минуту.';
      if (update.callback_query?.id) {
        await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, update.callback_query.id, userText, true);
        if (update.callback_query.message?.chat?.id) {
          await telegramDurableSend(
            env,
            update.callback_query.message.chat.id,
            userText,
            {},
            `telegram-error:${clean(update.update_id ?? update.callback_query.id, 100)}:${update.callback_query.message.chat.id}`,
          );
        }
      } else if (update.message?.chat?.id) {
        await telegramDurableSend(
          env,
          update.message.chat.id,
          userText,
          {},
          `telegram-error:${clean(update.update_id ?? update.message.message_id, 100)}:${update.message.chat.id}`,
        );
      }
      return { handled: true, error: message };
    }
  };

  return { processTelegramUpdate };
};
