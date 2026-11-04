import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Field, Modal } from '../Ui';

export interface OrderEditorOption { value: string; label: string; disabled?: boolean }
export interface OrderEditorField {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'select' | 'date' | 'email' | 'tel' | 'money' | 'number' | 'checkbox' | 'multi';
  required?: boolean;
  hint?: string;
  placeholder?: string;
  options?: OrderEditorOption[];
  disabled?: boolean;
  disabledWhen?: (values: OrderEditorValues) => boolean;
  valueFrom?: (values: OrderEditorValues) => string | undefined;
  fullWidth?: boolean;
  min?: number;
  max?: number;
  step?: string;
  maxLength?: number;
}

export type OrderEditorValues = Record<string, string>;

export function OrderEditorModal({
  title, subtitle, fields, initialValues, submitLabel = 'Сохранить', summary, renderHint, onSubmit, onClose,
}: {
  title: string;
  subtitle?: string;
  fields: OrderEditorField[];
  initialValues: OrderEditorValues;
  submitLabel?: string;
  summary?: ReactNode;
  renderHint?: (values: OrderEditorValues) => ReactNode;
  onSubmit: (values: OrderEditorValues) => void | Promise<void>;
  onClose: () => void;
}) {
  const [values, setValues] = useState<OrderEditorValues>(() => ({ ...initialValues }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const busyRef = useRef(false);
  const closeRef = useRef(onClose);
  const mounted = useRef(true);
  closeRef.current = onClose;

  useEffect(() => {
    mounted.current = true;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = formRef.current?.closest<HTMLElement>('[role="dialog"]');
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])]
      .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
    formRef.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key !== 'Tab') return;
      const elements = focusable(), first = elements[0], last = elements.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog?.addEventListener('keydown', onKeyDown);
    return () => {
      mounted.current = false;
      dialog?.removeEventListener('keydown', onKeyDown);
      if (before?.isConnected) before.focus();
    };
  }, []);

  const update = (name: string, value: string) => setValues(previous => ({ ...previous, [name]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true; setPending(true); setError('');
    try { await onSubmit(values); }
    catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Не удалось сохранить изменения. Повторите попытку.');
    } finally {
      busyRef.current = false;
      if (mounted.current) setPending(false);
    }
  };

  return <Modal wide title={title} subtitle={subtitle} onClose={() => { if (!busyRef.current) onClose(); }}>
    <form ref={formRef} className="modal-form customer-order-editor" onSubmit={submit} aria-busy={pending}>
      {summary}
      {error ? <p role="alert" className="customer-orders__error">{error}</p> : null}
      <div className="customer-order-editor__grid">
        {fields.map(field => {
          const value = field.valueFrom?.(values) ?? values[field.name] ?? '', disabled = pending || field.disabled || field.disabledWhen?.(values);
          const common = { disabled, required: field.required, name: field.name };
          let input: ReactNode;
          if (field.type === 'select') {
            input = <select {...common} value={value} onChange={event => update(field.name, event.target.value)}>
              <option value="">{field.required ? 'Выберите…' : 'Не указано'}</option>
              {(field.options ?? []).map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
            </select>;
          } else if (field.type === 'textarea') {
            input = <textarea {...common} rows={3} value={value} maxLength={field.maxLength ?? 4000} placeholder={field.placeholder} onChange={event => update(field.name, event.target.value)} />;
          } else if (field.type === 'checkbox') {
            input = <input {...common} type="checkbox" checked={value === 'true'} onChange={event => update(field.name, event.target.checked ? 'true' : '')} />;
          } else if (field.type === 'multi') {
            const selected = new Set(value.split('|').filter(Boolean));
            input = <select {...common} multiple size={Math.min(6, Math.max(2, field.options?.length ?? 2))} value={[...selected]} onChange={event => update(field.name, [...event.target.selectedOptions].map(option => option.value).join('|'))}>
              {(field.options ?? []).map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
            </select>;
          } else {
            input = <input {...common} type={field.type === 'money' ? 'text' : field.type ?? 'text'} inputMode={field.type === 'money' || field.type === 'number' ? 'decimal' : undefined}
              value={value} min={field.min} max={field.max} step={field.step ?? (field.type === 'number' ? 'any' : undefined)} maxLength={field.maxLength ?? 1000}
              placeholder={field.placeholder} autoComplete="off" onChange={event => update(field.name, event.target.value)} />;
          }
          return <div key={field.name} className={field.fullWidth || field.type === 'textarea' || field.type === 'multi' ? 'customer-order-editor__wide' : ''}>
            <Field label={field.label} hint={field.hint}>{input}</Field>
          </div>;
        })}
      </div>
      {renderHint?.(values)}
      <div className="modal__actions">
        <button type="button" className="button button--ghost" disabled={pending} onClick={onClose}>Отмена</button>
        <button type="submit" className="button button--primary" disabled={pending}>{pending ? 'Сохраняем…' : submitLabel}</button>
      </div>
    </form>
  </Modal>;
}
