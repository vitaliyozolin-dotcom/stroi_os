import type { AppState, BudgetLine, FinanceEntry } from '../entities/index';

type SourceLine = { id: string; name: string; sourceRow: number; plan: number | null; sourceFact?: number | null; stageIds: string[]; participantAmounts?: Record<string, number | null> };
type RecordInput = { existingOperation?: boolean; vendor: string; vendorInn?: string; number?: string; documentDate?: string; purchaseDate?: string; amount: number; description: string; file: string; dedupKey: string; suggestedBudgetSourceRow?: number | null; suggestedStageId?: string; paymentConfirmation: string; paymentDate?: string | null };
export type HistoryRegister = { format: string; sources: { fileName: string; sha256: string }[]; budgetLines: SourceLine[]; budgetReconciliation: { sourceDisplayedPlan: number; sumOfPlanItems: number }; budgetApproval?: string; existingPaidExpenses?: RecordInput[]; paidInvoices: RecordInput[]; paidLemanaPurchases: RecordInput[] };
const fingerprint = (value: string) => { let result = 2166136261; for (const letter of value) result = Math.imul(result ^ letter.charCodeAt(0), 16777619); return (result >>> 0).toString(16); };
const normalized = (value: string) => value.toLocaleLowerCase().replace(/[\s"«»]/g, '');
const safeName = (value: string) => value.trim().slice(0, 180).replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\s+/g, ' ').trim();
const dateValid = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function parseHistoryRegister(value: unknown): HistoryRegister {
  const input = value as HistoryRegister;
  if (input?.format !== 'IKIOMA-Kelosi-staged-import-v1' || !Array.isArray(input.sources) || !Array.isArray(input.budgetLines) || !Array.isArray(input.paidInvoices) || !Array.isArray(input.paidLemanaPurchases)) throw new Error('Нужен подготовленный реестр импорта.');
  if (input.existingPaidExpenses && (!Array.isArray(input.existingPaidExpenses) || input.existingPaidExpenses.some((item) => item.existingOperation !== true))) throw new Error('Некорректное подтверждение существующих расходов.');
  if (input.budgetApproval !== undefined && (typeof input.budgetApproval !== 'string' || !input.budgetApproval.trim())) throw new Error('Не указано основание утверждения сметы.');
  if (input.sources.length > 100 || input.budgetLines.length > 300 || input.paidInvoices.length + input.paidLemanaPurchases.length + (input.existingPaidExpenses?.length ?? 0) > 500) throw new Error('Слишком большой реестр.');
  for (const source of input.sources) if (!source.fileName || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('Не указан отпечаток исходного документа.');
  const ids = new Set<string>();
  for (const line of input.budgetLines) {
    if (!line.id || ids.has(line.id) || !line.name || !Number.isInteger(line.sourceRow) || !Array.isArray(line.stageIds) || line.plan !== null && (!Number.isFinite(line.plan) || line.plan < 0)) throw new Error('Некорректная статья сметы.');
    ids.add(line.id);
  }
  const keys = new Set<string>();
  for (const item of [...input.paidInvoices, ...input.paidLemanaPurchases, ...(input.existingPaidExpenses ?? [])]) {
    if (!item.vendor || !item.description || !item.dedupKey || keys.has(item.dedupKey) || !item.paymentConfirmation || !Number.isFinite(item.amount) || item.amount <= 0 || !dateValid(item.documentDate ?? item.purchaseDate) || item.paymentDate && !dateValid(item.paymentDate) || !input.sources.some((source) => source.fileName === item.file)) throw new Error('Некорректная или повторяющаяся оплата.');
    keys.add(item.dedupKey);
  }
  return input;
}

export function prepareHistoryImport(current: AppState, input: HistoryRegister, actor: string, now: string, includeBudget: boolean) {
  parseHistoryRegister(input);
  const next = structuredClone(current);
  const records = [...input.paidInvoices, ...input.paidLemanaPurchases, ...(input.existingPaidExpenses ?? [])];
  const matchingDocument = (name: string) => next.documents.find((doc) => doc.fileName === safeName(name) && doc.fileKey?.startsWith(`${current.project.id}/`) && !doc.clientVisible);
  const missing = input.sources.filter((source) => !matchingDocument(source.fileName)).map((source) => source.fileName);
  if (missing.length) throw new Error(`Сначала загрузите документы проекта (без доступа клиенту): ${missing.join('; ')}`);
  for (const source of input.sources) {
    const doc = matchingDocument(source.fileName)!;
    const invoice = input.paidInvoices.find((item) => item.file === source.fileName);
    if (invoice) { doc.documentDate = invoice.documentDate; doc.number = invoice.number; doc.category = 'invoice'; }
    // Preserve known document dates when importing payments; unknown dates stay unknown.
  }
  const sourceBudget = input.sources.find((source) => source.fileName.endsWith('.xlsx')) ?? input.sources[0];
  const budgetChanged = includeBudget && current.budgetMeta.importSourceSha256 !== sourceBudget?.sha256;
  if (budgetChanged) {
    const lines: BudgetLine[] = input.budgetLines.map((line) => ({ id: line.id, name: line.name, stageIds: line.stageIds.filter((id) => next.stages.some((stage) => stage.id === id)), plan: line.plan ?? 0, forecast: line.plan ?? 0, sourceRow: line.sourceRow, sourceFact: line.sourceFact ?? undefined, sourceParticipantAmounts: line.participantAmounts }));
    const total = Math.round(lines.reduce((sum, line) => sum + line.plan, 0) * 100) / 100;
    if (total !== input.budgetReconciliation?.sumOfPlanItems) throw new Error('Сумма статей не совпадает с реестром.');
    const referenced = new Set(next.financeEntries.map((entry) => entry.budgetLineId));
    const legacy = next.budgetLines.filter((line) => referenced.has(line.id) && !lines.some((item) => item.id === line.id)).map((line) => ({ ...line, name: `До импорта · ${line.name}`, plan: 0, forecast: 0 }));
    const previous = next.budgetMeta.importPreviousBudget ?? { lines: structuredClone(current.budgetLines), meta: structuredClone(current.budgetMeta), targetCost: current.project.targetCost, recordedAt: now };
    next.budgetLines = [...lines, ...legacy];
    next.project.targetCost = total;
    next.budgetMeta = { version: 'Рабочая смета', source: sourceBudget?.fileName ?? 'Реестр импорта', importSourceSha256: sourceBudget?.sha256, importedAt: now, note: `Сумма статей: ${total.toLocaleString('ru-RU')} ₽. Итог в исходном файле: ${input.budgetReconciliation.sourceDisplayedPlan.toLocaleString('ru-RU')} ₽. Колонка «Факт» и суммы участников сохранены для сверки; они не являются отдельными оплатами. Даты оплат не заменяются датами счетов.`, importPreviousBudget: previous };
  }
  const approvalChanged = includeBudget && Boolean(input.budgetApproval) && !next.budgetMeta.approvedAt;
  if (approvalChanged) next.budgetMeta = { ...next.budgetMeta, approvedBy: actor, approvedAt: now, note: `${next.budgetMeta.note ?? ''} Утверждение плана: ${input.budgetApproval}` };
  let added = 0, updated = 0, skipped = 0;
  for (const record of records) {
    if (next.financeEntries.some((entry) => entry.historicalPayment?.sourceUniqueKey === record.dedupKey)) { skipped++; continue; }
    if (record.existingOperation) {
      const matches = next.financeEntries.filter((entry) => entry.kind === 'expense' && normalized(entry.counterparty) === normalized(record.vendor) && entry.description === record.description && entry.date === record.documentDate && Math.round(entry.amount * 100) === Math.round(record.amount * 100));
      const entry = matches[0];
      if (matches.length !== 1 || entry.status !== 'committed' || entry.historicalPayment || (entry.paidAmount ?? 0) !== 0 || (entry.acceptedAmount ?? 0) !== 0) throw new Error(`Сначала сверьте существующий расход: ${record.description}.`);
      const doc = matchingDocument(record.file)!, source = input.sources.find((item) => item.fileName === record.file)!;
      entry.status = 'paid'; entry.paidAmount = entry.amount; entry.acceptedAmount = 0;
      entry.paymentDocument = `Подтверждение владельца: ${record.file}`;
      entry.historicalPayment = { existingOperation: true, sourceDocumentId: doc.id, sourceUniqueKey: record.dedupKey, sourceSha256: source.sha256, confirmation: record.paymentConfirmation, sourceDate: entry.date, recordedAt: now, recordedBy: actor };
      updated++; continue;
    }
    const possibleDuplicate = next.financeEntries.find((entry) => entry.kind === 'expense' && Math.round(entry.amount * 100) === Math.round(record.amount * 100) && normalized(entry.counterparty) === normalized(record.vendor));
    if (possibleDuplicate) throw new Error(`Возможный дубль: ${record.vendor}, ${record.amount} ₽. Сначала сверьте существующую операцию.`);
    const doc = matchingDocument(record.file)!;
    const source = input.sources.find((item) => item.fileName === record.file)!;
    let counterparty = next.counterparties.find((item) => record.vendorInn && item.inn === record.vendorInn || normalized(item.name) === normalized(record.vendor));
    if (!counterparty) {
      counterparty = { id: `history-vendor-${fingerprint(record.vendorInn ?? record.vendor)}`, name: record.vendor, inn: record.vendorInn, type: 'supplier', status: 'active' };
      next.counterparties.push(counterparty);
    }
    const line = Number.isInteger(record.suggestedBudgetSourceRow) ? next.budgetLines.find((item) => item.sourceRow === record.suggestedBudgetSourceRow) : undefined;
    const date = record.documentDate ?? record.purchaseDate!;
    const stageId = record.suggestedStageId && next.stages.some((item) => item.id === record.suggestedStageId) ? record.suggestedStageId : line?.stageIds[0];
    doc.counterpartyId = counterparty.id;
    const entry: FinanceEntry = { id: `history-${fingerprint(record.dedupKey)}`, kind: 'expense', status: 'paid', amount: record.amount, paidAmount: record.amount, acceptedAmount: 0, date, counterparty: counterparty.name, counterpartyId: counterparty.id, description: `${record.number ? `Счёт № ${record.number} · ` : 'Лемана Про · '}${record.description}`, document: record.file, paymentDocument: `Оплата подтверждена владельцем; источник: ${record.file}`, budgetLineId: line?.id, stageId, paidAt: record.paymentDate || undefined, createdBy: actor, historicalPayment: { sourceDocumentId: doc.id, sourceUniqueKey: record.dedupKey, sourceSha256: source.sha256, confirmation: record.paymentConfirmation, sourceDate: date, recordedAt: now, recordedBy: actor } };
    next.financeEntries.push(entry);
    added++;
  }
  if (added || updated || budgetChanged || approvalChanged) next.activity.unshift({ id: `history-import-${fingerprint(now)}`, timestamp: now, actor, text: `Импорт исходных документов: ${added} новых оплат, ${updated} существующих расходов подтверждено${budgetChanged ? ' и рабочая смета' : ''}; пропущено дублей: ${skipped}`, tone: 'neutral' });
  return { state: next, added, updated, skipped };
}