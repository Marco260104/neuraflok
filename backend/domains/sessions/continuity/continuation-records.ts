import { isReasoningEffort, type Handoff, type ReasoningEffort } from '../../../../contracts/session.js';

export const CONTINUATION_TTL_MS = 10 * 60_000;
export const CONTINUATION_WRITING_TTL_MS = 30 * 60_000;
export const CONTINUATION_PRO_WRITING_TTL_MS = 60 * 60_000;
export const AUTOMATIC_HANDOVER_TTL_MS = 6 * 60 * 60_000;

export type ContinuationState =
  | 'awaiting-summary'
  | 'awaiting-chat'
  | 'claimed'
  | 'committing'
  | 'committed'
  | 'aborted';

export type ContinuationSendState =
  | 'not-attempted'
  | 'attempted-unresolved'
  | 'dispatched-unresolved'
  | 'sent';

export interface ContinuationSendCheckpoint {
  state: ContinuationSendState;
  messageId: string | null;
}

export interface ContinuationDestinationCheckpoint extends ContinuationSendCheckpoint {
  conversationId: string | null;
}

export const sendUnattempted = (checkpoint: ContinuationSendCheckpoint): boolean =>
  checkpoint.state === 'not-attempted' || checkpoint.state === 'attempted-unresolved';

export type RequestedModel = { model: string; reasoningEffort: ReasoningEffort | null };

export function normalizeRequestedModel(value: unknown): RequestedModel | null {
  if (!value || typeof value !== 'object') return null;
  const { model, reasoningEffort } = value as Record<string, unknown>;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9 ._-]{1,80}$/.test(model) ||
      (reasoningEffort != null && !isReasoningEffort(reasoningEffort))) return null;
  return { model, reasoningEffort: isReasoningEffort(reasoningEffort) ? reasoningEffort : null };
}

export interface Continuation {
  requestedModel: RequestedModel | null;
  sourceTurnId: string | null;
  token: string;
  sessionId: string;
  from: string;
  openedAt: number;
  touchedAt: number;
  sourceProgress: number;
  automatic: boolean;
  askedAt: number | null;
  state: ContinuationState;
  summary: string;
  handoffId: string | null;
  capture: Promise<Handoff | null> | null;
  handoff: Handoff | null;
  claimedBy: string | null;
  to: string | null;
  sourceSend: ContinuationSendCheckpoint;
  destinationSend: ContinuationDestinationCheckpoint;
  error: string | null;
}

export const CONTINUATIONS_STATE = 'continuations';

export interface ContinuationRecord {
  requestedModel?: RequestedModel | null;
  sourceTurnId?: string | null;
  token: string;
  sessionId: string;
  from: string;
  to: string | null;
  openedAt: number;
  touchedAt?: number;
  sourceProgress?: number;
  automatic?: boolean;
  askedAt?: number | null;
  state: ContinuationState;
  summary: string;
  handoffId: string | null;
  claimedBy: string | null;
  armed?: boolean;
  sourceSend?: ContinuationSendCheckpoint;
  destinationSend?: ContinuationDestinationCheckpoint;
  error: string | null;
}

export interface ContinuationSnapshot {
  version: 1;
  savedAt: number;
  entries: ContinuationRecord[];
}

export function durableRecord(entry: Continuation): ContinuationRecord {
  return {
    requestedModel: normalizeRequestedModel(entry.requestedModel),
    sourceTurnId: entry.sourceTurnId,
    token: entry.token,
    sessionId: entry.sessionId,
    from: entry.from,
    to: entry.to,
    openedAt: entry.openedAt,
    touchedAt: entry.touchedAt,
    sourceProgress: entry.sourceProgress,
    automatic: entry.automatic,
    askedAt: entry.askedAt,
    state: entry.state,
    summary: entry.summary.slice(0, 512 * 1024),
    handoffId: entry.handoffId,
    claimedBy: entry.claimedBy,
    sourceSend: { ...entry.sourceSend },
    destinationSend: { ...entry.destinationSend },
    error: entry.error
  };
}
