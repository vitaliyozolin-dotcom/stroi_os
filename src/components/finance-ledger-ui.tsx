import { useEffect, useRef, cloneElement, type ReactNode, type ReactElement } from 'react';
import type { AppState, FinanceLedgerState, LedgerAllocation, LedgerOperationKind, PaymentRequestStatus } from '../entities/index';
import { Field as BaseField, Modal } from './Ui';
import { money } from '../presentation/formatting';
import { parseBankMoney } from '../domain/banking/statement';

export function LedgerField({ label, children, hint }: { label: string; children: ReactElement; hint?: string }) {
  return <BaseField label={label} hint={hint}>{cloneElement(children as ReactElement<{ 'aria-label'?: string }>, { 'aria-label': label })}</BaseField>;
}
export type LedgerSave = (next: FinanceLedgerState, expected: string) => { ok: boolean; error?: string };
export const ledgerId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const operationLabels: Record<LedgerOperationKind, string> = { payment: 'Оплата поставщику', receipt: 'Поступление от заказчика', supplier_refund: 'Возврат от поставщика', customer_refund: 'Возврат заказчику', offset: 'Неденежный зачёт', loan_drawdown: 'Выдача / получение займа', loan_repayment: 'Возврат тела займа', interest: 'Проценты по займу', transfer: 'Перевод между счетами' };
export const requestLabels: Record<PaymentRequestStatus, string> = { draft: 'Черновик', submitted: 'На согласовании', approved: 'Согласована', scheduled: 'Запланирована', executing: 'Передана на исполнение', partially_paid: 'Оплачена частично', paid: 'Оплачена', rejected: 'Отклонена', canceled: 'Отменена' };
export const confirmationLabels = { claimed: 'Заявлено', confirmed: 'Подтверждено', reconciled: 'Сверено с выпиской' };
export const ledgerAmount = (value: number | null | undefined) => value == null ? 'Нет данных' : money(value / 100);
export const moneyInput = (value: number | undefined) => value === undefined ? '' : `${Math.trunc(value / 100)}${value % 100 ? `.${String(Math.abs(value % 100)).padStart(2, '0')}` : ''}`;
export function requiredCents(value: string, label = 'Сумма', allowZero = false): number {
  const cents = parseBankMoney(value); if (cents === null || cents < 0 || !allowZero && cents === 0) throw new Error(`${label}: укажите ${allowZero ? 'неотрицательную' : 'положительную'} сумму, не более двух знаков после запятой.`); return cents;
}
export function LedgerModal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')], dialog = dialogs.find(item => item.getAttribute('aria-label') === title);
    if (!dialog) return;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex="0"]')].filter(item => item.getClientRects().length);
    controls()[0]?.focus();
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); } else if (event.key === 'Tab') { const items = controls(); if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); } else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); } } };
    dialog.addEventListener('keydown', keyboard); return () => { dialog.removeEventListener('keydown', keyboard); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [title]);
  return <Modal wide title={title} subtitle={subtitle} onClose={onClose}>{children}</Modal>;
}
export interface AllocationDraft { key: string; entryId: string; trancheId: string; retentionId: string; amount: string }
export const allocationDrafts = (allocations: LedgerAllocation[]): AllocationDraft[] => allocations.map(item => ({ key: ledgerId('allocation-row'), entryId: item.entryId, trancheId: item.trancheId || '', retentionId: item.retentionId || '', amount: moneyInput(item.amountCents) }));
export const parseAllocations = (rows: AllocationDraft[]): LedgerAllocation[] => rows.map(row => {
  if (!row.entryId) throw new Error('Выберите обязательство для каждого распределения.');
  return { entryId: row.entryId, amountCents: requiredCents(row.amount, 'Распределение'), ...(row.trancheId ? { trancheId: row.trancheId } : {}), ...(row.retentionId ? { retentionId: row.retentionId } : {}) };
});
export function AllocationEditor({ state, rows, onChange, direction, total }: { state: AppState; rows: AllocationDraft[]; onChange: (rows: AllocationDraft[]) => void; direction?: 'income' | 'expense'; total?: number }) {
  const update = (key: string, change: Partial<AllocationDraft>) => onChange(rows.map(row => row.key === key ? { ...row, ...change } : row));
  const entries = state.financeEntries.filter(entry => !direction || entry.kind === direction);
  const totals = rows.reduce((result, row) => { const entry = state.financeEntries.find(item => item.id === row.entryId), cents = parseBankMoney(row.amount); if (entry && cents !== null) result[entry.kind] += cents; return result; }, { income: 0, expense: 0 });
  return <section className="ledger-allocations"><div className="ledger-section-heading"><strong>Распределение по обязательствам</strong><button type="button" className="text-button" onClick={() => onChange([...rows, { key: ledgerId('allocation-row'), entryId: '', trancheId: '', retentionId: '', amount: '' }])}>Добавить распределение</button></div>
    {!rows.length && <p className="ledger-note">Пока не распределено. Денежный факт сохранится отдельно; привязать его можно после уточнения.</p>}
    {rows.map((row, index) => { const plan = state.treasury?.entryPlans.find(item => item.entryId === row.entryId); const retentions = state.financeLedger?.retentions.filter(item => item.entryId === row.entryId && item.status !== 'canceled') || [];
      return <div className="ledger-allocation-row" key={row.key}><div className="form-grid"><LedgerField label={`Обязательство ${index + 1}`}><select required value={row.entryId} onChange={event => update(row.key, { entryId: event.target.value, trancheId: '', retentionId: '' })}><option value="">Выберите</option>{entries.map(entry => <option value={entry.id} key={entry.id}>{entry.kind === 'expense' ? 'Выплата' : 'Поступление'} · {entry.description}</option>)}</select></LedgerField><LedgerField label="Распределить, ₽"><input required inputMode="decimal" value={row.amount} onChange={event => update(row.key, { amount: event.target.value })} /></LedgerField>
        <LedgerField label="Транш"><select value={row.trancheId} onChange={event => update(row.key, { trancheId: event.target.value, retentionId: '' })}><option value="">Без конкретного транша</option>{plan?.tranches.map((tranche, i) => <option key={tranche.id} value={tranche.id}>Транш {i + 1} · {ledgerAmount(tranche.amountCents)}</option>)}</select></LedgerField>{retentions.length > 0 && <LedgerField label="В счёт удержания"><select value={row.retentionId} onChange={event => update(row.key, { retentionId: event.target.value })}><option value="">Обычный расчёт</option>{retentions.filter(retention => !row.trancheId || retention.trancheId === row.trancheId).map(retention => <option value={retention.id} key={retention.id}>{ledgerAmount(retention.amountCents)} · {retention.status === 'held' ? 'Удерживается' : 'Разрешено к выплате'}</option>)}</select></LedgerField>}</div><button type="button" className="text-button" onClick={() => onChange(rows.filter(item => item.key !== row.key))}>Убрать распределение {index + 1}</button></div>;
    })}
    <p className="ledger-note">Распределено: выплаты {ledgerAmount(totals.expense)}, поступления {ledgerAmount(totals.income)}.{total !== undefined && direction && ` Осталось распределить: ${ledgerAmount(total - totals[direction])}.`}{!direction && ' Для зачёта обе стороны должны равняться сумме операции.'}</p>
  </section>;
}
