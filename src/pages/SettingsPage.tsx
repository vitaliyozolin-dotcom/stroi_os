import { useState } from 'react';
import { BellRing, Bot, LayoutDashboard, Settings2, UserCog } from 'lucide-react';
import type { DashboardWidget, NotificationSettings } from '../entities/index';
import { useModuleRepository } from '../useModuleRepository';
import { createSettingsRepository } from '../infrastructure/module-project';
import { settingsSnapshot } from '../domain/settings';
import { createSettingsUseCases } from '../application';
import { runtimeIdGenerator, systemClock } from '../infrastructure/runtime';
import type { SettingsProps, SettingsTab } from '../presentation/settings/contracts';
import { useAccessSettings } from '../presentation/settings/useAccessSettings';
import { useIntegrationSettings } from '../presentation/settings/useIntegrationSettings';
import { AccessSettings } from '../presentation/settings/AccessSettings';
import { DashboardSettings, NotificationSettingsPanel } from '../presentation/settings/DisplaySettings';
import { IntegrationSettings, TelegramLinkDialog } from '../presentation/settings/IntegrationSettings';

export function SettingsPage(props: SettingsProps) {
  return <SettingsWorkspace key={props.state.project.id} {...props} />;
}

function SettingsWorkspace(props: SettingsProps) {
  const { state, actor, role, canManageAccess, onChange } = props;
  const settingsCommands = createSettingsUseCases(useModuleRepository(createSettingsRepository, state, onChange), { name: actor, role, canManageAccess }, systemClock, runtimeIdGenerator);
  const [settingsError, setSettingsError] = useState('');
  const [tab, setTab] = useState<SettingsTab>('access');
  const integrations = useIntegrationSettings(state, tab);
  const access = useAccessSettings(props, settingsCommands, tab, integrations.setIntegrationMessage);
  const toggleWidget = (widget: DashboardWidget) => {
    const result = settingsCommands.execute({ kind: 'widget', expected: settingsSnapshot(state), widget, enabled: !state.settings.dashboardWidgets.includes(widget) });
    setSettingsError(result.ok ? '' : result.error);
  };
  const toggleChannel = (key: keyof NotificationSettings['channels']) => {
    const result = settingsCommands.execute({ kind: 'channel', expected: settingsSnapshot(state), key, enabled: !state.settings.notifications.channels[key] });
    setSettingsError(result.ok ? '' : result.error);
  };
  const toggleEvent = (key: keyof NotificationSettings['events']) => {
    const result = settingsCommands.execute({ kind: 'event', expected: settingsSnapshot(state), key, enabled: !state.settings.notifications.events[key] });
    setSettingsError(result.ok ? '' : result.error);
  };

  const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings2 }> = [
    { id: 'access', label: 'Доступы', icon: UserCog },
    { id: 'dashboard', label: 'Главный экран', icon: LayoutDashboard },
    { id: 'notifications', label: 'Уведомления', icon: BellRing },
    { id: 'integrations', label: 'Интеграции', icon: Bot },
  ];

  return (
    <div className="page-stack">
      {settingsError && <p role="alert" className="form-warning">{settingsError}</p>}
      <section className="page-title-row">
        <div><span className="eyebrow">Администрирование</span><h1>Настройки системы</h1><p>Роли и доступы, состав главного экрана, правила уведомлений и внешние подключения.</p></div>
      </section>

      <div className="settings-layout">
        <aside className="settings-tabs">{tabs.map((item) => { const Icon = item.icon; return <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><Icon size={18} /><span>{item.label}</span></button>; })}</aside>
        <div className="settings-content">
          {tab === 'access' && <AccessSettings state={state} canManageAccess={canManageAccess} access={access} integrations={integrations} />}
          {tab === 'dashboard' && <DashboardSettings state={state} toggleWidget={toggleWidget} />}
          {tab === 'notifications' && <NotificationSettingsPanel state={state} integrationStatus={integrations.integrationStatus} toggleChannel={toggleChannel} toggleEvent={toggleEvent} />}
          {tab === 'integrations' && <IntegrationSettings integrations={integrations} />}
        </div>
      </div>
      <TelegramLinkDialog integrations={integrations} />
    </div>
  );
}
