/** Canonical payment identity and immutable project shares. No company movement is copied in full. */
export const SHARED_PAYMENT_PREFIX = 'shared-payment:';
const isText = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const positive = value => Number.isSafeInteger(value) && value > 0;
const optional = (value, maximum) => value === undefined || isText(value, maximum);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = value => value?.trim();
export const stableSharedPaymentValue = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sort(value[key])]));
  return value;
}
export function sharedPaymentHash(parts) {
  const input = JSON.stringify(parts); let hash = 14695981039346656037n;
  for (let index = 0; index < input.length; index++) hash = BigInt.asUintN(64, (hash ^ BigInt(input.charCodeAt(index))) * 1099511628211n);
  return hash.toString(16).padStart(16, '0');
}
/** Exactly the existing bank import identity for a bank transaction ID on a shared account. */
export const sharedPaymentBankKey = (sharedAccountKey, externalId) => `statement-v1:${sharedPaymentHash(['bank-id', `shared:${sharedAccountKey.trim()}`, externalId.trim()])}`;
export const sharedPaymentDocumentKey = (scope, reference) => `shared-document-v1:${sharedPaymentHash([scope.trim(), reference.trim()])}`;
export const sharedPaymentOperationId = (paymentId, projectId) => `${SHARED_PAYMENT_PREFIX}${paymentId}:${sharedPaymentHash([projectId])}`;
export function sharedPaymentInputError(input) {
  if (!record(input) || !isText(input.id, 100) || !/^[a-zA-Z0-9._:-]+$/.test(input.id)
    || !isText(input.sourceKey, 500) || !['payment', 'receipt'].includes(input.kind)
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') || !positive(input.amountCents) || input.currency !== 'RUB'
    || !isText(input.legalEntityId, 200) || !isText(input.payer, 500) || !isText(input.payee, 500)
    || !isText(input.description, 2000) || !isText(input.source, 4000) || !optional(input.sourceReference, 500)
    || !['confirmed', 'reconciled'].includes(input.confirmation)
    || !['account', 'participant_direct'].includes(input.cashTreatment ?? 'account')) return 'Проверьте дату, сумму в копейках, фактических плательщика и получателя, юрлицо и основание платежа.';
  const direct = input.cashTreatment === 'participant_direct';
  if ((!direct && (!isText(input.sharedAccountKey, 120) || !/^[a-zA-Z0-9._:-]+$/.test(input.sharedAccountKey)))
    || direct && (input.sharedAccountKey || input.confirmation === 'reconciled' || input.bankEvidence)) return 'Укажите один общий счёт компании либо явный прямой расчёт участника без движения по счетам компании.';
  if (input.bankEvidence !== undefined && (!record(input.bankEvidence) || !isText(input.bankEvidence.projectId, 100)
    || !isText(input.bankEvidence.documentId, 200) || !isText(input.bankEvidence.externalId, 500) || !isText(input.bankEvidence.source, 2000))) return 'Для банковского подтверждения укажите оригинал выписки и уникальный ID банковской операции.';
  if (input.confirmation === 'reconciled' && !input.bankEvidence) return 'Банковская сверка требует оригинала выписки и ID операции; подтверждение участником записывается отдельно.';
  if (input.bankEvidence && input.sourceKey !== sharedPaymentBankKey(input.sharedAccountKey, input.bankEvidence.externalId)) return 'Ключ платежа должен совпадать с уникальным ID операции в банковском импорте.';
  if (!Array.isArray(input.allocations) || !input.allocations.length || input.allocations.length > 500
    || input.allocations.some(row => !record(row) || !isText(row.projectId, 100) || !positive(row.amountCents)
      || !optional(row.entryId, 200) || !optional(row.trancheId, 200) || !optional(row.retentionId, 200)
      || (!row.entryId && (row.trancheId || row.retentionId)) || (direct ? Boolean(row.accountId) : !isText(row.accountId, 200)))) return 'У каждой доли должны быть заказ, счёт и положительная сумма; транш и удержание требуют обязательства.';
  const projects = new Set(input.allocations.map(row => row.projectId));
  if (projects.size < 2 || projects.size > 100) return 'Общий платёж распределяется минимум между двумя заказами.';
  const total = input.allocations.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
  if (total !== BigInt(input.amountCents)) return 'Сумма всех долей должна точно совпадать с исходным платежом. Остаток внутри заказа можно оставить без обязательства.';
  if (!Array.isArray(input.expected) || input.expected.length !== projects.size || input.expected.some(row => !record(row) || !projects.has(row.projectId) || !Number.isSafeInteger(row.revision) || row.revision < 1)
    || new Set(input.expected.map(row => row.projectId)).size !== projects.size) return 'Для каждого затронутого заказа нужна актуальная версия данных.';
  if (input.bankEvidence && !projects.has(input.bankEvidence.projectId)) return 'Банковское основание должно находиться в одном из затронутых заказов.';
  const accounts = new Map();
  for (const row of input.allocations) { if (accounts.has(row.projectId) && accounts.get(row.projectId) !== row.accountId) return 'Один заказ использует одну проекцию выбранного общего счёта.'; accounts.set(row.projectId, row.accountId); }
  return '';
}
/** Validated input without volatile expected revisions; reordered rows are the same intent. */
export function normalizeSharedPaymentInput(input) {
  const direct = input.cashTreatment === 'participant_direct';
  const rows = input.allocations.map(row => ({ projectId: clean(row.projectId), ...(direct ? {} : { accountId: clean(row.accountId) }),
    ...(row.entryId ? { entryId: clean(row.entryId) } : {}), ...(row.trancheId ? { trancheId: clean(row.trancheId) } : {}),
    ...(row.retentionId ? { retentionId: clean(row.retentionId) } : {}), amountCents: row.amountCents }));
  rows.sort((a, b) => stableSharedPaymentValue(a).localeCompare(stableSharedPaymentValue(b)));
  return { id: input.id, sourceKey: clean(input.sourceKey), kind: input.kind, date: input.date, amountCents: input.amountCents,
    currency: 'RUB', legalEntityId: clean(input.legalEntityId), ...(direct ? {} : { sharedAccountKey: clean(input.sharedAccountKey) }),
    payer: clean(input.payer), payee: clean(input.payee), description: clean(input.description), source: clean(input.source),
    ...(input.sourceReference ? { sourceReference: clean(input.sourceReference) } : {}), confirmation: input.confirmation,
    cashTreatment: direct ? 'participant_direct' : 'account', allocations: rows,
    ...(input.bankEvidence ? { bankEvidence: { projectId: clean(input.bankEvidence.projectId), documentId: clean(input.bankEvidence.documentId), externalId: clean(input.bankEvidence.externalId), source: clean(input.bankEvidence.source) } } : {}) };
}
export function buildSharedPaymentShares(input) {
  const groups = new Map();
  for (const row of input.allocations) { const group = groups.get(row.projectId) ?? []; group.push(row); groups.set(row.projectId, group); }
  return [...groups].map(([projectId, rows]) => {
    const amountCents = rows.reduce((sum, row) => sum + row.amountCents, 0);
    const operation = { id: sharedPaymentOperationId(input.id, projectId), kind: input.kind, date: input.date, amountCents,
      ...(input.cashTreatment === 'participant_direct' ? {} : { accountId: rows[0].accountId }), cashTreatment: input.cashTreatment,
      counterparty: input.kind === 'payment' ? input.payee : input.payer, actualPayer: input.payer, actualPayee: input.payee,
      description: input.description, source: input.source, confirmation: input.confirmation,
      sharedPaymentId: input.id, sharedPaymentSourceKey: input.sourceKey,
      allocations: rows.filter(row => row.entryId).map(({ entryId, trancheId, retentionId, amountCents: amount }) => ({ entryId,
        ...(trancheId ? { trancheId } : {}), ...(retentionId ? { retentionId } : {}), amountCents: amount })),
      ...(input.bankEvidence?.projectId === projectId ? { documentId: input.bankEvidence.documentId } : {}) };
    return { projectId, operationId: operation.id, amountCents, ...(rows[0].accountId ? { accountId: rows[0].accountId } : {}), operation };
  });
}
export const isSharedPaymentOperation = operation => Boolean(operation && (Object.hasOwn(operation, 'sharedPaymentId') || Object.hasOwn(operation, 'sharedPaymentSourceKey') || operation.id?.startsWith?.(SHARED_PAYMENT_PREFIX)));
export const sharedPaymentEvidenceFingerprint = document => stableSharedPaymentValue(Object.fromEntries(Object.entries(document ?? {}).filter(([key]) => !['name', 'note', 'notes'].includes(key))));
