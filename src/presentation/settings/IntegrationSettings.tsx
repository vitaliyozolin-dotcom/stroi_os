import { Camera, Globe2, Link2, Mail, Send, ShieldCheck } from 'lucide-react';

import { formatDateTime } from '../formatting';

import { Modal, SectionHeader, StatusBadge } from '../../components/Ui';

import type { useIntegrationSettings } from './useIntegrationSettings';

export function IntegrationSettings({ integrations }: { integrations: ReturnType<typeof useIntegrationSettings> }) {
  const { integrationStatus, integrationMessage, integrationChecking, recheckTelegram, testIntegration, selectTelegramChat, telegramCommand, telegramHeadquartersReady, telegramStatusLabel } = integrations;
  return (
            <section className="panel settings-panel">
              <SectionHeader eyebrow="Подключения" title="Источники данных и уведомлений" />
              <div className="integration-grid">
                <article>
                  <span><Globe2 size={21} /></span>
                  <div><strong>Формы на ikioma.ru</strong><p>Заявки с публичного сайта поступают в отдельную воронку ИКИОМА и сохраняются с точным временем отправки.</p></div>
                  <StatusBadge label={integrationStatus?.publicWebsiteForm ? 'Принимает заявки' : 'Только внутри'} tone={integrationStatus?.publicWebsiteForm ? 'positive' : 'warning'} />
                </article>
                <article>
                  <span><Send size={21} /></span>
                  <div>
                    <strong>Telegram-бот и общий чат</strong>
                    <p>{integrationStatus?.telegramCommon
                      ? integrationStatus.telegramInbound
                        ? `Полевой штаб работает: изменения уходят в «${integrationStatus.telegramCommonTitle || 'общий чат'}», а команды, задачи и файлы принимаются обратно.${integrationStatus.telegramDeadMessages ? ` Требуют проверки: ${integrationStatus.telegramDeadMessages}.` : integrationStatus.telegramPendingMessages ? ` В очереди доставки: ${integrationStatus.telegramPendingMessages}.` : ' Очередь доставки пуста.'}`
                        : `Исходящие уведомления работают; входящие команды ещё не подключены.`
                      : `Добавьте бота в общий чат, отправьте там ${telegramCommand} — ИКИОМА ОС найдёт группу автоматически.`}</p>
                  </div>
                  <StatusBadge label={telegramHeadquartersReady ? 'Полевой штаб готов' : telegramStatusLabel} tone={telegramHeadquartersReady ? 'positive' : integrationStatus?.telegramIssue === 'invalid_token' ? 'warning' : 'neutral'} />
                  {integrationStatus?.telegramCandidates?.length ? (
                    <div className="telegram-chat-options">
                      <small>Бот видит несколько групп. Какая из них общая?</small>
                      {integrationStatus.telegramCandidates.map((candidate) => (
                        <button type="button" className="text-button" key={candidate.id} onClick={() => void selectTelegramChat(candidate)}>
                          Подключить «{candidate.title}»
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {integrationStatus?.telegramCommon
                    ? <button type="button" className="text-button integration-action" onClick={() => void testIntegration('telegram')}>Отправить тест в общий чат</button>
                    : integrationStatus?.telegramBot
                      ? <button type="button" className="text-button integration-action" disabled={integrationChecking} onClick={() => void recheckTelegram()}>{integrationChecking ? 'Проверяем…' : 'Проверить ещё раз'}</button>
                      : null}
                </article>
                <article>
                  <span><Camera size={21} /></span>
                  <div><strong>Камера объекта</strong><p>Защищённая трансляция через совместимый RTSP/WebRTC-шлюз без хранения пароля камеры в проекте.</p></div>
                  <StatusBadge label={integrationStatus?.camera ? 'Подключена' : 'Ожидает оборудование'} tone={integrationStatus?.camera ? 'positive' : 'neutral'} />
                </article>
                <article>
                  <span><Mail size={21} /></span>
                  <div><strong>Email через Resend</strong><p>Уведомления и будущие приглашения пользователей.</p></div>
                  <StatusBadge label={integrationStatus?.email ? 'Подключён' : 'Нужны API-ключ и отправитель'} tone={integrationStatus?.email ? 'positive' : 'neutral'} />
                  {integrationStatus?.email && <button type="button" className="text-button integration-action" onClick={() => void testIntegration('email')}>Отправить тест</button>}
                </article>
              </div>
              {integrationMessage && <div className="integration-result" role="status" aria-live="polite">{integrationMessage}</div>}
              <div className="settings-note"><ShieldCheck size={18} /><span>Токен бота хранится как закрытый серверный секрет. Общий чат фиксируется только после успешного проверочного сообщения; личный chat ID используется только для адресных задач. Чтобы бот получал обычные обращения @ikioma_bot в группе, отключите Group Privacy через @BotFather → /setprivacy → Disable и заново добавьте бота в группу.</span></div>
            </section>
);
}

export function TelegramLinkDialog({ integrations }: { integrations: ReturnType<typeof useIntegrationSettings> }) {
  const { telegramLink, setTelegramLink, setIntegrationMessage } = integrations;
  return <>      {telegramLink && <Modal title={`Telegram для ${telegramLink.userName}`} subtitle={`Персональная одноразовая ссылка действует до ${formatDateTime(telegramLink.expiresAt)}.`} onClose={() => setTelegramLink(null)}><div className="telegram-link-card"><p>Отправьте эту ссылку именно выбранному сотруднику. После нажатия «Запустить» его Telegram автоматически свяжется с профилем в ИКИОМА ОС.</p><input readOnly value={telegramLink.url} onFocus={(event) => event.currentTarget.select()} /><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setTelegramLink(null)}>Закрыть</button><button type="button" className="button button--primary" onClick={() => { void navigator.clipboard.writeText(telegramLink.url); setIntegrationMessage('Ссылка скопирована.'); }}><Link2 size={16} /> Скопировать ссылку</button></div></div></Modal>}
</>;
}
