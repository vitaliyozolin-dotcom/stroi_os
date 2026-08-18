import type { EvidencePhoto } from './content';

export type CheckpointStatus = 'pending' | 'in_review' | 'accepted' | 'rework';

export interface QualityCheckpoint {
  id: string;
  stageId: string;
  title: string;
  zone: string;
  status: CheckpointStatus;
  requiredShots: string[];
  photos: EvidencePhoto[];
  assignee: string;
  reviewer: string;
  measurement?: string;
  note?: string;
  submittedAt?: string;
  acceptedAt?: string;
  clientVisible: boolean;
}
