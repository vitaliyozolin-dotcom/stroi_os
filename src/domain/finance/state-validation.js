import { ledgerEntryBalance } from '../finance-ledger.js';
import { cents, recordedAcceptedAmount as accepted, recordedPaidAmount as paid, text, validDate, hasFinanceAcceptanceSource } from './policy.js';
import { validateBudgetPlanningChanges } from './planning.js';

// Validate changed facts only: old records remain readable and unrelated saves do
// not rewrite historical amounts. Role filtering occurs before this boundary.
export const validateFinanceChanges = (previous, state, identity, now) => {
  const budgetError = validateBudgetPlanningChanges(previous, state, identity);
  if (budgetError) return budgetError;
  const groups = ['construction', 'overhead', 'reserve', 'unallocated'];
  for (const collection of ['budgetLines', 'financeEntries']) {
    const oldRecords = new Map((previous?.[collection] ?? []).map(row => [row.id, row]));
    for (const row of state[collection] ?? []) {
      const old = oldRecords.get(row.id);
      const changed = row.costGroup !== old?.costGroup;
      if (changed && (identity.role !== 'management' || row.costGroup !== undefined && !groups.includes(row.costGroup)
        || collection === 'financeEntries' && (row.kind !== 'expense' || row.costGroup === 'reserve'))) return 'Категорию расхода меняет управление; резерв не является расходом.';
      row.costGroupHistory = [...(old?.costGroupHistory ?? []), ...(changed ? [{ group: row.costGroup ?? null, at: now, by: identity.name }] : [])];
      if (!row.costGroupHistory.length) delete row.costGroupHistory;
    }
  }
  const oldEntries = new Map((previous?.financeEntries ?? []).map((entry) => [entry.id, entry]));
  const ids = new Set();
  const sourceKeys = new Set();
  for (const entry of state.financeEntries ?? []) {
    if (!entry.id || ids.has(entry.id)) return 'В реестре расходов обнаружены повторяющиеся записи.';
    ids.add(entry.id);
    if (entry.historicalPayment?.sourceUniqueKey) {
      if (sourceKeys.has(entry.historicalPayment.sourceUniqueKey)) return 'Историческая оплата уже присутствует в реестре.';
      sourceKeys.add(entry.historicalPayment.sourceUniqueKey);
    }
    const old = oldEntries.get(entry.id);
    // Events are server-owned, append-only facts. Older clients must reload
    // instead of silently dropping a payment added by another session.
    if (JSON.stringify(entry.payments ?? []) !== JSON.stringify(old?.payments ?? [])) return 'История платежей изменилась. Обновите запись; редактировать или удалять платежи нельзя.';
    if (JSON.stringify(entry.legacyPayment) !== JSON.stringify(old?.legacyPayment)) return 'Исходная накопленная оплата защищена от изменений.';
    if (JSON.stringify(entry.dueDateHistory ?? []) !== JSON.stringify(old?.dueDateHistory ?? [])) return 'Срок платежа обновился. Откройте запись заново; история сроков сохраняется автоматически.';
    const dueDateChanged = entry.dueDate !== old?.dueDate;
    if (dueDateChanged && identity.role !== 'management') return 'Срок платежа меняет только роль «Управление».';
    if (dueDateChanged && entry.dueDate !== undefined && !validDate(entry.dueDate)) return 'Укажите корректную плановую дату платежа.';
    entry.dueDateHistory = [...(old?.dueDateHistory ?? []), ...(dueDateChanged ? [{ date: entry.dueDate ?? null, at: now, by: identity.name }] : [])];
    if (!entry.dueDateHistory.length) delete entry.dueDateHistory;
    if (old && JSON.stringify(old) === JSON.stringify(entry)) continue;
    if (identity.role !== 'management') return 'Финансовые операции доступны только роли «Управление».';
    // Planning/classification may annotate historical records without rewriting facts.
    const withoutAnnotations = ({ costGroup, costGroupHistory, dueDate, dueDateHistory, ...record }) => record;
    if (old && JSON.stringify(withoutAnnotations(old)) === JSON.stringify(withoutAnnotations(entry))) continue;
    if (old?.historicalPayment && !old.budgetLineId && entry.budgetLineId) {
      const withoutAllocation = ({ budgetLineId, budgetAllocation, ...record }) => record;
      if (JSON.stringify(withoutAllocation(old)) === JSON.stringify(withoutAllocation(entry))
        && (state.budgetLines ?? []).some(line => line.id === entry.budgetLineId)) {
        entry.budgetAllocation = { at: now, by: identity.name, budgetLineId: entry.budgetLineId };
        continue;
      }
    }
    if (entry.historicalPayment) {
      const h = entry.historicalPayment;
      if (old && (old.historicalPayment || !h.existingOperation || old.kind !== 'expense' || old.status !== 'committed' || accepted(old) !== 0 || paid(old) !== 0
        || ['kind', 'amount', 'description', 'date', 'counterparty', 'counterpartyId', 'stageId', 'budgetLineId', 'procurementItemId', 'document', 'createdBy', 'approvedAt', 'approvedBy'].some((key) => entry[key] !== old[key]))) return 'Историческую оплату нельзя переписывать. Сохраните исходную запись.';
      if (!old && h.existingOperation) return 'Существующий расход не найден.';
      const doc = (state.documents ?? []).find((item) => item.id === h.sourceDocumentId);
      if (entry.kind !== 'expense' || entry.status !== 'paid' || !Number.isFinite(entry.amount) || entry.amount <= 0
        || entry.paidAmount !== entry.amount || entry.acceptedAmount !== 0
        || entry.acceptedAt || entry.acceptanceSource || entry.acceptanceDocument
        || !validDate(entry.date) || entry.date !== h.sourceDate || entry.paidAt && !validDate(entry.paidAt)
        || !text(entry.paymentDocument) || !text(h.confirmation) || !text(h.sourceUniqueKey) || h.sourceUniqueKey.length > 250
        || !/^[a-f0-9]{64}$/.test(h.sourceSha256 ?? '')
        || !doc?.fileKey?.startsWith(`${state.project.id}/`) || doc.clientVisible !== false) return 'Для исторической оплаты нужны исходный документ, подтверждение владельца и точная сумма; приёмка отдельно.';
      const balance = state.financeLedger || state.treasury ? ledgerEntryBalance(state, entry.id) : null;
      if (balance && (Object.values(balance).some(value => value === null) || balance.overpaidCents > 0 || balance.heldCents > balance.remainingCents)) return 'Историческая оплата превышает остаток обязательства с учётом журнала и удержаний.';
      if (!old) entry.createdBy = identity.name;
      h.recordedAt = now;
      h.recordedBy = identity.name;
      delete entry.paidBy;
      if (!old) { delete entry.approvedAt; delete entry.approvedBy; }
      continue;
    }
    const paidAmount = paid(entry);
    const pays = paidAmount > (old ? paid(old) : 0);
    if (pays && (state.financeLedger?.loans ?? []).some(loan => loan.status !== 'draft' && loan.schedule.some(item => item.kind === 'interest' && item.entryId === entry.id))) return 'Проценты по займу оформляются в финансовом журнале: выберите заём и строку графика.';
    // Legacy paid records remain readable as-is. A new payment must explicitly
    // carry the prior acceptance so status='paid' cannot invent work acceptance.
    if (pays && entry.acceptedAmount == null) entry.acceptedAmount = old ? accepted(old) : 0;
    const acceptedAmount = accepted(entry);
    if (!['expense', 'income'].includes(entry.kind) || !['committed', 'accepted', 'paid'].includes(entry.status)
      || !Number.isFinite(entry.amount) || entry.amount <= 0
      || !Number.isFinite(acceptedAmount) || !Number.isFinite(paidAmount)
      || [entry.amount, acceptedAmount, paidAmount].some(amount => !Number.isSafeInteger(cents(amount)) || Math.abs(amount - cents(amount) / 100) > 0.000001)
      || acceptedAmount < 0 || paidAmount < 0 || cents(acceptedAmount) > cents(entry.amount)
      || !state.financeLedger && !state.treasury && cents(paidAmount) > cents(entry.amount)) return 'Суммы приёмки и оплаты должны быть неотрицательными, с точностью до копеек и не больше обязательства.';
    if (old && (cents(acceptedAmount) < cents(accepted(old)) || cents(paidAmount) < cents(paid(old)))) return 'Нельзя уменьшить ранее записанную приёмку или оплату.';
    const accepts = entry.kind === 'expense' && acceptedAmount > (old ? accepted(old) : 0);
    const approves = !old?.approvedAt && text(entry.approvedAt);
    if (old && (old.approvedAt || accepted(old) > 0 || paid(old) > 0)
      && ['kind', 'amount', 'counterpartyId', 'stageId', 'budgetLineId', 'procurementItemId'].some((key) => entry[key] !== old[key])) return 'После утверждения нельзя менять сумму и связи расхода. Создайте отдельное обязательство.';
    if (approves && entry.kind !== 'expense') return 'Утверждение предусмотрено только для расходов.';
    if (pays && entry.kind === 'expense' && !old?.approvedAt && !approves && !(old && (accepted(old) > 0 || paid(old) > 0))) return 'Сначала утвердите расход.';
    if (accepts && !old?.approvedAt && !approves && !(old && accepted(old) > 0)) return 'Сначала утвердите расход.';
    if (accepts && (!hasFinanceAcceptanceSource(state, entry) || !text(entry.acceptanceDocument) || !validDate(entry.acceptedAt))) return 'Для приёмки нужны принятая работа или поставка, фактическая дата и документ.';
    if (pays && (!text(entry.paymentDocument) || !validDate(entry.paidAt))) return 'Укажите фактическую дату и документ оплаты.';
    for (const [field, changes] of [['acceptanceDocumentId', accepts], ['paymentDocumentId', pays]]) {
      if (!changes && entry[field] !== old?.[field]) return 'Документ связывается с новой приёмкой или оплатой; прошлые основания сохраняются.';
      if (changes && entry[field] !== undefined) {
        const document = (state.documents ?? []).find(item => item.id === entry[field]);
        if (!text(entry[field]) || !document || document.clientVisible !== false
          || !document.fileKey?.startsWith(`${state.project?.id}/`)
          || document.fileKey.split('/').some(part => part === '.' || part === '..')) return 'Документ финансового факта должен содержать приватный файл текущего проекта.';
      }
    }
    if (!old) entry.createdBy = identity.name;
    else if (old.createdBy) entry.createdBy = old.createdBy;
    if (old?.approvedAt) { entry.approvedAt = old.approvedAt; entry.approvedBy = old.approvedBy; }
    else if (approves) { entry.approvedAt = now; entry.approvedBy = identity.name; }
    else { delete entry.approvedAt; delete entry.approvedBy; }
    if (accepts) entry.acceptedBy = identity.name;
    else if (old?.acceptedBy) entry.acceptedBy = old.acceptedBy;
    // Simulate the authoritative append before checking net settlement, so a
    // claimed aggregate cannot swallow the new payment and failed validation
    // never appends a payment event to the candidate.
    if (state.financeLedger || state.treasury) {
      const projectedEntry = pays ? { ...entry,
        ...(!old?.payments?.length && paid(old) > 0 ? { legacyPayment: { amount: paid(old), lastRecordedDate: old.paidAt, document: old.paymentDocument } } : {}),
        payments: [...(old?.payments ?? []), { id: `${entry.id}:payment:${cents(paidAmount)}`, amount: (cents(paidAmount) - cents(old ? paid(old) : 0)) / 100, date: entry.paidAt }],
      } : entry;
      const balance = ledgerEntryBalance({ ...state, financeEntries: state.financeEntries.map(row => row.id === entry.id ? projectedEntry : row) }, entry.id);
      if (!balance || Object.values(balance).some(value => value === null) || balance.settledCents < 0 || balance.cashSettledCents < 0 || balance.overpaidCents > 0) return 'Оплата превышает остаток обязательства с учётом расчётов и возвратов.';
      if (pays && balance.heldCents > balance.remainingCents) return 'Оплата использует удержанную сумму; сначала разрешите удержание.';
    }
    if (pays) {
      entry.paidBy = identity.name;
      if (!old?.payments?.length && paid(old) > 0) entry.legacyPayment = {
        amount: paid(old), lastRecordedDate: old.paidAt, document: old.paymentDocument,
      };
      entry.payments = [...(old?.payments ?? []), {
        id: `${entry.id}:payment:${cents(paidAmount)}`,
        amount: (cents(paidAmount) - cents(old ? paid(old) : 0)) / 100,
        date: entry.paidAt,
        document: entry.paymentDocument.trim(),
        ...(entry.paymentDocumentId ? { documentId: entry.paymentDocumentId } : {}),
        recordedAt: now,
        recordedBy: identity.name,
      }];
    }
    else if (old?.paidBy) entry.paidBy = old.paidBy;
  }
  // Confirmation changes alone can increase net settlement without changing the
  // legacy entry. Preserve old overpayment as history, prohibit new overpayment.
  if (JSON.stringify(previous?.treasury) !== JSON.stringify(state.treasury) || JSON.stringify(previous?.financeLedger) !== JSON.stringify(state.financeLedger)) {
    for (const entry of state.financeEntries ?? []) {
      const balance = ledgerEntryBalance(state, entry.id), prior = previous ? ledgerEntryBalance(previous, entry.id) : null;
      if (!balance || Object.values(balance).some(value => value === null) || balance.settledCents < 0 || balance.cashSettledCents < 0 || balance.overpaidCents > (prior?.overpaidCents ?? 0)) return 'Подтверждение расчёта превышает обязательство или доступный возврат.';
      if (balance.heldCents > balance.remainingCents) return 'Оплата использует удержанную сумму; сначала разрешите удержание.';
    }
  }
  for (const old of oldEntries.values()) {
    if (!ids.has(old.id) && (old.approvedAt || accepted(old) > 0 || paid(old) > 0)) return 'Нельзя удалить утверждённый, принятый или оплаченный расход.';
    const documentIds = new Set([old.acceptanceDocumentId, old.paymentDocumentId, ...(old.payments ?? []).map(payment => payment.documentId)].filter(Boolean));
    for (const documentId of documentIds) {
      const original = (previous?.documents ?? []).find(document => document.id === documentId);
      if (!original?.fileKey) continue;
      const current = (state.documents ?? []).find(document => document.id === documentId);
      if (!current || ['fileKey', 'fileName', 'mimeType', 'sizeBytes', 'uploadedAt', 'clientVisible'].some(field => current[field] !== original[field])) return 'Оригинал документа записанной приёмки или оплаты нельзя удалить или подменить.';
    }
  }
  return '';
};
