import type { FieldReport } from '../entities/index';
import type { DocumentsSnapshot, DocumentsPatch } from '../domain/contexts';
import type { DocumentDraft, UploadedDocumentFile } from '../domain/project-documents';
import type { ModuleContext, ModuleRepository, ModuleResult } from './module-repository';
export function registerProjectDocument(repository: ModuleRepository<DocumentsSnapshot, DocumentsPatch>, input: { id?: string; draft: DocumentDraft; file: UploadedDocumentFile; sourceDraftId?: string }, context: ModuleContext, channel?: 'web' | 'telegram'): ModuleResult<DocumentsPatch>;
export function registerFieldReport(repository: ModuleRepository<DocumentsSnapshot, DocumentsPatch>, input: { id?: string; createdAt: string; note: string; source: 'web' | 'telegram'; stageId?: string; attachments: FieldReport['attachments']; sourceDraftId?: string; telegramMessageId?: string }, context: ModuleContext): ModuleResult<DocumentsPatch>;
