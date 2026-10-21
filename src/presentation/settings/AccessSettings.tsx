import { Check, FolderKanban, Link2, LockKeyhole, Plus, Pencil, ShieldCheck } from 'lucide-react';
import type { UserRole } from '../../entities/index';
import { formatDateTime } from '../formatting';
import { settingsSnapshot } from '../../domain/settings';
import { Field, Modal, SectionHeader, StatusBadge } from '../../components/Ui';
import { roleLabels } from './views';
import type { SettingsProps } from './contracts';
import type { useAccessSettings } from './useAccessSettings';
import type { useIntegrationSettings } from './useIntegrationSettings';

export function AccessSettings({ state, canManageAccess, access, integrations }: Pick<SettingsProps, 'state' | 'canManageAccess'> & { access: ReturnType<typeof useAccessSettings>; integrations: ReturnType<typeof useIntegrationSettings> }) {
  const { setRosterExpected, showInvite, setShowInvite, invite, setInvite, editingUser, setEditingUser, accessSnapshot, accessBusy, accessErrors, accessLink, setAccessLink, projectAccess, setProjectAccess, inviteUser, saveUser, webAccessFor, telegramAccessFor, openProjectAccess, saveProjectAccess, issueWebLink, changeWebAccess, disconnectTelegram, webStatusView } = access;
  const { integrationMessage, createTelegramLink } = integrations;
  return <>
            <>
              <section className="panel settings-panel"><SectionHeader eyebrow="Команда" title="Пользователи и роли" action={<button type="button" className="button button--primary button--compact" disabled={!canManageAccess} title={canManageAccess ? '' : 'Добавлять пользователей может только владелец'} onClick={() => { setRosterExpected(settingsSnapshot(state)); setShowInvite(true); }}><Plus size={16} /> Добавить</button>} />
                <div className="user-list">
                  <div className="user-list__head"><span>Пользователь</span><span>Роль</span><span>Веб-доступ</span><span>Telegram</span><span>Последний вход</span><span>Действия</span></div>
                  {state.settings.users.map((user) => {
                    const web = webAccessFor(user);
                    const telegram = telegramAccessFor(user);
                    const webView = webStatusView(user);
                    const busy = accessBusy?.userId === user.id;
                    const localAccess = canManageAccess && accessSnapshot?.authMode !== 'sites_sso' && user.id !== 'user-owner';
                    return <article key={user.id} className="user-row">
                      <span className="user-row__avatar">{user.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
                      <div className="user-row__identity"><strong>{user.name}</strong><small>{user.email}</small></div>
                      <span className="user-row__role"><StatusBadge label={roleLabels[user.role]} tone={user.role === 'management' ? 'blue' : 'neutral'} /></span>
                      <span className="user-row__web"><StatusBadge label={webView.label} tone={webView.tone} /></span>
                      <span className="user-row__telegram"><StatusBadge label={telegram.status === 'connected' ? 'Подключён' : 'Не подключён'} tone={telegram.status === 'connected' ? 'positive' : 'neutral'} /></span>
                      <small className="user-row__last">{web.lastLoginAt ? formatDateTime(web.lastLoginAt) : 'Ещё не входил'}</small>
                      <span className="user-row__actions access-actions">
                        {localAccess && ['not_issued', 'expired'].includes(web.status) && <button type="button" disabled={busy} onClick={() => void openProjectAccess(user, 'issue')}>{web.status === 'expired' ? 'Новая ссылка' : 'Выдать доступ'}</button>}
                        {localAccess && web.status === 'pending' && <button type="button" disabled={busy} onClick={() => void issueWebLink(user)}>Перевыпустить</button>}
                        {localAccess && ['pending', 'active', 'blocked'].includes(web.status) && <button type="button" disabled={busy} onClick={() => void openProjectAccess(user, 'manage')}>Проекты</button>}
                        {localAccess && web.status === 'active' && <button type="button" disabled={busy} onClick={() => void issueWebLink(user, true)}>Сбросить пароль</button>}
                        {localAccess && web.status === 'active' && <button type="button" disabled={busy} onClick={() => void changeWebAccess(user, 'sessions/revoke')}>Завершить сессии</button>}
                        {localAccess && web.status === 'active' && <button type="button" className="danger" disabled={busy} onClick={() => void changeWebAccess(user, 'block')}>Заблокировать</button>}
                        {localAccess && web.status === 'blocked' && <button type="button" disabled={busy} onClick={() => void changeWebAccess(user, 'unblock')}>Разблокировать</button>}
                        {canManageAccess && telegram.status === 'not_connected' && <button type="button" disabled={busy || user.status === 'disabled'} onClick={() => void createTelegramLink(user)}>Подключить Telegram</button>}
                        {canManageAccess && telegram.status === 'connected' && <button type="button" className="danger" disabled={busy} onClick={() => void disconnectTelegram(user)}>Отключить Telegram</button>}
                        <button type="button" aria-label={`Редактировать ${user.name}`} disabled={!canManageAccess || busy || user.id === 'user-owner'} onClick={() => { setRosterExpected(settingsSnapshot(state)); setEditingUser({ ...user }); }}><Pencil size={15} /></button>
                      </span>
                      {accessErrors[user.id] && <small className="access-inline-error" role="status" aria-live="polite">{accessErrors[user.id]}</small>}
                    </article>;
                  })}
                </div>
                {integrationMessage && <div className="integration-result" role="status" aria-live="polite">{integrationMessage}</div>}
                {!canManageAccess && <div className="settings-note"><ShieldCheck size={18} /><span>Выдавать, блокировать и сбрасывать веб-доступ может только владелец системы.</span></div>}
              </section>
              <section className="panel settings-panel"><SectionHeader eyebrow="Матрица" title="Что видит каждая роль" />
                <div className="permission-table"><div className="permission-table__head"><strong>Раздел</strong><strong>Управление</strong><strong>Прораб</strong><strong>Клиент</strong></div>{[
                  ['Финансы и маржа', true, false, false], ['Маркетинг и заявки', true, false, false], ['Все задачи / только свои', true, true, false], ['Этапы и график', true, true, true], ['Снабжение', true, true, false], ['Контроль качества', true, true, true], ['Настройки и доступы', true, false, false],
                ].map(([label, management, foreman, client]) => <div className="permission-table__row" key={String(label)}><span>{String(label)}</span>{[management, foreman, client].map((allowed, index) => <span key={index}>{allowed ? <Check size={17} /> : '—'}</span>)}</div>)}</div>
                <div className="settings-note"><LockKeyhole size={18} /><span>{accessSnapshot?.authMode === 'sites_sso' ? 'На резервном стенде вход выполняется через аккаунт ChatGPT, а список разрешённых email управляется владельцем сайта.' : 'Email — это логин сотрудника. Владелец выдаёт одноразовую ссылку на 7 дней; человек сам задаёт пароль. Telegram подключается отдельно и не даёт веб-доступ.'}</span></div>
              </section>
            </>
      {showInvite && <Modal title="Добавить пользователя" subtitle={accessSnapshot?.authMode === 'sites_sso' ? 'Создадим профиль. Вход на резервный стенд управляется защищённым списком сайта.' : 'Email станет логином. После сохранения система выпустит одноразовую ссылку для установки пароля.'} onClose={() => setShowInvite(false)}><form className="modal-form" onSubmit={inviteUser}><div className="form-grid"><Field label="Имя"><input required value={invite.name} onChange={(event) => setInvite({ ...invite, name: event.target.value })} /></Field><Field label="Email — логин"><input required type="email" value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} /></Field></div><div className="form-grid"><Field label="Роль"><select value={invite.role} onChange={(event) => setInvite({ ...invite, role: event.target.value as UserRole })}><option value="management">Управление</option><option value="foreman">Прораб</option><option value="client">Клиент</option></select></Field><Field label="Telegram"><input value={invite.telegram} onChange={(event) => setInvite({ ...invite, telegram: event.target.value })} placeholder="@username, необязательно" /></Field></div>{accessErrors.new && <div className="access-inline-error" role="alert">{accessErrors.new}</div>}<div className="settings-note"><Link2 size={18} /><span>{accessSnapshot?.authMode === 'sites_sso' ? 'Веб-доступ и Telegram — разные подключения. Добавьте email в защищённый доступ сайта; Telegram можно связать после создания профиля.' : 'Веб-доступ и Telegram — разные подключения. Сотрудник сам задаст пароль по ссылке; Telegram можно связать после создания профиля.'}</span></div><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setShowInvite(false)}>Отмена</button><button type="submit" className="button button--primary" disabled={accessBusy?.userId === 'new'}><Plus size={17} /> {accessSnapshot?.authMode === 'sites_sso' ? 'Создать профиль' : 'Создать и выдать доступ'}</button></div></form></Modal>}
      {editingUser && <Modal title={`Редактировать: ${editingUser.name}`} subtitle="Email является логином. При его смене потребуется выпустить новую ссылку активации." onClose={() => setEditingUser(null)}><form className="modal-form" onSubmit={saveUser}><div className="form-grid"><Field label="Имя"><input required value={editingUser.name} onChange={(event) => setEditingUser({ ...editingUser, name: event.target.value })} /></Field><Field label="Email — логин"><input required type="email" value={editingUser.email} onChange={(event) => setEditingUser({ ...editingUser, email: event.target.value })} /></Field><Field label="Роль"><select value={editingUser.role} onChange={(event) => setEditingUser({ ...editingUser, role: event.target.value as UserRole })}><option value="management">Управление</option><option value="foreman">Прораб</option><option value="client">Клиент</option></select></Field><Field label="Telegram"><input value={editingUser.telegram ?? ''} onChange={(event) => setEditingUser({ ...editingUser, telegram: event.target.value })} placeholder="@username" /></Field></div><div className="settings-note"><Link2 size={18} /><span>Блокировка и разблокировка выполняются отдельными кнопками в списке, чтобы веб-сессии отзывались на сервере.</span></div><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setEditingUser(null)}>Отмена</button><button type="submit" className="button button--primary" disabled={accessBusy?.userId === editingUser.id}>Сохранить</button></div></form></Modal>}
      {projectAccess && <Modal
        title={`Проекты: ${projectAccess.user.name}`}
        subtitle={projectAccess.mode === 'issue'
          ? projectAccess.accountActive
            ? 'Пароль уже создан. Добавьте нужные проекты — сотрудник войдёт с прежним логином и паролем.'
            : 'При первой выдаче выбраны все существующие проекты. Ненужные можно снять сейчас или позже.'
          : 'Отметьте проекты, которые сотрудник должен видеть. Снятые проекты закрываются сразу.'}
        onClose={() => setProjectAccess(null)}
      >
        <div className="project-access-list">
          {projectAccess.projects.map((project) => {
            const checked = projectAccess.selected.includes(project.id);
            const currentProjectRequired = projectAccess.mode === 'issue' && project.id === state.project.id;
            return <label key={project.id} className={checked ? 'project-access-item project-access-item--selected' : 'project-access-item'}>
              <input
                type="checkbox"
                checked={checked}
                disabled={currentProjectRequired}
                onChange={() => setProjectAccess((current) => current ? {
                  ...current,
                  selected: checked
                    ? current.selected.filter((id) => id !== project.id)
                    : [...current.selected, project.id],
                } : current)}
              />
              <span className="project-access-item__icon"><FolderKanban size={18} /></span>
              <span className="project-access-item__copy"><strong>{project.code} · {project.name}</strong><small>{roleLabels[project.role]}{project.id === state.project.id ? ' · текущий проект' : ''}</small></span>
              <StatusBadge label={checked ? 'Доступ есть' : 'Нет доступа'} tone={checked ? 'positive' : 'neutral'} />
            </label>;
          })}
        </div>
        <div className="settings-note"><ShieldCheck size={18} /><span>Новые проекты не добавляются автоматически. Их можно выдать позже здесь же. Telegram-привязка от выбора проектов не меняется.</span></div>
        {accessErrors[projectAccess.user.id] && <div className="access-inline-error" role="alert">{accessErrors[projectAccess.user.id]}</div>}
        <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setProjectAccess(null)}>Отмена</button><button type="button" className="button button--primary" disabled={accessBusy?.userId === projectAccess.user.id} onClick={() => void saveProjectAccess()}><Check size={17} /> {projectAccess.mode === 'issue' ? 'Выдать и получить ссылку' : 'Сохранить доступы'}</button></div>
      </Modal>}
      {accessLink && <Modal title={`${accessLink.purpose === 'reset' ? 'Сброс пароля' : 'Доступ'} для ${accessLink.userName}`} subtitle={accessLink.purpose === 'existing' ? 'У пользователя уже есть пароль ИКИОМА ОС; доступ к этому проекту добавлен.' : `Одноразовая ссылка действует до ${formatDateTime(accessLink.expiresAt ?? '')}.`} onClose={() => setAccessLink(null)}><div className="telegram-link-card access-link-card"><p>{accessLink.purpose === 'existing' ? 'Отправьте человеку ссылку на вход. Он использует прежний пароль и свой email.' : 'Отправьте ссылку именно выбранному человеку. Он задаст пароль и войдёт в ИКИОМА ОС по своему email.'}</p><Field label="Логин"><input readOnly value={accessLink.login} onFocus={(event) => event.currentTarget.select()} /></Field><Field label={accessLink.purpose === 'existing' ? 'Ссылка на вход' : 'Ссылка активации'}><input readOnly value={accessLink.url} onFocus={(event) => event.currentTarget.select()} /></Field><div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setAccessLink(null)}>Закрыть</button><button type="button" className="button button--primary" onClick={() => { void navigator.clipboard.writeText(accessLink.url); }}><Link2 size={16} /> Скопировать ссылку</button></div></div></Modal>}
</>;
}
