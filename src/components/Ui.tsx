import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = 'default',
  onClick,
}: {
  label: string;
  value: string;
  detail: ReactNode;
  icon: IconType;
  tone?: 'default' | 'positive' | 'warning' | 'dark';
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="metric-card__top">
        <span>{label}</span>
        <span className="metric-card__icon"><Icon size={18} /></span>
      </div>
      <strong>{value}</strong>
      <div className="metric-card__detail">{detail}</div>
    </>
  );
  if (onClick) return <button type="button" className={`metric-card metric-card--${tone} metric-card--clickable`} onClick={onClick}>{content}</button>;
  return <article className={`metric-card metric-card--${tone}`}>{content}</article>;
}

export function ProgressBar({ value, tone = 'green', label }: { value: number; tone?: 'green' | 'orange' | 'red' | 'blue'; label?: string }) {
  const safeValue = Math.min(100, Math.max(0, value));
  return (
    <div className="progress-wrap" aria-label={label ?? `${safeValue}%`}>
      <div className={`progress-bar progress-bar--${tone}`} style={{ width: `${safeValue}%` }} />
    </div>
  );
}

export function StatusBadge({ label, tone = 'neutral', dot = true }: { label: string; tone?: 'neutral' | 'positive' | 'warning' | 'danger' | 'blue'; dot?: boolean }) {
  return (
    <span className={`status-badge status-badge--${tone}`}>
      {dot && <span className="status-badge__dot" />}
      {label}
    </span>
  );
}

export function SectionHeader({ title, eyebrow, action }: { title: string; eyebrow?: string; action?: ReactNode }) {
  return (
    <div className="section-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}

// Shared by overlapping dialogs so closing one does not unlock the background.
let openModalCount = 0;
let previousBodyOverflow = '';

export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement;
    dialog.showModal();
    if (openModalCount++ === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    return () => {
      dialog.close();
      if (--openModalCount === 0) document.body.style.overflow = previousBodyOverflow;
      queueMicrotask(() => {
        if (previous instanceof HTMLElement && previous.isConnected && !document.querySelector('dialog:modal')) previous.focus();
      });
    };
  }, []);

  return createPortal(
    <dialog ref={dialogRef} className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => {
      if (event.key !== 'Tab') return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])')].filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} onCancel={(event) => { event.preventDefault(); onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); onClose(); } }}>
      <section className={`modal ${wide ? 'modal--wide' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
        </div>
        {children}
      </section>
    </dialog>,
    document.body,
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function EmptyState({ icon: Icon, title, text }: { icon: IconType; title: string; text: string }) {
  return (
    <div className="empty-state">
      <span><Icon size={24} /></span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
