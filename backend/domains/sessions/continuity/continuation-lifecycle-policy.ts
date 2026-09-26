import { isProModel } from '../../../../contracts/model-capabilities.js';
import {
  AUTOMATIC_HANDOVER_TTL_MS,
  CONTINUATION_PRO_WRITING_TTL_MS,
  CONTINUATION_TTL_MS,
  CONTINUATION_WRITING_TTL_MS,
  type Continuation,
  type ContinuationState,
  type RequestedModel
} from './continuation-records.js';

/** Whether the marked handoff request has been submitted or acknowledged. */
export const handoffAsked = (entry: Continuation): boolean =>
  entry.state !== 'awaiting-summary' ||
  entry.sourceSend.state === 'dispatched-unresolved' ||
  entry.sourceSend.state === 'sent';

/** The manual waiting budget depends on whether a brief is still being written. */
export const manualWaitingTtlMs = (state: ContinuationState, requested: RequestedModel | null): number =>
  state === 'awaiting-summary'
    ? requested !== null && isProModel(requested.model, requested.reasoningEffort ?? undefined)
      ? CONTINUATION_PRO_WRITING_TTL_MS
      : CONTINUATION_WRITING_TTL_MS
    : CONTINUATION_TTL_MS;

/** Whether a continuation has exceeded its active waiting budget. */
export const expired = (entry: Continuation, now = Date.now()): boolean =>
  entry.automatic
    ? entry.askedAt !== null && now - entry.askedAt >= AUTOMATIC_HANDOVER_TTL_MS
    : now - entry.touchedAt >= manualWaitingTtlMs(entry.state, entry.requestedModel);

/** Whether a continuation remains available to callers. */
export const isOpen = (entry: Continuation): boolean =>
  entry.state !== 'committed' && entry.state !== 'aborted' && !expired(entry);
