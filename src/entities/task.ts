import type { ProjectAttachment } from './content';

export type TaskStatus = 'todo' | 'in_progress' | 'waiting' | 'review' | 'done' | 'canceled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';
export type TaskHistoryKind = 'created' | 'edited' | 'status' | 'assignee' | 'due_date' | 'comment' | 'completed' | 'reopened';

export interface TaskHistoryEvent {
  id: string;
  timestamp: string;
  actor: string;
  kind: TaskHistoryKind;
  text: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string;
  assigneeName: string;
  reviewerId?: string;
  reviewerName?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  dueDate: string;
  originalDueDate: string;
  completedAt?: string;
  completionNote?: string;
  stageId?: string;
  counterpartyId?: string;
  procurementItemId?: string;
  checkpointId?: string;
  blockerReason?: string;
  rescheduleCount: number;
  attachments?: ProjectAttachment[];
  history: TaskHistoryEvent[];
}
