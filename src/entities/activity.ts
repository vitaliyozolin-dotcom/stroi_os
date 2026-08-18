export interface ActivityEvent {
  id: string;
  timestamp: string;
  actor: string;
  text: string;
  tone: 'neutral' | 'positive' | 'warning';
}
