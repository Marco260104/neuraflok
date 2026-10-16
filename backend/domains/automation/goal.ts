// Goal and Loop decide whether completed provider turns need another reply and keep one durable draft per conversation.

import { resetGoalContextForTests } from './goal-context.js';
export { conversationMessages } from './goal-context.js';
import { resetGoalModelCatalogCache } from './goal-model-catalog.js';
export { listGoalModels, MODEL_PAGE_SIZE } from './goal-model-catalog.js';
export type { GoalModel } from '../../../contracts/automation/goal-model-reasoning.js';
import type { GoalBackend, GoalMode } from '../../../contracts/types.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import {
  allGoalReplies, clearGoalReplies, deleteGoalReply, goalReplyCount, goalReplyFor,
  persistGoalRepliesNow, persistGoalRepliesSoon,
  setGoalReply, updateGoalReply
} from './goal-reply-ledger.js';
export { GOAL_REPLIES_STATE, restoreGoalReplies, snapshotGoalReplies } from './goal-reply-ledger.js';
export type { GoalRepliesSnapshot } from './goal-reply-ledger.js';
import { findSessionByConversation, getSession, readRecentEvents } from '../sessions/history/store.js';
import { supportsFinishAutomation } from '../../../contracts/automation/completion-policy.js';
import { goalArmedFor } from './goal-activation.js';
import { goalBackendFor, goalDrivingMode, goalSwitchFor, goalSwitchGuard } from './goal-switches.js';
import { resetGoalControlStateForTests } from './goal-control-state.js';
import { drafts, nativeGoalFailure, REQUEST_TIMEOUT_MS, retryableGoalFailure, type GoalDraftView } from './goal-draft-state.js';
export { goalDraftBusy, goalDraftNeedsIntervention, goalOutcomeFor, goalViewFor, nativeGoalFailure } from './goal-draft-state.js';
export type { GoalStage, GoalDraftView } from './goal-draft-state.js';
export * from './goal-activation.js';
export * from './goal-objectives.js';
export * from './goal-switches.js';
export * from './goal-control-state.js';
import { notifyGoalChange } from './goal-events.js';
export { onGoalChange } from './goal-events.js';
import { webProviderLabel } from './goal-decision.js';
import { createGoalRequestDrafts } from './goal-request-drafts.js';
import { createGoalReplyRecovery } from './goal-reply-recovery.js';
import { createGoalDraftLifecycle } from './goal-draft-lifecycle.js';
import type { ApiProviderEndpoint } from '../providers/api-settings.js';
import { apiProviderKey, configuredApiEndpoint } from '../providers/api-settings.js';
export type { StartGoalDraftInput } from './goal-draft-lifecycle.js';

/** A finish-only preference has authority only while the finish tool is available. */
export async function astraFinishOnly(sessionId: string, conversationId: string): Promise<boolean> {
  const session = await getSession(sessionId);
  const selection = session?.selectedModel;
  return getConfig().ui.finishTool === true && session?.conversationId === conversationId && selection?.conversationId === conversationId &&
    supportsFinishAutomation(goalSwitchFor(conversationId).mode, selection.model, selection.reasoningEffort) &&
    !loopAfterTurnFor(conversationId);
}
// The saved loopAfterTurn preference now serves both Goal and Loop. Disabling finish makes after-turn effective without overwriting the user's preference.
export function loopAfterTurnFor(conversationId: string): boolean {
  const control = goalSwitchFor(conversationId);
  return control.enabled && (control.afterTurn || getConfig().ui.finishTool !== true);
}
const goalReplyRecovery = createGoalReplyRecovery({ astraFinishOnly, goalKeyPresent, setGoalReplyActiveNow });
export const { goalPendingReplyFor, pendingGoalReplies, recordGoalPickupAttemptNow, syncGoalPickupRecoveryNow,
  acceptGoalReplyNow, consumeGoalReplyForInputNow, goalReplySourceTurn, automaticLoopHasMcpWork } = goalReplyRecovery;
const handleGoalReply = goalReplyRecovery.handleGoalReply;


/** Older restored automatic debt has no exemption; URL/reply-id prefixes grant none. */
export async function loopReplyHasAuthority(sessionId: string, conversationId: string, turnId: string): Promise<boolean> {
  if (goalSwitchFor(conversationId).mode !== 'loop') return true;
  const reply = goalReplyFor(conversationId);
  if (reply?.sessionId === sessionId && reply.turnId === turnId && reply.state === 'pending' && reply.explicitActivation) return true;
  return automaticLoopHasMcpWork(sessionId, conversationId, reply?.turnId === turnId ? reply.silenceSourceTurnId ?? turnId : turnId);
}

const goalDraftLifecycle = createGoalDraftLifecycle({
  authorizeBrowserHelperRetry: async (inputId, sessionId) => (await import('../sessions/input/input.js')).authorizeBrowserHelperRetry(inputId, sessionId),
  astraFinishOnly,
  loopReplyHasAuthority,
  handleGoalReply
});
export const { retryGoalBrowserHelper, startGoalDraft, beginGoalDraft, discardPreparedGoalDraft } = goalDraftLifecycle;

/** Progress names the active draft, or the configured driver before a draft exists. */
export function goalProgressFor(mode: GoalMode, draft?: GoalDraftView | null): {
  backend: GoalBackend; model: string; provider: ApiProviderEndpoint['kind'];
} {
  const settings = getConfig().goal;
  const backend = draft?.backend ?? goalBackendFor(mode);
  return {
    backend,
    model: draft?.model ?? (backend === 'web' ? webProviderLabel()
      : backend === 'templates' ? 'Offline templates' : settings.model),
    provider: configuredApiEndpoint().kind
  };
}
export async function goalKeyPresent(mode: GoalMode = goalDrivingMode()): Promise<boolean> {
  if (goalBackendFor(mode) !== 'api') return true;
  const endpoint = configuredApiEndpoint();
  // A custom endpoint is often a keyless local server, so there is nothing to require: reachability and auth are proven by the first call, not by the presence of a secret.
  if (endpoint.kind === 'custom') return true;
  return (await apiProviderKey(endpoint.kind)) !== null;
}

export function ackGoalDraft(conversationId: string, token: string, clientId?: string): boolean {
  const draft = drafts.get(conversationId);
  if (!draft || draft.token !== token) return false;
  if (clientId !== undefined && draft.clientId !== clientId) return false;
  draft.acknowledged = true;
  // An acknowledgement can also mean "this draft will never be sent" (Goal Mode was switched off, the chat moved on, or the composer stayed occupied). Do not keep spending the user's OpenRouter key after the browser has explicitly retired the draft. If the request has not reached fetch yet, run() observes `acknowledged` at its next await boundary; if it has, aborting the controller closes the stream immediately.
  draft.abort?.abort();
  if (draft.settledAt === 0) draft.settledAt = Date.now();
  // The two answers that discharge the obligation are the ones the page can act on: a message it typed, and NO_REPLY. Everything else is the app failing to produce one — a dropped stream, a rejected key, an exhausted balance, an abort — and a failure to answer may not be recorded as an answer. Retiring the row on `auth_rejected` meant the user fixing their key found the turn it was owed for silently gone.
  if (draft.stage === 'ready' || draft.stage === 'no-reply') handleGoalReply(conversationId, draft.turnId);
  notifyGoalChange();
  return true;
}

/** The browser ACK is not successful until the reply tombstone is crash-durable. */
export async function ackGoalDraftNow(
  conversationId: string,
  token: string,
  clientId?: string
): Promise<boolean> {
  const acknowledged = ackGoalDraft(conversationId, token, clientId);
  if (acknowledged) await persistGoalRepliesNow();
  return acknowledged;
}

// Revoke attempts made under replaced settings; pending source work survives. Only an explicit master Off also discharges all automatic reply obligations.
export function retireGoalDrafts(retireReplies = false): number {
  let retired = 0;
  for (const draft of drafts.values()) {
    if (draft.acknowledged) continue;
    draft.acknowledged = true;
    draft.abort?.abort();
    if (draft.settledAt === 0) draft.settledAt = Date.now();
    draft.text = '';
    draft.reply = '';
    retired += 1;
  }
  // A settings/key replacement revokes prepared text, not the source obligation. Removing the attempt permits that same source to use the corrected settings.
  drafts.clear();
  if (retireReplies) {
    for (const reply of allGoalReplies()) updateGoalReply(reply.conversationId, reply, current => { current.state = 'handled'; });
    if (goalReplyCount() > 0) persistGoalRepliesSoon();
  }
  return retired;
}

// Retires whatever one chat has in flight, leaving every other chat alone. A draft is frozen with the instruction and the goal it was started under. Changing that chat's goal therefore has to reach the request already running, or the last thing typed into the conversation would be a message written against the goal the user just replaced.
export function retireGoalDraftsFor(conversationId: string): boolean {
  const draft = drafts.get(conversationId);
  const pending = goalReplyFor(conversationId)?.state === 'pending';
  if (!draft || draft.acknowledged) {
    if (pending) handleGoalReply(conversationId);
    return pending;
  }
  draft.acknowledged = true;
  draft.abort?.abort();
  if (draft.settledAt === 0) draft.settledAt = Date.now();
  draft.text = '';
  draft.reply = '';
  handleGoalReply(conversationId);
  notifyGoalChange();
  return true;
}

// Applies one chat switch to the durable Goal obligation, not merely to its current draft. Off means there is no ticket left for a replacement page to collect. On means the newest stable reply already accepted by the recorder is owed again, even when that reply finished while the switch was off. The handled row remains as the stable-message tombstone while Off; re-arming that exact row is safer and smaller than scanning rendered transcript history. The provider draft is retired before the ledger write. If persistence fails, restoring the old row leaves the reply safely retryable but can never let the now-revoked text reach the composer. A later page simply drafts it again from the same durable reply identity.
export async function setGoalReplyActiveNow(conversationId: string, active: boolean, current: (silenceSourceTurnId?: string) => boolean = () => true): Promise<boolean> {
  const activationReply = goalReplyFor(conversationId);
  const silenceSource = (activationReply?.listenUntil ?? 0) <= Date.now() ? activationReply?.silenceSourceTurnId : undefined;
  const stillCurrent = () => (!silenceSource || goalReplyFor(conversationId) === activationReply) && current(silenceSource);
  // Deliberate On is also meaningful after an unsuccessful answer. No automatic observer may mint this activation: retain the exact ended source in the same reply ledger, without pretending a failure was a final or a refresh receipt.
  if (active) {
    if (!stillCurrent()) return false;
    const controlIsCurrent = goalSwitchGuard(conversationId);
    const session = await findSessionByConversation(conversationId, { requireUnique: true });
    const [end] = session && (!session.activeTurnId || session.activeTurnId === silenceSource)
      ? await readRecentEvents(session.id, 1, { kinds: ['turn_start', 'turn_end', 'user_message'] }) : [];
    if (!stillCurrent() || !controlIsCurrent() || !goalArmedFor(conversationId) ||
        (session?.activeTurnId && session.activeTurnId !== silenceSource)) return false;
    const held = goalReplyFor(conversationId);
    if (held?.silencePro && !loopAfterTurnFor(conversationId)) return false;
    if ((end?.kind === 'user_message' || end?.kind === 'turn_start') && (!held || held.eventSeq <= end.seq)) return false;
    // On enables future completion pickup while work is running; it does not resurrect a prior answer's debt or bypass the failed-view listening window.
    if (end?.kind === 'turn_end' && end.reason === 'thinking_failed' && end.time + 5 * 60_000 > Date.now()) return false;
    if (session && end?.kind === 'turn_end' && end.turnId &&
        (end.outcome === 'stopped' || (end.outcome === 'failed' && end.reason === 'thinking_failed')) &&
        (!held || held.eventSeq < end.seq)) {
      await acceptGoalReplyNow({ conversationId, sessionId: session.id, turnId: end.turnId,
        replyId: `activation:${end.turnId}`.slice(0, 200), eventSeq: end.seq, blocked: false,
        current: () => stillCurrent() && controlIsCurrent() && goalArmedFor(conversationId) && !session.activeTurnId });
      if (!stillCurrent() || !controlIsCurrent() || !goalArmedFor(conversationId)) return false;
    }
  }
  const before = goalReplyFor(conversationId);
  const draft = drafts.get(conversationId);
  if (draft) {
    draft.acknowledged = true;
    draft.abort?.abort();
    if (draft.settledAt === 0) draft.settledAt = Date.now();
    draft.text = '';
    draft.reply = '';
    drafts.delete(conversationId);
  }
  if (!before) return Boolean(draft);

  const previous = { ...before };
  updateGoalReply(conversationId, before, reply => {
    reply.state = active ? 'pending' : 'handled';
    if (active) reply.acceptedAt = Math.max(Date.now(), previous.acceptedAt + 1);
    if (active) reply.explicitActivation = true;
  });
  const acceptedAt = before.acceptedAt;
  try {
    await persistGoalRepliesNow();
  } catch (error) {
    if (goalReplyFor(conversationId) === before && before.acceptedAt === acceptedAt) setGoalReply(conversationId, previous);
    persistGoalRepliesSoon();
    throw error;
  }
  if (active && !stillCurrent() && goalReplyFor(conversationId) === before && before.acceptedAt === acceptedAt) {
    updateGoalReply(conversationId, before, reply => { reply.state = 'handled'; });
    await persistGoalRepliesNow();
    return false;
  }
  return true;
}

/** A fabricated silence reply is not a final answer that a later On may re-arm. */
export async function withdrawSilenceGoalReplyNow(conversationId: string, replyId: string): Promise<void> {
  const reply = goalReplyFor(conversationId);
  if (!reply || reply.replyId !== replyId ||
      !(reply.replyId.startsWith('silence:') || reply.turnId.startsWith('g-silence-'))) return;
  await setGoalReplyActiveNow(conversationId, false);
  if (goalReplyFor(conversationId) !== reply) return;
  deleteGoalReply(conversationId, reply);
  try {
    await persistGoalRepliesNow();
  } catch (error) {
    // This is revocation of fabricated authority, not a retryable final obligation. Keep it absent in memory; a restart also rejects legacy rows without source proof.
    persistGoalRepliesSoon();
    throw error;
  }
}

/** Native busy or a confirmed failure defers this exact ticket, never a new one. */
export async function deferSilenceGoalReplyNow(conversationId: string, turnId: string, listenUntil?: number,
  prepared?: { token: string; clientId: string }): Promise<boolean> {
  const reply = goalReplyFor(conversationId);
  if (!reply || reply.state !== 'pending' || reply.turnId !== turnId) return false;
  if (prepared) {
    const draft = drafts.get(conversationId);
    if (!draft || draft.token !== prepared.token || draft.clientId !== prepared.clientId ||
        draft.turnId !== turnId || draft.acknowledged || draft.stage !== 'ready') return false;
    // Renewed native work retires only this prepared text, never its obligation. Remove authority before yielding; old-token duplicates cannot move the clock.
    draft.acknowledged = true;
    draft.abort?.abort();
    drafts.delete(conversationId);
    notifyGoalChange();
  }
  if (listenUntil === undefined && (reply.listenUntil ?? 0) > Date.now()) return true;
  const deadline = listenUntil ?? Date.now() + 5 * 60_000;
  if ((reply.listenUntil ?? 0) >= deadline) return true;
  updateGoalReply(conversationId, reply, current => { current.listenUntil = deadline; });
  notifyGoalChange();
  try { await persistGoalRepliesNow(); }
  catch (error) { persistGoalRepliesSoon(); throw error; }
  return goalReplyFor(conversationId) === reply;
}

/** The existing reply ledger owns the one busy wait and the irreversible Stop claim. */
export async function claimGoalRecoveryStopNow(conversationId: string, replyId: string, acceptedAt: number): Promise<boolean> {
  const reply = goalReplyFor(conversationId);
  if (!reply || reply.replyId !== replyId || reply.acceptedAt !== acceptedAt || reply.state !== 'pending' || !goalArmedFor(conversationId) ||
      !reply.listenUntil || reply.listenUntil > Date.now() || reply.recoveryStopClaimed) return false;
  updateGoalReply(conversationId, reply, current => { current.recoveryStopClaimed = true; });
  await persistGoalRepliesNow();
  return goalReplyFor(conversationId) === reply && reply.state === 'pending' && goalArmedFor(conversationId);
}

export function resetGoalStateForTests(): void {
  for (const draft of drafts.values()) draft.abort?.abort();
  resetGoalControlStateForTests();
  drafts.clear();
  clearGoalReplies();
  resetGoalContextForTests();
  resetGoalModelCatalogCache();
}

// Request drafting is kept separate from durable draft lifecycle state.
const requestDrafts = createGoalRequestDrafts({
  automaticLoopHasMcpWork,
  nativeGoalFailure,
  retryableGoalFailure,
  requestTimeoutMs: REQUEST_TIMEOUT_MS
});
export const { draftFastFollowup, draftTaskPlan, draftOpeningMessage } = requestDrafts;
