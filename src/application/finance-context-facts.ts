import type { ProjectDocument } from '../entities/index';
import { approveExpenseEntry, acceptExpenseEntry, recordPaymentEntry, recordReceiptEntry, type FinanceAcceptanceContext, type FinanceEntryResult, type FinanceFactInput, type FinancePlanningSnapshot } from '../domain/finance/index.js';
import type { FinanceCommandContext } from './finance-context';
import { financeOwnedSnapshot, type FinancePlanningChange } from './finance-context-planning.ts';
import { validUploadedDocumentFile, type UploadedDocumentFile } from '../domain/document-records.js';
export type { UploadedDocumentFile } from '../domain/document-records.js';

export interface FinanceFactsSnapshot extends FinancePlanningSnapshot, FinanceAcceptanceContext { projectCode: string; documents?: ProjectDocument[] }
export interface FinanceFactsChange extends FinancePlanningChange { expectedReferences: string; appendDocument?: ProjectDocument; expectedDocument?: { id: string; value: string }; attachmentOnly?: boolean }
export type FinanceFactsCommandResult = { ok: true; change: FinanceFactsChange | null } | { ok: false; error: string };
export const financeAcceptanceSnapshot = (state: FinanceAcceptanceContext) => JSON.stringify([state.procurement, state.checkpoints, state.stages]);

/** Text is an explanation; only an uploaded file or existing private document is file evidence. */
export type FactCommand = FinanceFactInput & { entryId: string; uploadedFile?: UploadedDocumentFile };
export interface AttachFinanceDocumentCommand {
  entryId: string; category: 'invoice' | 'other'; document?: string;
  uploadedFile?: UploadedDocumentFile; documentId?: string;
}
const missingEntry = (): FinanceFactsCommandResult => ({ ok: false, error: 'Финансовая операция не найдена. Обновите список.' });
const money = (value: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
const resolveEvidence = (state: FinanceFactsSnapshot, input: { uploadedFile?: UploadedDocumentFile; documentId?: string }, required = false): { ok: true; reference?: ProjectDocument } | { ok: false; error: string } => {
  if (input.documentId && input.uploadedFile) return { ok: false, error: 'Выберите существующий документ или загрузите новый файл.' };
  if (required && !input.documentId && !input.uploadedFile) return { ok: false, error: 'Загрузите файл счёта или выберите существующий документ.' };
  if (input.uploadedFile && !validUploadedDocumentFile(state.projectId, input.uploadedFile)) return { ok: false, error: 'Файл не загружен в текущий проект. Загрузите документ заново.' };
  const reference = input.documentId ? state.documents?.find(document => document.id === input.documentId) : undefined;
  if (input.documentId && (!reference || reference.clientVisible !== false || !reference.fileKey?.startsWith(`${state.projectId}/`) || reference.fileKey.split('/').some(part => part === '.' || part === '..'))) return { ok: false, error: 'Выберите доступный приватный документ с загруженным файлом в текущем проекте.' };
  return { ok: true, reference };
};

const finish = (state: FinanceFactsSnapshot, result: FinanceEntryResult, context: FinanceCommandContext, timestamp: string, action: string, summary: string, document?: ProjectDocument, reference?: ProjectDocument): FinanceFactsCommandResult => {
  if (!result.ok) return result;
  if (!result.changed) return { ok: true, change: null };
  return { ok: true, change: {
    projectId: state.projectId, expectedFinance: financeOwnedSnapshot(state),
    expectedReferences: financeAcceptanceSnapshot(state),
    action, summary,
    patch: { financeEntries: state.financeEntries.map(entry => entry.id === result.entry.id ? result.entry : entry) },
    appendDocument: document,
    ...(reference ? { expectedDocument: { id: reference.id, value: JSON.stringify(reference) } } : {}),
    event: { id: context.ids.next('activity'), timestamp, actor: context.identity.name, text: summary, tone: action === 'expense_accepted' ? 'neutral' : 'positive' },
  } };
};

export const approveFinanceExpense = (state: FinanceFactsSnapshot, entryId: string, context: FinanceCommandContext): FinanceFactsCommandResult => {
  const entry = state.financeEntries.find(item => item.id === entryId);
  if (!entry) return missingEntry();
  const timestamp = context.clock.now();
  return finish(state, approveExpenseEntry(entry, context.identity, timestamp), context, timestamp,
    'expense_approved', `Утверждён расход ${money(entry.amount)} · ${entry.description}`);
};

/** Attach a source invoice before any approval, acceptance or payment exists. */
export const attachFinanceDocument = (state: FinanceFactsSnapshot, input: AttachFinanceDocumentCommand, context: FinanceCommandContext): FinanceFactsCommandResult => {
  if (context.identity.role !== 'management') return { ok: false, error: 'Финансовые документы прикрепляет только роль «Управление».' };
  const entry = state.financeEntries.find(item => item.id === input.entryId);
  if (!entry) return missingEntry();
  if (!['invoice', 'other'].includes(input.category) || input.document !== undefined && (typeof input.document !== 'string' || input.document.trim().length > 500)) return { ok: false, error: 'Выберите тип документа и название до 500 символов.' };
  const evidence = resolveEvidence(state, input, true);
  if (!evidence.ok) return evidence;
  const reference = evidence.reference, file = input.uploadedFile;
  const fileKey = file?.key ?? reference!.fileKey;
  if (state.documents?.some(document => document.financeEntryId === entry.id && document.fileKey === fileKey)) return { ok: true, change: null };
  const timestamp = context.clock.now();
  const document: ProjectDocument = {
    id: context.ids.next('document'), name: input.document?.trim() || reference?.name || file!.name,
    type: input.category === 'invoice' ? 'Счёт' : 'Прочее', category: input.category,
    updatedAt: timestamp, clientVisible: false, status: 'current',
    direction: entry.kind === 'expense' ? 'incoming' : 'outgoing',
    counterpartyId: entry.counterpartyId, stageId: entry.stageId, financeEntryId: entry.id,
    documentDate: reference?.documentDate, number: reference?.number,
    receivedAt: entry.kind === 'expense' ? timestamp : undefined,
    sentAt: entry.kind === 'income' ? timestamp : undefined,
    storageLocation: `ИКИОМА ОС / ${state.projectCode} / Финансы`,
    fileKey, fileName: file?.name ?? reference?.fileName, mimeType: file?.type ?? reference?.mimeType,
    sizeBytes: file?.size ?? reference?.sizeBytes, uploadedAt: file?.uploadedAt ?? reference?.uploadedAt,
    uploadedBy: file ? context.identity.name : reference?.uploadedBy,
  };
  const summary = `Прикреплён ${input.category === 'invoice' ? 'счёт' : 'документ'} · ${entry.description}`;
  return { ok: true, change: {
    projectId: state.projectId, expectedFinance: financeOwnedSnapshot(state), expectedReferences: financeAcceptanceSnapshot(state),
    action: 'finance_document_attached', summary, patch: {}, appendDocument: document, attachmentOnly: true,
    ...(reference ? { expectedDocument: { id: reference.id, value: JSON.stringify(reference) } } : {}),
    event: { id: context.ids.next('activity'), timestamp, actor: context.identity.name, text: summary, tone: 'neutral' },
  } };
};

const recordFact = (state: FinanceFactsSnapshot, input: FactCommand, context: FinanceCommandContext, kind: 'accept' | 'pay' | 'receive'): FinanceFactsCommandResult => {
  const entry = state.financeEntries.find(item => item.id === input.entryId);
  if (!entry) return missingEntry();
  const transition = kind === 'accept' ? acceptExpenseEntry : kind === 'pay' ? recordPaymentEntry : recordReceiptEntry;
  const result = transition(state, entry, input, context.identity);
  if (!result.ok) return result;
  const evidence = resolveEvidence(state, input);
  if (!evidence.ok) return evidence;
  const reference = evidence.reference;
  const timestamp = context.clock.now();
  const file = input.uploadedFile;
  const document: ProjectDocument | undefined = reference ? undefined : {
    id: context.ids.next('document'), name: input.document.trim(),
    type: file ? kind === 'accept' ? 'Акт / приёмка' : 'Платёжный документ' : 'Текстовое основание (без файла)', category: kind === 'accept' ? 'act' : 'other',
    documentDate: input.date, updatedAt: timestamp, clientVisible: false, status: 'current',
    direction: kind === 'pay' ? 'outgoing' : 'incoming', counterpartyId: entry.counterpartyId,
    stageId: entry.stageId, financeEntryId: entry.id,
    receivedAt: kind === 'pay' ? undefined : timestamp, sentAt: kind === 'pay' ? timestamp : undefined,
    storageLocation: `ИКИОМА ОС / ${state.projectCode} / Финансы`,
    ...(file ? { fileKey: file.key, fileName: file.name, mimeType: file.type, sizeBytes: file.size, uploadedAt: file.uploadedAt, uploadedBy: context.identity.name } : {}),
  };
  const documentId = reference?.id ?? (file ? document?.id : undefined);
  result.entry = { ...result.entry, [kind === 'accept' ? 'acceptanceDocumentId' : 'paymentDocumentId']: documentId };
  const action = kind === 'accept' ? 'expense_accepted' : kind === 'pay' ? 'payment_recorded' : 'income_received';
  const verb = kind === 'accept' ? 'принято' : kind === 'pay' ? 'оплачено' : 'получено';
  return finish(state, result, context, timestamp, action, `${entry.description}: ${verb} ${money(input.amount)}`, document, reference);
};

export const acceptFinanceExpense = (state: FinanceFactsSnapshot, input: FactCommand, context: FinanceCommandContext) => recordFact(state, input, context, 'accept');
export const recordFinancePayment = (state: FinanceFactsSnapshot, input: FactCommand, context: FinanceCommandContext) => recordFact(state, input, context, 'pay');
export const recordFinanceReceipt = (state: FinanceFactsSnapshot, input: FactCommand, context: FinanceCommandContext) => recordFact(state, input, context, 'receive');

