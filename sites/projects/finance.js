const cents = (value) => Math.round(value * 100);
const accepted = (entry) => entry?.acceptedAmount ?? (['accepted', 'paid'].includes(entry?.status) ? entry.amount : 0);
const paid = (entry) => entry?.paidAmount ?? (entry?.status === 'paid' ? entry.amount : 0);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export const hasFinanceAcceptanceSource = (state, entry) => {
  if (!entry.stageId || !text(entry.acceptanceSource)) return false;
  const [type, ...parts] = entry.acceptanceSource.split(':');
  const id = parts.join(':');
  if (entry.procurementItemId && (type !== 'procurement' || id !== entry.procurementItemId)) return false;
  if (type === 'procurement') return (state.procurement ?? []).some((item) => item.id === id && item.stageId === entry.stageId
    && (entry.procurementItemId || (entry.counterpartyId && item.supplierId === entry.counterpartyId))
    && (!entry.counterpartyId || !item.supplierId || item.supplierId === entry.counterpartyId)
    && ['accepted', 'issued'].includes(item.status));
  if (type === 'checkpoint') return (state.checkpoints ?? []).some((item) => item.id === id && item.stageId === entry.stageId && item.status === 'accepted');
  return type === 'stage' && id === entry.stageId && (state.stages ?? []).some((item) => item.id === id && item.status === 'accepted');
};

// Validate changed facts only: old records remain readable and unrelated saves do
// not rewrite historical amounts. Role filtering occurs before this boundary.
export const validateFinanceChanges = (previous, state, identity, now) => {
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
    if (old && JSON.stringify(old) === JSON.stringify(entry)) continue;
    if (identity.role !== 'management') return 'Финансовые операции доступны только роли «Управление».';
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
      if (!old) entry.createdBy = identity.name;
      h.recordedAt = now;
      h.recordedBy = identity.name;
      delete entry.paidBy;
      if (!old) { delete entry.approvedAt; delete entry.approvedBy; }
      continue;
    }
    const acceptedAmount = accepted(entry);
    const paidAmount = paid(entry);
    if (!['expense', 'income'].includes(entry.kind) || !['committed', 'accepted', 'paid'].includes(entry.status)
      || !Number.isFinite(entry.amount) || entry.amount <= 0
      || !Number.isFinite(acceptedAmount) || !Number.isFinite(paidAmount)
      || acceptedAmount < 0 || paidAmount < 0 || cents(acceptedAmount) > cents(entry.amount)
      || cents(paidAmount) > cents(entry.kind === 'expense' ? acceptedAmount : entry.amount)) return 'Суммы должны соответствовать правилу: оплачено ≤ принято ≤ обязательство.';
    if (old && (cents(acceptedAmount) < cents(accepted(old)) || cents(paidAmount) < cents(paid(old)))) return 'Нельзя уменьшить ранее записанную приёмку или оплату.';
    const accepts = entry.kind === 'expense' && acceptedAmount > (old ? accepted(old) : 0);
    const pays = paidAmount > (old ? paid(old) : 0);
    const approves = !old?.approvedAt && text(entry.approvedAt);
    if (old && (old.approvedAt || accepted(old) > 0 || paid(old) > 0)
      && ['kind', 'amount', 'counterpartyId', 'stageId', 'budgetLineId', 'procurementItemId'].some((key) => entry[key] !== old[key])) return 'После утверждения нельзя менять сумму и связи расхода. Создайте отдельное обязательство.';
    if (approves && entry.kind !== 'expense') return 'Утверждение предусмотрено только для расходов.';
    if (accepts && !old?.approvedAt && !approves && !(old && accepted(old) > 0)) return 'Сначала утвердите расход.';
    if (accepts && (!hasFinanceAcceptanceSource(state, entry) || !text(entry.acceptanceDocument) || !validDate(entry.acceptedAt))) return 'Для приёмки нужны принятая работа или поставка, фактическая дата и документ.';
    if (pays && (!text(entry.paymentDocument) || !validDate(entry.paidAt))) return 'Укажите фактическую дату и документ оплаты.';
    if (!old) entry.createdBy = identity.name;
    else if (old.createdBy) entry.createdBy = old.createdBy;
    if (old?.approvedAt) { entry.approvedAt = old.approvedAt; entry.approvedBy = old.approvedBy; }
    else if (approves) { entry.approvedAt = now; entry.approvedBy = identity.name; }
    else { delete entry.approvedAt; delete entry.approvedBy; }
    if (accepts) entry.acceptedBy = identity.name;
    else if (old?.acceptedBy) entry.acceptedBy = old.acceptedBy;
    if (pays) entry.paidBy = identity.name;
    else if (old?.paidBy) entry.paidBy = old.paidBy;
  }
  for (const old of oldEntries.values()) {
    if (!ids.has(old.id) && (old.approvedAt || accepted(old) > 0 || paid(old) > 0)) return 'Нельзя удалить утверждённый, принятый или оплаченный расход.';
  }
  return '';
};
