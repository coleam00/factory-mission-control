/** A workflow run, as far as the console's status helpers read one. */
export interface Run {
  status: 'running' | 'paused' | 'failed' | 'completed' | 'cancelled';
  toolCallAttention?: readonly unknown[];
  stopReason?: { reason: string; signal?: string };
  wait?: { kind: 'attention' | 'event' | 'schedule' } | null;
}
