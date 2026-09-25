import type { ActivityGrant } from './session-activity.js';

export interface UnattributedCandidate {
  conversationId: string;
  sessionId: string;
  endedTurns: number;
  turnId: string | null;
}

export interface UnattributedIncident {
  startedAt: number;
  firstDueAt: number;
  pass: 0 | 1 | 2;
  firstAttemptAt: number | null;
  lastUnknownStartedAt: number;
  ready: Promise<void>;
  requestId: string | null;
  candidates: UnattributedCandidate[];
  proven: Set<string>;
  dismissed: Set<string>;
}

export interface Repair {
  silenceGrant?: ActivityGrant;
  assistantSource?: { key: string; turnId: string | null; completed: boolean };
  attribution?: { incident: UnattributedIncident; candidate: UnattributedCandidate };
  claimed?: boolean;
  offers?: number;
  sessionId: string;
  endedTurns: number;
  state: 'queued' | 'handed' | 'done';
  episode: string;
  reason: 'unattributed' | 'assistant-error' | 'no-tab' | 'silence' | 'goal' | 'compaction' | 'stalled';
  notBefore: number;
  token: string;
  progressId: string;
  progress?: { sessionId: string; seq: number; time: number; text: string; turnId: string | null };
  awaitingStream?: boolean;
}
