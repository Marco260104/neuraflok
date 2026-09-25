// Moves a local session to a replacement provider conversation through one durable, recoverable rebind transaction.

import { randomBytes } from 'node:crypto';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import {
  beginPrimeTransfer,
  cancelPrimeTransfer
} from '../../automation/agents.js';
import { recordNote } from '../history/recorder.js';
import { releaseReplacementChatClaim, recordReplacementChatClaim, recordReplacementDispatch, resetReplacementChatClaims } from './replacement-chat-gate.js';
import { createContinuationSendCheckpoints } from './continuation-send-checkpoints.js';
import { createContinuationCommitter } from './continuation-commit.js';
import { createContinuationRecovery } from './continuation-recovery.js';
import { createContinuationCapture } from './continuation-capture.js';
import { createContinuationShadowRepair, type ContinuationRecoveryHooks } from './continuation-shadow-repair.js';
import { expired, handoffAsked, isOpen, manualWaitingTtlMs } from './continuation-lifecycle-policy.js';
import { byToken, changed, changedNow, persistNewContinuation, transitionNow } from './continuation-state.js';
export { snapshotContinuations } from './continuation-state.js';
import {
  CONTINUATION_TTL_MS,
  normalizeRequestedModel as requestedModel,
  sendUnattempted,
  type Continuation,
  type ContinuationDestinationCheckpoint,
  type ContinuationSendCheckpoint,
  type ContinuationState,
  type RequestedModel
} from './continuation-records.js';
export {
  AUTOMATIC_HANDOVER_TTL_MS,
  CONTINUATION_PRO_WRITING_TTL_MS,
  CONTINUATION_TTL_MS,
  CONTINUATION_WRITING_TTL_MS,
  CONTINUATIONS_STATE,
  sendUnattempted
} from './continuation-records.js';
export type {
  Continuation,
  ContinuationDestinationCheckpoint,
  ContinuationRecord,
  ContinuationSendCheckpoint,
  ContinuationSendState,
  ContinuationSnapshot,
  ContinuationState
} from './continuation-records.js';
import {
  getSession,
  refuseAutomaticCompactionNow
} from '../history/store.js';

/** At most one continuation per session, and at most one open per prime chat. */
const openingBySession = new Map<string, Promise<ContinuationView>>();
const checkpointLocks = new Map<string, Promise<unknown>>();

export type ContinuationCommitResult =
  | { status: 'committed'; conversationId: string }
  | { status: 'already-committed'; conversationId: string }
  | { status: 'retryable'; reason: string }
  | { status: 'rejected'; reason: string };

export type { ContinuationRecoveryHooks } from './continuation-shadow-repair.js';

let recoveryHooks: ContinuationRecoveryHooks = {};

export function setContinuationRecoveryHooks(hooks: ContinuationRecoveryHooks): void {
  recoveryHooks = { ...hooks };
}

export interface ContinuationView {
  requestedModel: RequestedModel | null;
  touchedAt: number;
  token: string;
  sessionId: string;
  from: string;
  to: string | null;
  state: ContinuationState;
  handoffId: string | null;
  error: string | null;
  openedAt: number;
  automatic: boolean;
  /** When the brief request first went on its way, or null while it has not. */
  askedAt: number | null;
  sourceSend: ContinuationSendCheckpoint;
  destinationSend: ContinuationDestinationCheckpoint;
}

const view = (entry: Continuation): ContinuationView => ({
  requestedModel: requestedModel(entry.requestedModel),
  touchedAt: entry.touchedAt,
  token: entry.token,
  sessionId: entry.sessionId,
  from: entry.from,
  to: entry.to,
  state: entry.state,
  handoffId: entry.handoffId,
  error: entry.error,
  openedAt: entry.openedAt,
  automatic: entry.automatic,
  askedAt: entry.askedAt,
  sourceSend: { ...entry.sourceSend },
  destinationSend: { ...entry.destinationSend }
});

function sweep(): void {
  for (const entry of [...byToken.values()]) {
    // A commit in flight is never swept. It holds a frozen prime handover and an in-flight durable write, and expiring it here would let any passing lookup abort a transaction that is about to land — the write would still complete, on a transaction that had been declared dead and had released the very handover it was carrying. The deadline applies to *waiting*, and once the durable phase starts there is nothing left to wait for.
    if (entry.state === 'committing' || continuationCommitter.hasCommitLock(entry.token) || checkpointLocks.has(entry.token)) continue;
    if (entry.state === 'committed' || entry.state === 'aborted') {
      // Kept briefly so a repeated ack can be answered with "already done" rather than with a fresh transaction, then forgotten.
      if (Date.now() - entry.touchedAt > CONTINUATION_TTL_MS * 2) byToken.delete(entry.token);
      continue;
    }
    if (expired(entry)) {
      abortContinuation(
        entry.token,
        entry.automatic ? 'the handover never landed and was given up on' : 'it took too long and was given up on'
      );
    }
  }
}

/** The open continuation for a session, if there is one. */
export function continuationForSession(sessionId: string): ContinuationView | null {
  sweep();
  for (const entry of byToken.values()) {
    if (entry.sessionId === sessionId && isOpen(entry)) return view(entry);
  }
  return null;
}

export function continuationByToken(token: string): ContinuationView | null {
  sweep();
  const entry = byToken.get(token);
  return entry ? view(entry) : null;
}

/** The continuation that has already asked this chat for its handoff brief, if there is one. From the moment the marked prompt is submitted until the durable commit lands, whatever chat A does is history the brief cannot describe — the brief is being written, or is written — so the kernel refuses A's local tool calls while this returns non-null, and after the commit the store's `superseded` attachment takes over that refusal for good. A filed ticket whose prompt has not been submitted yet does not count: the page may still be stopping the turn or draining local calls, and an automatic ticket that could not proceed waits on the WAL for its next pickup with the chat working normally in between. */
export function compactingConversation(conversationId: string | null | undefined): ContinuationView | null {
  if (!conversationId) return null;
  sweep();
  for (const entry of byToken.values()) {
    if (entry.from !== conversationId || !isOpen(entry)) continue;
    if (handoffAsked(entry)) return view(entry);
  }
  return null;
}

/** Whether any chat is currently being compacted — the cheap gate in front of the above. */
export function anyContinuationOpen(): boolean {
  for (const entry of byToken.values()) {
    if (isOpen(entry)) return true;
  }
  return false;
}

/** Source chats that Compact & Resume has finished replacing. Once the commit is durable the old chat is history: its session lives in the replacement, its calls are refused as superseded, and the tab it is still open in only costs memory. Listed for as long as the committed record is retained, so the browser closes it once and a chat the user reopens later on purpose is left alone. */
export function supersededSourceConversations(): string[] {
  sweep();
  const out = new Set<string>();
  for (const entry of byToken.values()) {
    if (entry.state === 'committed' && entry.to && entry.to !== entry.from) out.add(entry.from);
  }
  return [...out].sort();
}

/** Compaction tickets still owed a real A -> B commit. */
export function pendingContinuations(): ContinuationView[] {
  sweep();
  return [...byToken.values()].filter(isOpen).map(view);
}

const continuationShadowRepair = createContinuationShadowRepair({
  byToken,
  recoveryHooks: () => recoveryHooks
});
export const { repairPrimeFromResumeShadow } = continuationShadowRepair;

/** Begins a continuation for the session attached to `fromConversationId`. Idempotent per session: pressing the button twice is one transaction, answered with the one already running. That is deliberate — the previous design let each press become its own handoff and its own fresh tab. */
function makeContinuation(sessionId: string, fromConversationId: string, automatic: boolean): Continuation {
  return {
    requestedModel: null,
    sourceTurnId: null,
    token: randomBytes(16).toString('base64url'),
    sessionId,
    from: fromConversationId,
    openedAt: Date.now(),
    touchedAt: Date.now(),
    sourceProgress: 0,
    automatic,
    askedAt: null,
    state: 'awaiting-summary',
    summary: '',
    handoffId: null,
    capture: null,
    handoff: null,
    claimedBy: null,
    to: null,
    sourceSend: { state: 'not-attempted', messageId: null },
    destinationSend: { state: 'not-attempted', conversationId: null, messageId: null },
    error: null
  };
}

/** Durable open used before the bridge hands the one-shot compaction prompt to a page. */
export async function openContinuationNow(
  sessionId: string,
  fromConversationId: string,
  automatic = false
): Promise<ContinuationView> {
  sweep();
  const existing = [...byToken.values()].find((entry) => entry.sessionId === sessionId && isOpen(entry));
  if (existing) return view(existing);
  const opening = openingBySession.get(sessionId);
  if (opening) return opening;

  const work = (async (): Promise<ContinuationView> => {
    const again = [...byToken.values()].find((entry) => entry.sessionId === sessionId && isOpen(entry));
    if (again) return view(again);
    const entry = makeContinuation(sessionId, fromConversationId, automatic);
    const source = await getSession(sessionId);
    entry.sourceTurnId = source?.activeTurnId ?? null;
    if (source?.conversationId === fromConversationId && source.selectedModel?.conversationId === fromConversationId) {
      entry.requestedModel = requestedModel(source.selectedModel);
    }
    await persistNewContinuation(entry);
    beginPrimeTransfer(fromConversationId);
    logInfo(`continuation ${entry.token.slice(0, 8)} durably opened for session ${sessionId} in chat ${fromConversationId}`);
    return view(entry);
  })();
  openingBySession.set(sessionId, work);
  try {
    return await work;
  } finally {
    if (openingBySession.get(sessionId) === work) openingBySession.delete(sessionId);
  }
}

async function withCheckpointLock<T>(token: string, work: () => Promise<T>): Promise<T> {
  const prior = checkpointLocks.get(token);
  // Reserve each waiter immediately; several callers must not all resume from the same predecessor and overwrite one another's staged durable transition.
  const current = prior ? prior.then(work, work) : work();
  checkpointLocks.set(token, current);
  try {
    return await current;
  } finally {
    if (checkpointLocks.get(token) === current) checkpointLocks.delete(token);
  }
}

const continuationCapture = createContinuationCapture({
  byToken,
  sweep,
  isOpen,
  withCheckpointLock,
  transitionNow
});
export const { attachSummary } = continuationCapture;

const continuationCommitter = createContinuationCommitter({
  continuationForToken: token => byToken.get(token) ?? null,
  isOpen,
  sweep,
  withCheckpointLock,
  transitionNow,
  recoveryHooks: () => recoveryHooks
});
export const { commitContinuation, commitContinuationResult } = continuationCommitter;

export const continuationSendCheckpointRuntime = {
  byToken,
  cancelPrimeTransfer: (conversationId: string) => cancelPrimeTransfer(conversationId),
  releaseReplacementChatClaim,
  isOpen,
  logWarn,
  noteAbandoned,
  recordReplacementDispatch,
  refuseAutomaticCompactionNow,
  sendUnattempted,
  transitionNow,
  withCheckpointLock
};
const continuationSendCheckpoints = createContinuationSendCheckpoints(continuationSendCheckpointRuntime);
export const {
  abortContinuationSourceBeforeSendNow,
  beginContinuationDestinationSendNow,
  beginContinuationSourceSendNow,
  bindContinuationDestinationMessageNow,
  bindContinuationSourceMessageNow,
  continuationClaimedBy,
  dispatchContinuationDestinationSendNow,
  dispatchContinuationSourceSendNow,
  releaseContinuationDestinationSendNow
} = continuationSendCheckpoints;
/** Takes this continuation for one replacement chat, and returns the brief to send. One claim, ever. A second claimant — a duplicate command, a second tab redeeming the same marker — is refused, which is the whole of "never allow two replacement chats to claim the same continuation". Re-claiming with the *same* claimant is allowed, because that is a retry of one attempt rather than a second attempt. The state machine only ever moves forwards here. A retry that arrives while the commit is already in flight is answered with the brief — that is all a retrying claimant wants — but must not put the state back to `claimed`, because `committing` is the lock that stops a second {@link commitContinuation} from entering while the first is still awaiting its durable write. Writing the state back was that lock's one escape hatch. */
/** Durable claim used by the command redeem route. The brief is not handed to a browser document until the WAL records which claimant owns it. */
export async function claimContinuationNow(token: string, claimant: string): Promise<{ summary: string } | null> {
  sweep();
  // A retry by the current claimant is read-only while its commit owns the write.
  const committing = byToken.get(token);
  if (committing && continuationCommitter.hasCommitLock(token) && isOpen(committing) && committing.claimedBy === claimant) {
    return { summary: committing.summary };
  }
  return withCheckpointLock(token, async () => {
    const entry = byToken.get(token);
    if (!entry || !isOpen(entry)) return null;
    if (entry.state === 'awaiting-summary') return null;
    if (entry.claimedBy !== null && entry.claimedBy !== claimant) return null;
    if (entry.state === 'awaiting-chat') {
      await transitionNow(entry, (current) => ({ ...current, claimedBy: claimant, state: 'claimed' }));
    } else if (entry.state === 'claimed' && entry.claimedBy === null) {
      await transitionNow(entry, (current) => ({ ...current, claimedBy: claimant }));
    }
    // After the transition, never before it. A throw here leaves nothing claimed, and arming first would have made every unrelated new chat wait out the window for a claim that does not exist.
    if (entry.state === 'claimed') {
      if (entry.destinationSend.state === 'dispatched-unresolved' || entry.destinationSend.state === 'sent') {
        recordReplacementDispatch(entry.token);
      } else {
        recordReplacementChatClaim(entry.token);
      }
    }
    return { summary: entry.summary };
  });
}

/** Gives up, leaving the session attached to chat A. Refuses once the durable phase has started. `committing` is the commit's lock, and an abort that could clear it would cancel the frozen prime handover under a write that is still going to land — the session would move on disk while the swarm stayed behind. The commit either succeeds, or restores a claimable state itself and can be aborted then. */
export function abortContinuation(token: string, reason: string): boolean {
  const entry = byToken.get(token);
  if (!entry || entry.state === 'committing' || continuationCommitter.hasCommitLock(token) || checkpointLocks.has(token)) return false;
  if (entry.state === 'committed' || entry.state === 'aborted') return false;
  entry.state = 'aborted';
  entry.error = reason;
  releaseReplacementChatClaim(entry.token);
  cancelPrimeTransfer(entry.from);
  changed();
  logWarn(`continuation ${entry.token.slice(0, 8)} abandoned — ${reason}`);
  noteAbandoned(entry, reason);
  return true;
}

/** Puts the reason a Compact & Resume died into the session it was compacting, so the timeline's one row for it can say what went wrong instead of only that nothing came. The log line above is operational and RAM-only; this is the durable, user-facing record. */
function noteAbandoned(entry: Continuation, reason: string): void {
  void recordNote(entry.sessionId, `Compact & Resume abandoned — ${reason}`, entry.token);
}

/** Durable abort for user-visible cancellation paths. */
export async function abortContinuationNow(token: string, reason: string): Promise<boolean> {
  return withCheckpointLock(token, async () => {
    const entry = byToken.get(token);
    if (!entry || entry.state === 'committing') return false;
    if (entry.state === 'committed' || entry.state === 'aborted') return false;
    if (entry.automatic) {
      const source = await getSession(entry.sessionId);
      // The dispatched handoff may already be a new turn. Refuse that current source turn before retiring the ticket; later authored work can rearm it.
      if (source?.conversationId === entry.from) {
        await refuseAutomaticCompactionNow(entry.sessionId, entry.from, source.activeTurnId ?? entry.sourceTurnId);
      }
    }
    await transitionNow(entry, (current) => ({ ...current, state: 'aborted', error: reason }));
    cancelPrimeTransfer(entry.from);
    logWarn(`continuation ${entry.token.slice(0, 8)} durably abandoned — ${reason}`);
    noteAbandoned(entry, reason);
    return true;
  });
}

const continuationRecovery = createContinuationRecovery({
  byToken,
  changedNow,
  expired,
  handoffAsked,
  manualWaitingTtlMs,
  publishRecoveryProjection: (entry, conversationId) =>
    continuationCommitter.publishRecoveryProjection(entry, conversationId)
});
export const { restoreContinuations } = continuationRecovery;
/** Test seam. */
export function resetContinuationsForTests(): void {
  byToken.clear();
  openingBySession.clear();
  continuationCommitter.reset();
  checkpointLocks.clear();
  recoveryHooks = {};
  // The gate is part of this module's state even though it lives next door, and a claim outlives a cleared transaction by REPLACEMENT_CHAT_CLAIM_WINDOW_MS. Left behind, it makes the *next* test's unrelated new chat wait for a replacement that will never come.
  resetReplacementChatClaims();
  changed();
}
