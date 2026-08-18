export interface ClientDecision {
  id: string;
  title: string;
  dueDate: string;
  status: 'waiting' | 'decided';
  choice?: string;
}
