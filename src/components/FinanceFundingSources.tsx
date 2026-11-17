import { FinanceFundingEditor } from './FinanceFundingEditor';
import type { StateChangeSink } from '../application';
import type { AppState, UserRole } from '../entities/index';
import { money } from '../presentation/formatting';
import { financeWorkspaceSummary } from '../domain/finance-workspace.js';
import { financeToday } from '../presentation/finance-view';

const status = { draft: 'Условия уточняются', submitted: 'Заявка подана', approved: 'Кредит одобрен', rejected: 'Отказ', funded: 'Выдача кредита зафиксирована', canceled: 'Отменён' };
export function FinanceFundingSources({ state, role, onChange, onOpenCustomer, onOpenLedger }: { state: AppState; role: UserRole; onChange: StateChangeSink; onOpenCustomer: () => void; onOpenLedger: () => void }) {
  const mortgages = (state.orderRelations?.mortgages ?? []).filter(row => row.status !== 'canceled');
  const summary = financeWorkspaceSummary(state, financeToday());
  const accounts = (state.treasury?.accounts ?? []).filter(account => account.id !== state.project.funding?.escrowAccountId);
  return <><FinanceFundingEditor state={state} role={role} onChange={onChange} /><section className="finance-funding-sources" aria-label="Два источника финансирования">
    <article><span className="finance-eyebrow">Оплата договора</span><h3>Средства заказчика</h3>
      {!mortgages.length ? <p>Схема оплаты пока не зафиксирована в карточке заказа.</p> : mortgages.map(row => <div className="finance-funding-source" key={row.id}><strong>{row.program || 'Программа не указана'}</strong><span>{status[row.status]}{row.fundingRoute === 'escrow' ? ' · через эскроу' : row.fundingRoute === 'direct' ? ' · прямой расчёт' : ''}</span><dl><div><dt>Одобрено</dt><dd>{row.approvedAmountCents === undefined ? 'Не указано' : money(row.approvedAmountCents / 100)}</dd></div><div><dt>Первоначальный взнос</dt><dd>{row.downPaymentCents === undefined ? 'Не указан' : money(row.downPaymentCents / 100)}</dd></div></dl>{row.fundingRoute === 'escrow' && <small>Одобрение и выдача кредита не подтверждают наполнение или раскрытие эскроу.</small>}</div>)}
      <button type="button" className="text-button" onClick={onOpenCustomer}>Условия сделки и документы →</button>
    </article>
    <article><span className="finance-eyebrow">На что строим сейчас</span><h3>Деньги подрядчика</h3><strong className="finance-funding-total">{summary.availableCashCents === null ? 'Остаток не подтверждён' : money(summary.availableCashCents / 100)}</strong><p>Только подтверждённые средства, выделенные этому объекту.</p>
      {accounts.map(account => <div className="finance-funding-source" key={account.id}><strong>{account.name}</strong><span>{account.isProjectDedicated ? 'Счёт объекта' : account.projectAllocationCents === undefined ? 'Доля проекта не назначена' : `Доля проекта: ${money(account.projectAllocationCents / 100)}`}{account.restrictedCents ? ` · ограничено ${money(account.restrictedCents / 100)}` : ''}</span></div>)}
      <button type="button" className="text-button" onClick={onOpenLedger}>Займы, расчёты и возврат финансирования →</button>
    </article>
    <p className="finance-funding-note">Эскроу не входит в доступные деньги стройки. Остатки, ограничения и даты получения средств уточняются ниже.</p>
  </section></>;
}
