import type { DocumentsSnapshot } from './contexts';
import type { ProjectDocument } from '../entities/index';
export interface DocumentDraft { name: string; category: NonNullable<ProjectDocument['category']>; number: string; documentDate: string; status: ProjectDocument['status']; direction: NonNullable<ProjectDocument['direction']>; counterpartyId: string; stageId: string; clientVisible: boolean }
export interface UploadedDocumentFile { key: string; name: string; type: string; size: number; uploadedAt: string }
export const projectDocumentCategories: Record<NonNullable<ProjectDocument['category']>, string>;
export function validateDocumentDraft(state: DocumentsSnapshot, draft: DocumentDraft): string;
export function prepareUploadedDocument(state: DocumentsSnapshot, draft: DocumentDraft, file: UploadedDocumentFile, id: string, actor: string, now: string): ProjectDocument;
export function validUploadedDocumentFile(projectId: string, file: UploadedDocumentFile): boolean;
