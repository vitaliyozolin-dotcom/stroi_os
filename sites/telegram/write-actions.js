import { createTelegramTask, changeTelegramTaskStatus, registerTelegramDocument, registerTelegramReport } from './business-commands.js';
import { createProjectCommitment } from '../../src/infrastructure/finance-commitment.js';
import { dateKey } from '../lib/date.js';
import { clean } from '../lib/validation.js';
import { deepLink, notificationEvent } from '../integrations/notifications.js';
import { assertTelegramDraftLease } from './drafts.js';
import { taskActionMarkup, taskStatusLabel } from './rendering.js';

// Persistence owns CAS retries; transports own durable delivery. Recheck actors
// and referenced records inside every mutation, including a retried mutation.
export const createTelegramWriteActions = ({
  projectForBinding, mutateProjectFromTelegram, TELEGRAM_MUTATION_NOOP,
  dispatchNotifications, telegramOrigin, telegramConfirmVisible,
  requireTelegramVisibility, updateTelegramDraft, resolveTelegramDraftFile,
  telegramFileToR2, telegramDurableVisibility, telegramAnswerCallback,
}) => {
  const telegramConfirmTask = async (callback, draft, binding, env) => {
    const access = await projectForBinding(env, binding);
    const { snapshot } = access;
    let { user } = access;
    if (user.role !== 'management' || draft.kind !== 'task') throw new Error('action_denied');
    let assignee = (snapshot.state.settings?.users ?? []).find((item) => item.id === draft.payload.assigneeId && item.status !== 'disabled' && item.role !== 'client');
    if (!assignee) throw new Error('assignee_missing');
    const now = new Date().toISOString();
    const taskId = `task-telegram-${draft.id}`;
    const task = { id: taskId, title: clean(draft.payload.title, 500) };
    await assertTelegramDraftLease(env.DB, draft);
    const mutation = await mutateProjectFromTelegram(
      env,
      draft.project_id,
      user.name,
      user.role,
      'telegram.task.create',
      `Создана задача «${task.title}» · ответственный ${assignee.name}`,
      (state) => {
        if ((state.tasks ?? []).some((item) => item.id === taskId || item.sourceDraftId === draft.id)) {
          return TELEGRAM_MUTATION_NOOP;
        }
        const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
        if (!currentUser || currentUser.role !== 'management') throw new Error('action_denied');
        const currentAssignee = (state.settings?.users ?? []).find((item) => item.id === draft.payload.assigneeId && item.status !== 'disabled' && item.role !== 'client');
        if (!currentAssignee) throw new Error('assignee_missing');
        user = currentUser;
        assignee = currentAssignee;
        return createTelegramTask(state, currentUser, { ...draft, payload: { ...draft.payload, title: task.title } }, now) ? undefined : TELEGRAM_MUTATION_NOOP;
      },
    );
    const confirmedTask = (mutation.state.tasks ?? []).find((item) => item.id === taskId || item.sourceDraftId === draft.id) ?? task;
    const recoveryEvents = mutation.state.settings?.notifications?.events?.taskAssigned
      ? [notificationEvent(`Задача: «${confirmedTask.title}» → ${confirmedTask.assigneeName}, срок ${confirmedTask.dueDate}`, 'tasks', confirmedTask.id, confirmedTask.assigneeId)]
      : [];
    await dispatchNotifications(
      mutation.previous,
      mutation.state,
      env,
      user.name,
      telegramOrigin(env),
      `Создана задача «${confirmedTask.title}»`,
      `telegram-draft:${draft.id}`,
      null,
      recoveryEvents,
    );
    const visibility = await telegramConfirmVisible(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      `Задача создана\n\n${confirmedTask.title}\nОтветственный: ${confirmedTask.assigneeName}\nСрок: ${confirmedTask.dueDate}\n\n${deepLink(telegramOrigin(env), draft.project_id, 'tasks', confirmedTask.id)}`,
    );
    requireTelegramVisibility(visibility);
    await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
  };

  const telegramConfirmNote = async (callback, draft, binding, env) => {
    const access = await projectForBinding(env, binding);
    let { user } = access;
    if (draft.kind !== 'note') throw new Error('action_denied');
    const note = clean(draft.payload.note, 2400);
    if (!note) throw new Error('invalid_note');
    const now = new Date().toISOString();
    const reportId = `field-report-telegram-${draft.id}`;
    await assertTelegramDraftLease(env.DB, draft);
    const mutation = await mutateProjectFromTelegram(
      env,
      draft.project_id,
      user.name,
      user.role,
      'telegram.note.create',
      `Добавлена запись в дневник объекта · ${user.name}`,
      (state) => {
        if ((state.fieldReports ?? []).some((item) => item.id === reportId || item.sourceDraftId === draft.id)) {
          return TELEGRAM_MUTATION_NOOP;
        }
        const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
        if (!currentUser) throw new Error('action_denied');
        user = currentUser;
        return registerTelegramReport(state, currentUser, {
          id: reportId, createdAt: now, note, source: 'telegram', attachments: [],
          telegramMessageId: draft.payload.telegramMessageId, sourceDraftId: draft.id,
        }, now) ? undefined : TELEGRAM_MUTATION_NOOP;
      },
    );
    await dispatchNotifications(
      mutation.previous,
      mutation.state,
      env,
      user.name,
      telegramOrigin(env),
      'Добавлена запись в дневник объекта',
      `telegram-draft:${draft.id}`,
    );
    const visibility = await telegramConfirmVisible(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      `Запись сохранена в дневнике объекта\n\n${note}\n\n${deepLink(telegramOrigin(env), draft.project_id, 'project')}`,
    );
    requireTelegramVisibility(visibility);
    await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
  };

  const telegramConfirmExpense = async (callback, draft, binding, env) => {
    const access = await projectForBinding(env, binding);
    const { snapshot } = access;
    let { user } = access;
    if (user.role !== 'management' || draft.kind !== 'expense') throw new Error('action_denied');
    const amount = Number(draft.payload.amount);
    let budgetLine = (snapshot.state.budgetLines ?? []).find((item) => item.id === draft.payload.budgetLineId);
    let counterparty = (snapshot.state.counterparties ?? []).find((item) => item.id === draft.payload.counterpartyId && item.status !== 'blocked');
    const stageId = clean(draft.payload.stageId, 100);
    let stage = (snapshot.state.stages ?? []).find((item) => item.id === stageId);
    if (!Number.isFinite(amount) || amount <= 0 || !budgetLine || !counterparty || !stage || !budgetLine.stageIds?.includes(stageId)) throw new Error('expense_details_missing');
    const now = new Date().toISOString();
    const entryId = `finance-telegram-${draft.id}`;
    const entry = {
      id: entryId,
      kind: 'expense',
      status: 'committed',
      amount,
      date: dateKey(),
      stageId,
      budgetLineId: budgetLine.id,
      counterparty: counterparty.name,
      counterpartyId: counterparty.id,
      description: clean(draft.payload.description, 500),
      sourceDraftId: draft.id,
    };
    await assertTelegramDraftLease(env.DB, draft);
    const mutation = await mutateProjectFromTelegram(
      env,
      draft.project_id,
      user.name,
      user.role,
      'telegram.expense.create',
      `Добавлен расход ${Math.round(amount).toLocaleString('ru-RU')} ₽ · ${entry.description}`,
      (state) => {
        if ((state.financeEntries ?? []).some((item) => item.id === entryId || item.sourceDraftId === draft.id)) {
          return TELEGRAM_MUTATION_NOOP;
        }
        const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
        if (!currentUser || currentUser.role !== 'management') throw new Error('action_denied');
        const currentBudgetLine = (state.budgetLines ?? []).find((item) => item.id === draft.payload.budgetLineId);
        const currentCounterparty = (state.counterparties ?? []).find((item) => item.id === draft.payload.counterpartyId && item.status !== 'blocked');
        const currentStage = (state.stages ?? []).find((item) => item.id === stageId);
        if (!currentBudgetLine || !currentCounterparty || !currentStage || !currentBudgetLine.stageIds?.includes(stageId)) throw new Error('expense_details_missing');
        budgetLine = currentBudgetLine;
        counterparty = currentCounterparty;
        stage = currentStage;
        user = currentUser;
        entry.budgetLineId = currentBudgetLine.id;
        entry.counterparty = currentCounterparty.name;
        entry.counterpartyId = currentCounterparty.id;
        const result = createProjectCommitment(state, { ...entry, sourceDraftId: draft.id }, {
          identity: { name: currentUser.name, role: currentUser.role },
          clock: { now: () => now },
          ids: { next: (prefix) => `${prefix}-${crypto.randomUUID()}` },
        });
        if (!result.ok) throw new Error(`expense_details_missing: ${result.error}`);
        return result.change?.state ?? TELEGRAM_MUTATION_NOOP;
      },
    );
    await dispatchNotifications(
      mutation.previous,
      mutation.state,
      env,
      user.name,
      telegramOrigin(env),
      `Добавлен расход «${entry.description}»`,
      `telegram-draft:${draft.id}`,
    );
    const visibility = await telegramConfirmVisible(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      [
        'Расход сохранён как обязательство',
        '',
        `${amount.toLocaleString('ru-RU')} ₽ · ${entry.description}`,
        `Статья: ${budgetLine.name}`,
        `Этап: ${stage.name}`,
        `Контрагент: ${counterparty.name}`,
        '',
        'Оплата и приёмка не зафиксированы.',
        deepLink(telegramOrigin(env), draft.project_id, 'finance', entryId),
      ].join('\n'),
    );
    requireTelegramVisibility(visibility);
    await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
  };

  const telegramConfirmFile = async (callback, draft, binding, env) => {
    const access = await projectForBinding(env, binding);
    const { snapshot } = access;
    let { user } = access;
    await assertTelegramDraftLease(env.DB, draft);
    const resolvedFile = await resolveTelegramDraftFile(snapshot.state, draft, () => {
      if (!env.BUCKET) throw new Error('storage_unavailable');
      return telegramFileToR2(
        env,
        draft.project_id,
        draft.payload.telegramFileId,
        draft.payload.fileName,
        draft.payload.mimeType,
        user.name,
        draft.id,
      );
    });
    const { attachment } = resolvedFile;
    const now = new Date().toISOString();
    const isDocument = draft.kind === 'document';
    const summary = isDocument ? `Загружен документ «${attachment.name}» через Telegram` : `Добавлен фотоотчёт через Telegram · ${user.name}`;
    const mutation = resolvedFile.existing ? null : await mutateProjectFromTelegram(
      env,
      draft.project_id,
      user.name,
      user.role,
      isDocument ? 'telegram.document.create' : 'telegram.field_report.create',
      summary,
      (state) => {
        const existing = isDocument
          ? (state.documents ?? []).some((item) => item.sourceDraftId === draft.id)
          : (state.fieldReports ?? []).some((item) => item.sourceDraftId === draft.id);
        if (existing) {
          return TELEGRAM_MUTATION_NOOP;
        }
        const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
        if (!currentUser) throw new Error('action_denied');
        user = currentUser;
        const change = isDocument
          ? registerTelegramDocument(state, currentUser, draft, attachment, now)
          : registerTelegramReport(state, currentUser, {
            id: `field-report-telegram-${draft.id}`, createdAt: now, source: 'telegram',
            note: clean(draft.payload.note, 1000) || (attachment.mimeType.startsWith('audio/') ? 'Голосовой отчёт без расшифровки' : 'Фотоотчёт без комментария'),
            attachments: [attachment], telegramMessageId: draft.payload.telegramMessageId, sourceDraftId: draft.id,
          }, now);
        return change ? undefined : TELEGRAM_MUTATION_NOOP;
      },
    );
    const notificationMutation = mutation ?? {
      previous: snapshot.state,
      state: snapshot.state,
      revision: snapshot.revision,
    };
    await dispatchNotifications(
      notificationMutation.previous,
      notificationMutation.state,
      env,
      user.name,
      telegramOrigin(env),
      summary,
      `telegram-draft:${draft.id}`,
    );
    const visibility = await telegramConfirmVisible(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      `${isDocument ? 'Документ сохранён' : 'Запись добавлена в дневник объекта'}\n\n${attachment.name}\nАвтор: ${user.name}\n\n${deepLink(telegramOrigin(env), draft.project_id, 'project')}`,
    );
    requireTelegramVisibility(visibility);
    await updateTelegramDraft(env.DB, draft, draft.payload, 'confirmed');
  };

  const telegramChangeTaskStatus = async (callback, binding, taskId, action, env) => {
    const access = await projectForBinding(env, binding);
    const { snapshot } = access;
    let { user } = access;
    let task = (snapshot.state.tasks ?? []).find((item) => item.id === taskId);
    if (!task || (user.role !== 'management' && task.assigneeId !== user.id)) throw new Error('action_denied');
    const status = ({ ip: 'in_progress', review: 'review', wait: 'waiting', done: 'done' })[action];
    if (!status || (status === 'done' && user.role !== 'management')) throw new Error('action_denied');
    const now = new Date().toISOString();
    let statusChanged = false;
    const mutation = await mutateProjectFromTelegram(
      env,
      binding.project_id,
      user.name,
      user.role,
      'telegram.task.status',
      `Задача «${task.title}» → ${taskStatusLabel(status)}`,
      (state) => {
        const currentUser = (state.settings?.users ?? []).find((item) => item.id === binding.system_user_id && item.status !== 'disabled');
        const currentTask = (state.tasks ?? []).find((item) => item.id === taskId);
        if (!currentUser || !currentTask || (currentUser.role !== 'management' && currentTask.assigneeId !== currentUser.id)) throw new Error('action_denied');
        if (status === 'done' && currentUser.role !== 'management') throw new Error('action_denied');
        user = currentUser;
        task = currentTask;
        const change = changeTelegramTaskStatus(state, currentUser, taskId, status, callback.id, now, `Изменил статус через Telegram: ${taskStatusLabel(status)}`);
        statusChanged = Boolean(change);
        return change ? undefined : TELEGRAM_MUTATION_NOOP;
      },
    );
    const committedTask = (mutation.state.tasks ?? []).find((item) => item.id === taskId) ?? task;
    const actionCommitted = statusChanged || (committedTask.history ?? []).some((event) => event.sourceTelegramCallbackId === callback.id);
    if (actionCommitted && committedTask.status === status) {
      const recoveryEvents = mutation.state.settings?.notifications?.events?.taskAssigned
        && ['waiting', 'review', 'done'].includes(status)
        ? [notificationEvent(`Задача: «${committedTask.title}» → ${taskStatusLabel(status)}`, 'tasks', committedTask.id, committedTask.assigneeId)]
        : [];
      await dispatchNotifications(
        mutation.previous,
        mutation.state,
        env,
        user.name,
        telegramOrigin(env),
        `Обновлена задача «${committedTask.title}»`,
        `telegram-task-status:${callback.id}`,
        null,
        recoveryEvents,
      );
    }
    const visibility = await telegramDurableVisibility(
      env,
      callback.message.chat.id,
      `Задача «${committedTask.title}» теперь: ${taskStatusLabel(committedTask.status)}.\n${deepLink(telegramOrigin(env), binding.project_id, 'tasks', committedTask.id)}`,
      committedTask.status === 'done' ? {} : { reply_markup: taskActionMarkup(binding.project_id, committedTask.id, user.role) },
      `telegram-task-status-confirm:${callback.id}`,
    );
    requireTelegramVisibility(visibility);
    await telegramAnswerCallback(env.TELEGRAM_BOT_TOKEN, callback.id, `Статус: ${taskStatusLabel(committedTask.status)}`);
  };

  return { telegramConfirmTask, telegramConfirmNote, telegramConfirmExpense, telegramConfirmFile, telegramChangeTaskStatus };
};
