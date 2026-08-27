import { clean } from '../lib/validation.js';

export const createIntegrationStatus = ({ ensureSchema, resolveTelegramConnection }) => async (env) => {
  const telegramConnection = await resolveTelegramConnection(env);
  const botUsername = clean(telegramConnection.bot?.username, 120);
  let telegramBoundUsers = 0;
  let telegramPendingMessages = 0;
  let telegramDeadMessages = 0;
  let telegramLastDeliveryError = '';
  if (env.DB) {
    try {
      await ensureSchema(env.DB);
      const [bindingRow, outboxRow, outboxErrorRow] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS count FROM telegram_bindings').first(),
        env.DB.prepare(`
          SELECT COUNT(*) AS count, SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead_count
          FROM telegram_outbox
          WHERE status != 'sent'
        `).first(),
        env.DB.prepare(`
          SELECT last_error
          FROM telegram_outbox
          WHERE status != 'sent' AND last_error IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1
        `).first(),
      ]);
      telegramBoundUsers = Number(bindingRow?.count) || 0;
      telegramPendingMessages = Number(outboxRow?.count) || 0;
      telegramDeadMessages = Number(outboxRow?.dead_count) || 0;
      telegramLastDeliveryError = clean(outboxErrorRow?.last_error, 300);
    } catch {
      telegramBoundUsers = 0;
      telegramPendingMessages = 0;
      telegramDeadMessages = 0;
      telegramLastDeliveryError = '';
    }
  }
  return {
    email: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    telegram: Boolean(telegramConnection.tokenConfigured && telegramConnection.chat?.id),
    telegramBot: Boolean(telegramConnection.tokenConfigured && telegramConnection.issue !== 'invalid_token'),
    telegramBotUsername: botUsername,
    telegramCommon: Boolean(telegramConnection.chat?.id),
    telegramCommonTitle: clean(telegramConnection.chat?.title, 160),
    telegramCandidates: telegramConnection.candidates ?? [],
    telegramIssue: clean(telegramConnection.issue, 80),
    telegramInbound: Boolean(env.TELEGRAM_WEBHOOK_URL && env.TELEGRAM_WEBHOOK_SECRET),
    telegramBoundUsers,
    telegramPendingMessages,
    telegramDeadMessages,
    telegramLastDeliveryError,
    camera: Boolean(env.CAMERA_VIEW_URL),
    websiteForm: true,
    publicWebsiteForm: true,
  };
};
