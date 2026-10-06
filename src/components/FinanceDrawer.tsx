import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function FinanceDrawer({ title, subtitle, children, onClose }: {
  title: string; subtitle?: string; children: ReactNode; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    const cancel = (event: Event) => { event.preventDefault(); closeRef.current(); };
    dialog?.addEventListener('cancel', cancel);
    return () => {
      dialog?.removeEventListener('cancel', cancel);
      dialog?.close();
      if (focused?.isConnected) focused.focus();
    };
  }, []);
  return <dialog ref={ref} className="finance-drawer" aria-label={title} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <header className="finance-drawer__header"><div>{subtitle && <span>{subtitle}</span>}<h2>{title}</h2></div><button type="button" className="finance-icon-button" aria-label="Закрыть" onClick={onClose}><X size={22} /></button></header>
    <div className="finance-drawer__body">{children}</div>
  </dialog>;
}
