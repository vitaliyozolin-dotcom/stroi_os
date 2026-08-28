import { json } from '../lib/http.js';
import { constantTimeEqual } from '../lib/secret.js';
import { clean } from '../lib/validation.js';

const commands = [
  { command: 'task', description: 'Поставить задачу' },
  { command: 'tasks', description: 'Открытые задачи' },
  { command: 'stages', description: 'Этапы и сроки' },
  { command: 'done', description: 'Выполненные задачи' },
  { command: 'finance', description: 'Расходы, доходы и баланс' },
  { command: 'expense', description: 'Добавить расход' },
  { command: 'status', description: 'Статус объекта' },
  { command: 'note', description: 'Запись в дневник объекта' },
  { command: 'report', description: 'Добавить фотоотчёт' },
  { command: 'doc', description: 'Сохранить документ' },
  { command: 'camera', description: 'Камера объекта' },
  { command: 'project', description: 'Выбрать объект' },
  { command: 'help', description: 'Что умеет бот' },
];

const guideText = [
  '🏗 ИкиОМА · Telegram-полевой штаб запущен',
  '',
  'Теперь чат умеет не только получать уведомления, но и работать со ИКИОМА ОС.',
  '',
  '1. Подключите себя',
  'ИКИОМА ОС → Настройки → Доступы → значок ссылки рядом со своим именем. Откройте персональную ссылку и нажмите «Запустить». Без привязки бот не даст менять проект — случайные люди из чата командовать стройкой не смогут.',
  '',
  '2. Команды',
  '/task Илья, проверить геометрию свай завтра срочно — создать черновик задачи. Сохранится только после подтверждения.',
  '/tasks — открытые задачи: руководитель видит все, сотрудник только свои.',
  '/status — этапы, просрочки, снабжение и принятые/оплаченные суммы.',
  '/note текст — создать черновик записи в дневник объекта; сохранится только после подтверждения.',
  '/camera — свежий кадр или ссылка на эфир после установки камеры.',
  '/project — выбрать объект, если их несколько.',
  '/help — короткая памятка.',
  '',
  '3. Фото и документы',
  '• Фото или голосовое сообщение с подписью /report — в полевой дневник объекта.',
  '• Договор, акт, счёт, УПД или накладная с подписью /doc — в документы проекта.',
  '• В личном чате с ботом файл можно отправить без команды.',
  '• Перед сохранением бот всегда показывает черновик и просит подтверждение.',
  '',
  '4. Задачи',
  'Исполнитель получает личное уведомление и может нажать «Принял», «На проверку» или «Есть проблема». Изменения проекта продолжают приходить в этот общий чат.',
  '',
  'Важно: обычная переписка общего чата не переносится в ОС. Бот обрабатывает команды, обращения с @ikioma_bot и ответы на его сообщения. Если смысл не распознан, бот прямо напишет, что ничего не сохранено.',
  'Камера пока не установлена, поэтому /camera честно сообщит, что оборудование ожидается. Голосовые отчёты сохраняются как аудио; автоматическую расшифровку подключим отдельным этапом.',
].join('\n');

export const createTelegramBootstrapHandler = ({
  ensureSchema,
  changes,
  resolveTelegramConnection,
  telegramRequest,
  telegramSend,
  parseTelegramBody,
  telegramOrigin,
}) => {
  const sendGuide = async (connection, env) => {
    const chatId = clean(connection?.chat?.id, 120);
    if (!chatId || !env.DB || !env.TELEGRAM_BOT_TOKEN) return { sent: false, issue: 'chat_missing' };
    await ensureSchema(env.DB);
    const messageKey = 'system:telegram-field-headquarters-guide-v1';
    const now = new Date().toISOString();
    const claim = await env.DB.prepare(`
      INSERT INTO telegram_updates (update_id, received_at, processed_at, status, error)
      VALUES (?, ?, NULL, 'processing', NULL)
      ON CONFLICT(update_id) DO NOTHING
    `).bind(messageKey, now).run();
    if (changes(claim) !== 1) {
      const existing = await env.DB.prepare(`
        SELECT status, received_at FROM telegram_updates WHERE update_id = ?
      `).bind(messageKey).first();
      if (existing?.status === 'done') return { sent: false, ready: true, status: 'already_sent', issue: '' };
      if (existing?.status === 'processing') {
        const claimedAt = Date.parse(clean(existing.received_at, 80));
        const stale = !Number.isFinite(claimedAt) || Date.now() - claimedAt > 120_000;
        if (!stale) return { sent: false, ready: false, status: 'processing', issue: '' };
        const staleClaim = await env.DB.prepare(`
          UPDATE telegram_updates
          SET received_at = ?, processed_at = NULL, status = 'processing', error = NULL
          WHERE update_id = ? AND status = 'processing' AND received_at = ?
        `).bind(now, messageKey, existing.received_at).run();
        if (changes(staleClaim) !== 1) return { sent: false, ready: false, status: 'processing', issue: '' };
      }
      if (existing?.status === 'error') {
        const retryClaim = await env.DB.prepare(`
          UPDATE telegram_updates
          SET received_at = ?, processed_at = NULL, status = 'processing', error = NULL
          WHERE update_id = ? AND status = 'error'
        `).bind(now, messageKey).run();
        if (changes(retryClaim) !== 1) return { sent: false, ready: false, status: 'retry_conflict', issue: '' };
      }
    }

    try {
      const response = await telegramSend(env.TELEGRAM_BOT_TOKEN, chatId, guideText, {
        reply_markup: { inline_keyboard: [[{ text: 'Открыть ИКИОМА ОС', url: telegramOrigin(env) }]] },
      });
      const body = await parseTelegramBody(response);
      if (!response.ok || !body?.ok) throw new Error('telegram_guide_rejected');
      await env.DB.prepare(`
        UPDATE telegram_updates SET status = 'done', processed_at = ?, error = NULL WHERE update_id = ?
      `).bind(new Date().toISOString(), messageKey).run();
      if (body.result?.message_id) {
        await telegramRequest(env.TELEGRAM_BOT_TOKEN, 'pinChatMessage', {
          chat_id: chatId,
          message_id: body.result.message_id,
          disable_notification: true,
        });
      }
      return { sent: true, ready: true, status: 'sent', issue: '' };
    } catch (error) {
      await env.DB.prepare(`
        UPDATE telegram_updates SET status = 'error', processed_at = ?, error = ? WHERE update_id = ?
      `).bind(new Date().toISOString(), clean(error instanceof Error ? error.message : 'telegram_guide_failed', 300), messageKey).run();
      return { sent: false, ready: false, status: 'failed', issue: 'telegram_guide_failed' };
    }
  };

  return async (request, env) => {
    const suppliedKey = clean(request.headers.get('x-stroios-setup-key'), 160);
    const expectedKey = clean(env.TELEGRAM_SETUP_KEY, 160);
    if (!expectedKey || !constantTimeEqual(suppliedKey, expectedKey)) return json({ ok: false, error: 'setup_authorization_required' }, 403);

    const connection = await resolveTelegramConnection(env);
    let webhookReady = false;
    let webhookIssue = '';
    if (env.TELEGRAM_WEBHOOK_URL && env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_BOT_TOKEN) {
      try {
        const [webhookResponse, commandsResponse] = await Promise.all([
          telegramRequest(env.TELEGRAM_BOT_TOKEN, 'setWebhook', {
            url: env.TELEGRAM_WEBHOOK_URL,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query', 'my_chat_member'],
            drop_pending_updates: false,
          }),
          telegramRequest(env.TELEGRAM_BOT_TOKEN, 'setMyCommands', { commands, language_code: 'ru' }),
        ]);
        const [webhookBody, commandsBody] = await Promise.all([
          parseTelegramBody(webhookResponse),
          parseTelegramBody(commandsResponse),
        ]);
        webhookReady = Boolean(webhookResponse.ok && webhookBody?.ok && commandsResponse.ok && commandsBody?.ok);
        if (!webhookReady) webhookIssue = 'telegram_webhook_rejected';
      } catch {
        webhookIssue = 'telegram_provider_unavailable';
      }
    } else {
      webhookIssue = 'webhook_not_configured';
    }
    const guide = webhookReady && connection.chat?.id
      ? await sendGuide(connection, env)
      : { sent: false, ready: false, status: 'not_attempted', issue: '' };
    return json({
      ok: Boolean(connection.chat?.id && webhookReady),
      telegramBot: Boolean(connection.tokenConfigured && connection.issue !== 'invalid_token'),
      telegramCommon: Boolean(connection.chat?.id),
      telegramCommonTitle: clean(connection.chat?.title, 160),
      telegramCandidateCount: connection.candidates?.length ?? 0,
      telegramIssue: clean(connection.issue, 80),
      telegramInbound: webhookReady,
      telegramWebhookIssue: webhookIssue,
      telegramGuideSent: guide.sent,
      telegramGuideReady: guide.ready,
      telegramGuideStatus: guide.status,
      telegramGuideIssue: guide.issue,
    }, connection.chat?.id && webhookReady ? 200 : 409);
  };
};
