import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Share, Smartphone } from 'lucide-react';
import { Modal } from './Ui';

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches
  || (navigator as Navigator & { standalone?: boolean }).standalone === true;

export function AppInstall() {
  const [installed, setInstalled] = useState(isStandalone);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  useEffect(() => {
    const displayMode = window.matchMedia('(display-mode: standalone)');
    const update = () => setInstalled(isStandalone());
    const capture = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const complete = () => { setInstalled(true); setOpen(false); setPrompt(null); };
    displayMode.addEventListener('change', update);
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', complete);
    return () => {
      displayMode.removeEventListener('change', update);
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', complete);
    };
  }, []);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open]);

  const install = async () => {
    if (!prompt || installing) return;
    setInstalling(true);
    setMessage('');
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      setMessage(choice.outcome === 'accepted'
        ? 'Запрос принят. После установки откройте ИКИОМА с новой иконки.'
        : 'Установку можно повторить из меню браузера.');
    } catch {
      setMessage('Откройте меню браузера и выберите «Установить приложение» или «На главный экран».');
    } finally {
      setPrompt(null);
      setInstalling(false);
    }
  };

  if (installed) return null;
  return <>
    <button ref={trigger} type="button" className="app-install-entry" title="Установить приложение" onClick={() => setOpen(true)}><Smartphone size={19} /><span>Установить приложение</span></button>
    {open && createPortal(<Modal title="ИКИОМА на главном экране" onClose={close}>
      <div className="app-install-dialog">
        <div className="app-install-preview"><img src="/brand/icon-180-20261019.png" alt="Иконка ИКИОМА" width="76" height="76" /><div><strong>ИКИОМА</strong><span>Объекты, задачи и деньги</span></div></div>
        <p>Запускайте систему с иконки — в отдельном окне, без адресной строки и панелей браузера.</p>
        {ios ? <ol>
          <li>Откройте эту страницу в Safari. Если ссылка открыта внутри другого приложения, нажмите значок Safari или выберите «Открыть в Safari».</li>
          <li>Нажмите <Share size={16} aria-hidden="true" /> «Поделиться», затем «На экран Домой».</li>
          <li>Если есть переключатель «Открывать как веб-приложение», включите его и нажмите «Добавить».</li>
        </ol> : <>
          {prompt && <button autoFocus type="button" className="button button--primary app-install-action" disabled={installing} onClick={() => void install()}><Download size={18} /> {installing ? 'Открываем установку…' : 'Установить ИКИОМА'}</button>}
          <p>В меню браузера выберите «Установить приложение» или «На главный экран». На компьютере кнопка установки также может находиться справа от адресной строки.</p>
        </>}
        <p className="app-install-note">После добавления откройте новую иконку ИКИОМА. При первом запуске может понадобиться войти в аккаунт.</p>
        {message && <p role="status">{message}</p>}
        <button autoFocus={ios || !prompt} type="button" className="button button--secondary app-install-action" onClick={close}>Понятно</button>
      </div>
    </Modal>, document.body)}
  </>;
}
