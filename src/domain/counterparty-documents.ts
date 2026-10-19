import type { ProjectDocument } from '../entities/index';

export interface CounterpartyDocumentDraft {
  name: string;
  category: NonNullable<ProjectDocument['category']>;
  number: string;
  documentDate: string;
  status: ProjectDocument['status'];
  direction: NonNullable<ProjectDocument['direction']>;
  storageLocation: string;
}

export const prepareCounterpartyDocument = (draft: CounterpartyDocumentDraft, counterpartyId: string, id: string, timestamp: string): { ok: true; document: ProjectDocument } | { ok: false; error: string } => {
  if (!draft.name.trim()) return { ok: false, error: 'Укажите название документа.' };
  if (!['contract', 'act', 'invoice', 'upd', 'waybill', 'specification', 'other'].includes(draft.category)) return { ok: false, error: 'Выберите тип документа.' };
  if (!['draft', 'current', 'signed'].includes(draft.status)) return { ok: false, error: 'Выберите статус документа.' };
  if (!['incoming', 'outgoing', 'internal'].includes(draft.direction)) return { ok: false, error: 'Выберите направление документа.' };
  const date = draft.documentDate;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)) return { ok: false, error: 'Укажите корректную дату документа.' };
  return { ok: true, document: {
    id, name: draft.name.trim(), type: draft.category, category: draft.category,
    number: draft.number.trim() || undefined, documentDate: date || undefined,
    updatedAt: timestamp, clientVisible: false, status: draft.status, direction: draft.direction, counterpartyId,
    receivedAt: draft.direction === 'incoming' ? timestamp : undefined,
    sentAt: draft.direction === 'outgoing' ? timestamp : undefined,
    signedAt: draft.status === 'signed' ? timestamp : undefined,
    storageLocation: draft.storageLocation.trim() || undefined,
  } };
};
