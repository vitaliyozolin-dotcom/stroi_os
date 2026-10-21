import { useEffect, useState } from 'react';
import type { AppState, SystemUser } from '../../entities/index';
import type { SettingsTab, IntegrationStatus, TelegramCandidate } from './contracts';
import { useSettingsRequest } from './useSettingsRequest';

export function useIntegrationSettings(state: AppState, tab: SettingsTab) {
  const { request: requestApi } = useSettingsRequest(state.project.id);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
  const [integrationMessage, setIntegrationMessage] = useState('');
  const [integrationChecking, setIntegrationChecking] = useState(false);
  const [telegramLink, setTelegramLink] = useState<{ userName: string; url: string; expiresAt: string } | null>(null);
  const refreshIntegrationStatus = async (): Promise<IntegrationStatus | null> => {
    try {
      const response = await requestApi('/api/integrations/status', { cache: 'no-store' });
      const body = await response.json() as { integrations?: IntegrationStatus };
      const nextStatus = response.ok ? body.integrations ?? null : null;
      setIntegrationStatus(nextStatus);
      return nextStatus;
    } catch {
      setIntegrationStatus(null);
      return null;
    }
  };

  const recheckTelegram = async () => {
    setIntegrationChecking(true);
    setIntegrationMessage('Ищем сообщение от бота в Telegram-группе…');
    const status = await refreshIntegrationStatus();
    const command = status?.telegramBotUsername ? `/start@${status.telegramBotUsername}` : '/start@ikioma_bot';
    if (!status) {
      setIntegrationMessage('Не удалось связаться с сервером ИКИОМА ОС. Обновите страницу и повторите.');
    } else if (status.telegramCommon) {
      setIntegrationMessage(`Общий чат «${status.telegramCommonTitle || 'ИкиОМА'}» подключён. Проверочное сообщение отправлено ботом.`);
    } else if (status.telegramCandidates?.length) {
      setIntegrationMessage('Бот увидел несколько групп. Выберите нужный чат в карточке Telegram.');
    } else {
      setIntegrationMessage(`Группа пока не найдена. Отправьте ${command} в группе «ИкиОМА», затем нажмите кнопку ещё раз.`);
    }
    setIntegrationChecking(false);
  };

  useEffect(() => {
    if (tab !== 'integrations' && tab !== 'notifications') return;
    void refreshIntegrationStatus();
  }, [tab]);

  const testIntegration = async (channel: 'email' | 'telegram') => {
    setIntegrationMessage('Проверяем подключение…');
    try {
      const response = await requestApi('/api/integrations/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, to: state.settings.users.find((user) => user.role === 'management')?.email, message: `ИКИОМА ОС: тест канала ${channel === 'email' ? 'Email' : 'Telegram'} для проекта ${state.project.code}` }) });
      const body = await response.json();
      setIntegrationMessage(response.ok && body.ok
        ? `Тест ${channel === 'email' ? 'Email' : 'Telegram'} отправлен.`
        : body.error === 'email_not_configured'
          ? 'Email ещё не подключён: нужен ключ Resend и подтверждённый адрес отправителя.'
          : ['telegram_not_configured', 'chat_not_found'].includes(body.error)
            ? 'Бот пока не видит общий чат. Отправьте в группе команду запуска и нажмите «Проверить ещё раз».'
            : body.error === 'chat_ambiguous'
              ? 'Бот видит несколько групп. Выберите нужный общий чат ниже.'
              : body.error === 'invalid_token'
                ? 'Telegram не принял токен бота.'
                : 'Провайдер не принял тест. Проверьте подключение и права бота.');
    } catch { setIntegrationMessage('Сервер проверки временно недоступен.'); }
  };

  const selectTelegramChat = async (candidate: TelegramCandidate) => {
    setIntegrationMessage(`Подключаем чат «${candidate.title}»…`);
    try {
      const response = await requestApi('/api/integrations/telegram/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: candidate.id }),
      });
      const body = await response.json();
      if (!response.ok || !body.ok) {
        setIntegrationMessage(body.error === 'send_failed'
          ? 'Бот видит чат, но не может отправлять сообщения. Проверьте, что он остаётся участником группы.'
          : 'Не удалось подключить этот чат. Отправьте в группе новую команду и повторите.');
        return;
      }
      setIntegrationMessage(`Общий чат «${body.chat?.title ?? candidate.title}» подключён. Проверочное сообщение отправлено.`);
      await refreshIntegrationStatus();
    } catch {
      setIntegrationMessage('Сервер проверки временно недоступен.');
    }
  };

  const createTelegramLink = async (user: SystemUser) => {
    setIntegrationMessage(`Готовим персональную Telegram-ссылку для ${user.name}…`);
    try {
      const response = await requestApi('/api/integrations/telegram/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: state.project.id, userId: user.id }),
      });
      const body = await response.json() as { ok?: boolean; url?: string; expiresAt?: string; error?: string };
      if (!response.ok || !body.ok || !body.url || !body.expiresAt) {
        setIntegrationMessage(body.error === 'telegram_not_configured'
          ? 'Сначала завершите подключение Telegram-бота.'
          : 'Не удалось выпустить ссылку. Обновите страницу и повторите.');
        return;
      }
      setTelegramLink({ userName: user.name, url: body.url, expiresAt: body.expiresAt });
      setIntegrationMessage(`Ссылка для ${user.name} готова и действует 24 часа.`);
    } catch {
      setIntegrationMessage('Сервер Telegram-привязки временно недоступен.');
    }
  };

  const telegramCommand = integrationStatus?.telegramBotUsername ? `/start@${integrationStatus.telegramBotUsername}` : '/start';
  const telegramHeadquartersReady = Boolean(integrationStatus?.telegramCommon && integrationStatus?.telegramInbound);
  const telegramStatusLabel = integrationStatus?.telegramCommon
    ? integrationStatus.telegramCommonTitle || 'Общий чат подключён'
    : integrationStatus?.telegramIssue === 'invalid_token'
      ? 'Токен не принят'
      : integrationStatus?.telegramCandidates?.length
        ? 'Выберите общий чат'
        : integrationStatus?.telegramBot
          ? 'Бот подключён, ждём чат'
          : 'Нужен токен бота';

  return { integrationStatus, integrationMessage, setIntegrationMessage, integrationChecking, telegramLink, setTelegramLink, recheckTelegram, testIntegration, selectTelegramChat, createTelegramLink, telegramCommand, telegramHeadquartersReady, telegramStatusLabel };
}
