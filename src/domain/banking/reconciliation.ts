import type { FinanceEntry, FinanceLedgerState, LedgerOperation, TreasuryState } from '../../entities/index.ts';
import { treasuryPaymentReferences } from '../treasury.js';
import { bankStatementIdentity, type BankStatementPreview, type BankStatementRow } from './statement.ts';

export interface BankReconciliationState { project?: { id: string }; financeEntries: FinanceEntry[]; financeLedger?: FinanceLedgerState; treasury?: TreasuryState }
export type BankRowSelection = { action: 'skip' | 'new' | 'operation' | 'legacy'; operationId?: string; entryId?: string; paymentId?: string };
export interface BankMatch { value: string; label: string; kind: 'operation' | 'legacy'; operationId?: string; entryId?: string; paymentId?: string }
const empty = (): FinanceLedgerState => ({ version: 1, operations: [], confirmations: [], allocationEvents: [], requests: [], retentions: [], loans: [] });
/** The same shared bank account has one identity across projects and local account IDs. */
export function bankIdentityNamespace(state: BankReconciliationState, accountId: string): string {
  const account = state.treasury?.accounts.find(item => item.id === accountId);
  if (!account) throw new Error('Выберите существующий счёт проекта.');
  if (account.sharedAccountKey?.trim()) return `shared:${account.sharedAccountKey.trim()}`;
  if (!state.project?.id) throw new Error('Не определён проект банковской сверки.');
  return `project:${state.project.id}:${accountId}`;
}
export function operationBankDirection(state: BankReconciliationState, operation: LedgerOperation, accountId: string): 'in' | 'out' | null {
  if (operation.kind === 'offset' || operation.cashTreatment === 'participant_direct') return null;
  if (operation.kind === 'transfer') return operation.accountId === accountId ? 'out' : operation.toAccountId === accountId ? 'in' : null;
  if (operation.accountId !== accountId) return null;
  if (['loan_drawdown', 'loan_repayment', 'interest'].includes(operation.kind)) {
    const loan = state.financeLedger?.loans.find(item => item.id === operation.loanId);
    if (!loan) return null;
    return operation.kind === 'loan_drawdown' ? loan.direction === 'borrowed' ? 'in' : 'out' : loan.direction === 'borrowed' ? 'out' : 'in';
  }
  return ['receipt', 'supplier_refund'].includes(operation.kind) ? 'in' : 'out';
}
export function bankOperationMatches(state: BankReconciliationState, operation: LedgerOperation, row: BankStatementRow, accountId: string): boolean {
  return operation.date === row.date && operation.amountCents === row.amountCents && operationBankDirection(state, operation, accountId) === row.direction;
}
export function bankRowMatches(state: BankReconciliationState, row: BankStatementRow, accountId: string): BankMatch[] {
  const ledger = state.financeLedger ?? empty(), results: BankMatch[] = [];
  for (const operation of ledger.operations) if (bankOperationMatches(state, operation, row, accountId)) results.push({ value: `operation:${operation.id}`, kind: 'operation', operationId: operation.id,
    label: `${operation.description} · журнал ${operation.id.slice(-8)}` });
  for (const entry of state.financeEntries) {
    if ((entry.kind === 'income' ? 'in' : 'out') !== row.direction) continue;
    const plan = state.treasury?.entryPlans.find(item => item.entryId === entry.id);
    for (const payment of treasuryPaymentReferences(entry)) {
      if (payment.date !== row.date || payment.amountCents !== row.amountCents) continue;
      const fact = plan?.paymentFacts?.find(item => item.paymentId === payment.id);
      if (fact?.cashTreatment === 'participant_direct' || fact?.accountId && fact.accountId !== accountId) continue;
      if (ledger.operations.some(operation => operation.legacyPayment?.entryId === entry.id && operation.legacyPayment?.paymentId === payment.id)) continue;
      results.push({ value: `legacy:${JSON.stringify([entry.id, payment.id])}`, kind: 'legacy', entryId: entry.id, paymentId: payment.id, label: `${entry.description} · существующая оплата` });
    }
  }
  return results;
}
export function recordedStatementOperation(ledger: FinanceLedgerState | undefined, key: string): LedgerOperation | undefined {
  return ledger?.operations.find(item => item.sourceKey === key)
    ?? ledger?.operations.find(item => ledger.confirmations.some(event => event.sourceKey === key && event.operationId === item.id));
}
/** Builds one atomic journal draft. Original state is never modified; repository policy remains authoritative. */
export function buildBankReconciliation(state: BankReconciliationState, preview: BankStatementPreview, selections: Record<number, BankRowSelection>, options: { accountId: string; fileName: string; fileSha256: string; reason: string }): FinanceLedgerState {
  if (preview.errors.length) throw new Error('Исправьте ошибки выписки до сохранения. Частичный импорт не выполнен.');
  if (!state.treasury?.accounts.some(account => account.id === options.accountId)) throw new Error('Выберите существующий счёт проекта.');
  if (!/^[a-f0-9]{64}$/.test(options.fileSha256) || !options.reason.trim()) throw new Error('Нужны исходный файл и основание сверки.');
  const namespace = bankIdentityNamespace(state, options.accountId);
  const next = structuredClone(state.financeLedger ?? empty()), seen = new Map<string, BankStatementRow>();
  let changes = 0;
  for (const row of preview.rows) {
    const identity = bankStatementIdentity(row, namespace), previousRow = seen.get(identity.key), selection = selections[row.rowNumber];
    if (!selection || !['skip', 'new', 'operation', 'legacy'].includes(selection.action)) throw new Error(`Строка ${row.rowNumber}: выберите допустимое действие.`);
    if (previousRow && (identity.strength === 'composite' || previousRow.date !== row.date || previousRow.amountCents !== row.amountCents || previousRow.direction !== row.direction)) throw new Error(`Строки ${previousRow.rowNumber} и ${row.rowNumber}: неоднозначный идентификатор. Укажите различающиеся банковские ID по исходному документу.`);
    seen.set(identity.key, row);
    const recorded = recordedStatementOperation(next, identity.key);
    if (recorded && !bankOperationMatches({ ...state, financeLedger: next }, recorded, row, options.accountId)) throw new Error(`Строка ${row.rowNumber}: ID уже сохранён с другой датой, суммой или направлением.`);
    if (selection.action === 'skip') continue;
    if (recorded) throw new Error(`Строка ${row.rowNumber}: движение уже связано с журналом. Выберите «Пропустить».`);
    const source = `${options.fileName} · SHA-256 ${options.fileSha256} · строка ${row.rowNumber}. ${options.reason.trim()}`;
    if (selection.action === 'operation') {
      const operation = next.operations.find(item => item.id === selection.operationId);
      if (!operation || !bankOperationMatches({ ...state, financeLedger: next }, operation, row, options.accountId)) throw new Error(`Строка ${row.rowNumber}: выбранная операция не совпадает по счёту, дате, направлению или сумме.`);
      if (operation.sourceKey && operation.accountId === options.accountId || next.confirmations.some(event => event.operationId === operation.id && event.sourceKey && (event.bankAccountId ?? operation.accountId) === options.accountId)) throw new Error(`Строка ${row.rowNumber}: эта сторона операции уже сверена с другим банковским движением. Проверьте повторную оплату.`);
      next.confirmations.push({ id: `confirm-${identity.key}`, operationId: operation.id, confirmation: 'reconciled', source, sourceKey: identity.key, bankDate: row.date, bankAccountId: options.accountId });
    } else if (selection.action === 'legacy') {
      const entry = state.financeEntries.find(item => item.id === selection.entryId), payment = entry && treasuryPaymentReferences(entry).find(item => item.id === selection.paymentId);
      if (!entry || !payment || payment.date !== row.date || payment.amountCents !== row.amountCents || (entry.kind === 'income' ? 'in' : 'out') !== row.direction) throw new Error(`Строка ${row.rowNumber}: существующая оплата не совпадает с выпиской.`);
      if (!bankRowMatches({ ...state, financeLedger: next }, row, options.accountId).some(match => match.kind === 'legacy' && match.entryId === entry.id && match.paymentId === payment.id)) throw new Error(`Строка ${row.rowNumber}: оплата уже сверена либо относится к другому счёту.`);
      next.operations.push({ id: `bank-${identity.key}`, kind: row.direction === 'in' ? 'receipt' : 'payment', date: row.date, amountCents: row.amountCents, accountId: options.accountId,
        counterparty: row.counterparty || entry.counterparty || '', description: row.purpose || entry.description, source, confirmation: 'reconciled', allocations: [],
        legacyPayment: { entryId: entry.id, paymentId: payment.id }, sourceKey: identity.key });
    } else {
      // The user explicitly classifies this as an ordinary receipt/payment. Loans, refunds
      // and transfers must first have their correct journal entry and then be matched.
      next.operations.push({ id: `bank-${identity.key}`, kind: row.direction === 'in' ? 'receipt' : 'payment', date: row.date, amountCents: row.amountCents, accountId: options.accountId,
        counterparty: row.counterparty || 'Не указан в выписке', description: row.purpose || `Банковское движение ${row.documentNumber || row.rowNumber}`, source, confirmation: 'reconciled', allocations: [], sourceKey: identity.key });
    }
    changes++;
  }
  if (!changes) throw new Error('Нет новых операций или сверок. Повторная выписка не меняет деньги.');
  next.changeReason = options.reason.trim();
  return next;
}
