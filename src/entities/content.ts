export interface ProjectAttachment {
  id: string;
  key: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
  source: 'telegram' | 'web';
}

export interface FieldReport {
  id: string;
  createdAt: string;
  author: string;
  note: string;
  source: 'telegram' | 'web';
  stageId?: string;
  clientVisible: boolean;
  telegramMessageId?: string;
  attachments: ProjectAttachment[];
}

export interface EvidencePhoto {
  id: string;
  name: string;
  capturedAt: string;
  dataUrl?: string;
  fileKey?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
  uploadedBy?: string;
  source?: 'web' | 'telegram';
}

export interface ProjectDocument {
  id: string;
  name: string;
  type: string;
  updatedAt: string;
  clientVisible: boolean;
  status: 'current' | 'signed' | 'draft';
  category?: 'contract' | 'act' | 'invoice' | 'upd' | 'waybill' | 'specification' | 'other';
  number?: string;
  documentDate?: string;
  direction?: 'incoming' | 'outgoing' | 'internal';
  counterpartyId?: string;
  stageId?: string;
  procurementItemId?: string;
  financeEntryId?: string;
  sentAt?: string;
  receivedAt?: string;
  signedAt?: string;
  storageLocation?: string;
  fileKey?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
  uploadedBy?: string;
}
