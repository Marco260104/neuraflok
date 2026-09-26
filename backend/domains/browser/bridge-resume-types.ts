import type { ContinuationSendState } from '../sessions/continuity/continuation.js';

export type ResumeStage = 'handoff-pending' | 'opening' | 'waiting-for-browser' | 'done' | 'failed';

export interface ResumeJobView {
  sessionId: string;
  token: string;
  stage: ResumeStage;
  startedAt: number;
  automatic: boolean;
  busy: boolean;
  handoffId: string | null;
  sourceSend: {
    state: ContinuationSendState;
    messageId: string | null;
  };
  destinationSend: {
    state: ContinuationSendState;
    conversationId: string | null;
    messageId: string | null;
  };
  error: string | null;
}
