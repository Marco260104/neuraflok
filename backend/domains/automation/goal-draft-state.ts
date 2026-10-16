import { goalErrorKey, goalErrorMessage } from '../../../contracts/goal-errors.js';
import type { GoalBackend, GoalMode, GoalReasoning } from '../../../contracts/types.js';
import { TaskRequestError } from './task-requests/errors.js';
import { goalReplyFor } from './goal-reply-ledger.js';
import type { ApiProviderEndpoint } from '../providers/api-settings.js';

export const REQUEST_TIMEOUT_MS = 180_000;
export const DRAFT_TTL_MS = 10 * 60_000;

export const SETTLED_FAILURE = /^(?:auth_rejected|out_of_credit|unknown_model|no_api_key|no_conversation|no_objective|invalid_provider|goal_marker_missing|goal_browser_cancelled|goal_browser_send_unconfirmed|goal_browser_send_failed)(?:$|:)/;

export function retryableGoalFailure(error: string): boolean {
  return !SETTLED_FAILURE.test(error);
}

export function nativeGoalFailure(error: string, backend: GoalBackend, retryAfterMs?: number): TaskRequestError {
  return new TaskRequestError(error, backend === 'api' && retryableGoalFailure(error) &&
    /^(?:rate_limited|http_(?:408|425|5\d\d)|request_failed|timeout_or_cancelled)(?:$|:)/.test(error), retryAfterMs);
}

export type GoalStage =
  | 'sending'
  | 'answering'
  | 'ready'
  | 'no-reply'
  | 'failed';

export interface GoalDraftView {
  token: string;
  conversationId: string;
  turnId: string;
  stage: GoalStage;
  backend: GoalBackend;
  model: string;
  text: string;
  reply: string;
  error: string | null;
  message?: string;
  messageKey?: string | null;
  retryable: boolean;
}

export interface GoalDraft extends Omit<GoalDraftView, 'retryable'> {
  sessionId: string;
  endpoint: ApiProviderEndpoint;
  reasoning: GoalReasoning;
  systemPrompt: string;
  objectiveSystemPrompt: string;
  loopSystemPrompt: string;
  mode: GoalMode;
  objective: string;
  clientId: string;
  startedAt: number;
  settledAt: number;
  acknowledged: boolean;
  work: Promise<void> | null;
  abort: AbortController | null;
}

export const drafts = new Map<string, GoalDraft>();

export function goalDraftBusy(conversationId: string): boolean {
  const draft = drafts.get(conversationId);
  if (!draft || draft.acknowledged) return false;
  return draft.stage === 'sending' || draft.stage === 'answering';
}

export function goalDraftNeedsIntervention(conversationId: string): boolean {
  const draft = drafts.get(conversationId);
  return draft?.stage === 'failed' && draft.turnId === goalReplyFor(conversationId)?.turnId &&
    !retryableGoalFailure(draft.error ?? '');
}

export function view(draft: GoalDraft): GoalDraftView {
  return {
    token: draft.token,
    conversationId: draft.conversationId,
    turnId: draft.turnId,
    stage: draft.stage,
    backend: draft.backend,
    model: draft.model,
    text: draft.text,
    reply: draft.stage === 'ready' && !draft.acknowledged ? draft.reply : '',
    error: draft.error,
    ...(draft.error ? { message: goalErrorMessage(draft.error), messageKey: goalErrorKey(draft.error) } : {}),
    retryable: draft.stage === 'failed' && retryableGoalFailure(draft.error ?? '')
  };
}

export function settledFailure(draft: GoalDraft): boolean {
  return draft.stage === 'failed' && draft.error !== null && !retryableGoalFailure(draft.error);
}

export function expireDraftPayload(draft: GoalDraft): void {
  if (draft.settledAt === 0 || Date.now() - draft.settledAt <= DRAFT_TTL_MS) return;
  if (settledFailure(draft)) { draft.acknowledged = true; return; }
  draft.acknowledged = true;
  draft.text = '';
  draft.reply = '';
  draft.error = null;
  draft.work = null;
}

export function goalViewFor(conversationId: string, clientId?: string): GoalDraftView | null {
  const draft = drafts.get(conversationId);
  if (!draft) return null;
  expireDraftPayload(draft);
  if (clientId !== undefined && draft.clientId !== clientId) return null;
  if (draft.acknowledged && !settledFailure(draft)) return null;
  return view(draft);
}

export function goalOutcomeFor(conversationId: string): GoalDraftView | null {
  const draft = drafts.get(conversationId);
  return draft?.acknowledged && draft.stage === 'no-reply' ? view(draft) : null;
}
