export type TaskProgressPhase = 'preparing' | 'generating' | 'ready' | 'retrying' | 'failed' | 'cancelled';

export interface TaskProgress {
  requestId: string;
  phase: TaskProgressPhase;
  text: string;
  error?: string;
  attempt?: number;
  retryAt?: number;
}

export type TaskProgressUpdate = Omit<TaskProgress, 'requestId'>;
