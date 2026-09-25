import { workSequence } from '../../../../contracts/session.js';
/** User-authored input has one durable owner across browser and MCP delivery. A claimed browser send is never automatically retried: losing the ACK is ambiguous. Tool delivery repeats under a stable message id until a later request proves receipt. */
import { z } from 'zod';
import { browserInputModel, manualInput, queuedFollowup, MAX_INPUT_IMAGES } from '../../../../contracts/input.js';
import type { SessionSummary } from '../../../../contracts/session.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { readDurable, writeDurableNow, writeDurableSoon } from '../../../persistence/durable.js';
import { getSession, findSessionByConversation, createSession, deleteSession, rebindSession, conversationWasSuperseded, readRecentEvents, listUsageSessions, turnHasMcpCall, sessionDirectoryMissing, readCompletedFinal, readLatestUserMessage } from '../history/store.js';
import { userTitle } from '../history/title.js';
import { assignSessionProject, projectWorkspace } from '../../workspace/projects.js';
import { isChatBlocked } from '../continuity/blocked-chats.js';
import { wakeBrowserWork } from '../../browser/browser-wake.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { noteChatOrigin } from '../history/recorder.js';
import { isAstraModel, isProModel } from '../../../../contracts/model-capabilities.js';
import { inFlightToolCalls } from '../../../infrastructure/tool-gateway/protocol/call-context.js';
import { automaticFinishEnabled, goalDrivingMode, consumeGoalReplyForInputNow } from '../../automation/goal.js';
import { finishInstruction } from '../../../../contracts/automation/completion-policy.js';
import { recoveryMessage, recoveryBusyMs } from '../../../../contracts/recovery.js';
import { providerForConversationId } from '../../../../contracts/web-providers.js';
import { isApiConversationId } from '../../../../contracts/chat-protocol.js';
import { readSessionInputPolicy, readBrowserInputAllowed, readEligibleStageEnd, readRecoveryInvalidReason, type InputActivity } from './input-policy.js';
import { createBrowserDecisionService } from './input-browser-decisions.js';
import { createPickupRecoveryService } from './input-pickup-recovery.js';
import { createInputRecoveryOperations } from './input-recovery-operations.js';
import { createInputBrowserClaims } from './input-browser-claims.js';
import { createInputToolDelivery } from './input-tool-delivery.js';
import { createInputTurnQueries } from './input-turn-queries.js';
import { createInputDeliveryReceipts } from './input-delivery-receipts.js';
import { createInputEnqueuer } from './input-enqueue.js';
import { createInputQueueControls } from './input-queue-controls.js';
import { createInputAdmission, terminal, neverAuthorized, deliveryProof, type DeliveryProof, preparable, needsHistory, pendingStages, ordered, companionOf, sameDelivery, combinedInput } from './input-admission.js';
import { createInputHistoryProjection } from './input-history-projection.js';
import { createInputOpeningLifecycle } from './input-opening-lifecycle.js';
import { createInputDeliveryAuthorization } from './input-delivery-authorization.js';
import { createInputQueueExpiration, UNCONFIRMED_SEND } from './input-queue-expiration.js';
import { createInputSessionReceiptRetirement } from './input-session-receipt-retirement.js';
import { createInputStartupRecovery } from './input-startup-recovery.js';
import type { PromptLimits } from './prompt.js';
export { deliveryProof, type DeliveryProof };
export { TOOL_INPUT_HEADER, type ToolInputBatch } from './input-tool-delivery.js';
export type { InputActivity } from './input-policy.js';
export type { PickupRecoveryState } from './input-pickup-recovery.js';
export { onLocalExecutorInputAccepted, RECOVERY_WITHDRAW_LIMIT_MS } from './input-delivery-receipts.js';
import { inputArgs, entrySchema, type InputArgs, type InputEntry } from './input-schema.js';
export { inputArgs, type InputArgs, type InputEntry } from './input-schema.js';

const STATE = 'session-input';
/** A provider send was issued, but readable evidence has not confirmed the message arrived. */
const RECEIPT_UNCONFIRMED = 'Native Send receipt was not confirmed.';
type InputDeliveryHooks = {
  recoveryAllowed?: (sessionId: string, conversationId: string) => boolean;
  /** Whether running calls still hold this chat's automatic Continue; without it, any call does. */
  callsHoldRecovery?: (conversationId: string) => boolean;
  activity?: (session: SessionSummary) => InputActivity;
  wakeDecision?: (entry: Readonly<InputEntry>, signal: AbortSignal) => Promise<void>;
  bindHelper?: (conversationId: string, sourceSessionId: string | null) => Promise<void>;
  /** Trust an exact NEURAFLOK composer opening under the same session-policy fence as Trust IPC. */
  trustOpening?: (sessionId: string, conversationId: string) => Promise<boolean>;
  recordDelivered?: (entry: Readonly<InputEntry>, anchorCommitted: (seq: number) => void) => Promise<boolean>;
  prepareText?: (entry: Readonly<InputEntry>, limits: PromptLimits, authored: string) => string | Promise<string>;
  applyAutomation: (conversationId: string, automation: NonNullable<InputArgs['automation']>, phase: 'before-send' | 'after-send', objective?: string, loopAfterTurn?: boolean) => Promise<void>;
  changed: () => void;
};
let deliveryHooks: InputDeliveryHooks | null = null;
let turnQueries!: ReturnType<typeof createInputTurnQueries>;
const admission = createInputAdmission({
  getSession,
  isChatBlocked,
  goalDrivingMode,
  automaticFinishEnabled,
  finishToolEnabled: () => getConfig().ui.finishTool === true,
  finishLeadMinutes: () => getConfig().ui.finishLeadMinutes,
  assignSessionProject,
  createSession,
  userTitle,
  prepareText: (entry, limits, authored) => deliveryHooks?.prepareText?.(entry, limits, authored) ?? entry.text
});
const { append, finishInputCurrent, materializeOpening, materializeStages, prepare, target } = admission;
const openingLifecycle = createInputOpeningLifecycle({
  findSessionByConversation,
  getSession,
  deleteSession,
  assignSessionProject,
  materializeOpening,
  changed: () => deliveryHooks?.changed()
});
const { migrateLegacyOpeningOwners, removeWithdrawnOpening } = openingLifecycle;
const deliveryAuthorization = createInputDeliveryAuthorization({
  serial,
  load,
  commit,
  ordered,
  target,
  sameDelivery,
  getSession,
  readRecentEvents,
  sessionInputPolicy,
  readBrowserInputAllowed,
  readEligibleStageEnd,
  readRecoveryInvalidReason,
  recoveryAllowed: (sessionId, conversationId) => deliveryHooks?.recoveryAllowed?.(sessionId, conversationId),
  callsHoldRecovery: conversationId => deliveryHooks?.callsHoldRecovery
    ? deliveryHooks.callsHoldRecovery(conversationId)
    : inFlightToolCalls(conversationId) > 0,
  consumeGoalReplyForInputNow: (conversationId: string, sessionId: string, sourceTurnId: string) =>
    consumeGoalReplyForInputNow(conversationId, sessionId, sourceTurnId),
  turnQueries: () => turnQueries
});
const { authorizeBrowserInput, browserInputAllowed, eligibleStageEnd, nextAfterTurnLocalInput, recoveryCurrent, recoveryInvalidReason } = deliveryAuthorization;
/** Installed once by IPC before bridge/MCP startup; avoids a Goal/input import cycle. */
export function configureInputDelivery(hooks: InputDeliveryHooks): void { deliveryHooks = hooks; }
/** Reads current policy through the live hooks installed by IPC. */
export function sessionInputPolicy(sessionId: string, observedActivity?: InputActivity) {
  return readSessionInputPolicy(sessionId, observedActivity, deliveryHooks?.activity);
}
const inputListeners = new Set<() => void>();
export function onInputChange(listener: () => void): () => void {
  inputListeners.add(listener);
  return () => { inputListeners.delete(listener); };
}
let entries: InputEntry[] | null = null;
let chain: Promise<unknown> = Promise.resolve();
let queueExpiration: ReturnType<typeof createInputQueueExpiration>['expireQueued'] | null = null;
// A timestamp written before the claim commit cannot prove that its response was available. Restart discards this evidence and repeats the stable message id.
const offered = new Map<string, number>();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = chain.then(work, work);
  chain = result.catch(() => undefined);
  return result;
}

async function load(): Promise<InputEntry[]> {
  if (entries) return expireQueued(entries);
  const raw = await readDurable<unknown>(STATE);
  const parsed = z.array(entrySchema).safeParse(raw ?? []);
  if (!parsed.success) throw new Error('The message outbox could not be read safely');
  entries = parsed.data;
  entries = await inputStartupRecovery.recover(entries);
  return expireQueued(entries);
}
async function expireQueued(current: InputEntry[]): Promise<InputEntry[]> {
  if (!queueExpiration) throw new Error('Input queue expiration is not initialized');
  return queueExpiration(current);
}
async function commit(next: InputEntry[]): Promise<void> {
  // A temporary planner keeps only ownership metadata across restart, never its task or answer.
  const durableRows = (rows: InputEntry[]) => rows.map(row => row.lifetime === 'temporary-planner'
    ? { ...row, text: '[Temporary planner]', deliveryText: undefined, response: undefined } : row);
  try { await writeDurableNow(STATE, durableRows(next)); }
  catch (error) {
    // durable.ts retries failed generations. Never let a rejected send claim or enqueue become live later behind the caller's back.
    writeDurableSoon(STATE, durableRows(entries ?? []));
    throw error;
  }
  entries = next;
  wakeBrowserWork();
  for (const listener of inputListeners) { try { listener(); } catch { /* observer only */ } }
  try { deliveryHooks?.changed(); } catch { /* a detached renderer does not undo a durable commit */ }
}
/** Run under the existing serial queue before origin repair or checkpoint publication. */
const { retireRemovedSessionReceipts } = createInputSessionReceiptRetirement({
  sessionDirectoryMissing,
  needsHistory,
  pendingStages,
  commit
});
/** Reserve the attempt durably before crossing into Goal's control ledger. The failed row is the crash tombstone: an ambiguous settings write is never replayed after a later user Off. Only this live operation may replace it with the successful delivery. */
async function transition(current: InputEntry[], next: InputEntry[], automated: InputEntry[], phase: 'before-send' | 'after-send'): Promise<void> {
  if (automated.length) {
    if (!deliveryHooks) throw new Error('Input delivery is not ready');
    const reserved = new Map(automated.flatMap(entry => next.filter(row => sameDelivery(entry, row)).map(row => [row.id, row] as const)));
    await commit(current.map((entry): InputEntry => {
      const claimed = reserved.get(entry.id);
      return claimed ? { ...claimed, state: 'failed', error: phase === 'after-send'
        ? 'Message sent, but automation was not confirmed. Check its chat settings.'
        : 'Automation was not confirmed; this message was not sent. Send again to retry.' } : entry;
    }));
    for (const entry of automated) await deliveryHooks.applyAutomation(entry.conversationId!, entry.automation!, phase, entry.objective, entry.loopAfterTurn);
  }
  await commit(next);
}
const historyProjection = createInputHistoryProjection({
  serial,
  load,
  commit,
  retireRemovedSessionReceipts,
  findSessionByConversation,
  materializeStages,
  ordered,
  needsHistory,
  companionOf,
  combinedInput,
  getSession,
  readRecentEvents,
  readCompletedFinal,
  inFlightToolCalls,
  deliveredRecorder: () => deliveryHooks?.recordDelivered ?? null
});
export const listInputs = historyProjection.listInputs;
const publishHistory = historyProjection.publishHistory;
const settleToolInputFromFinal = historyProjection.settleToolInputFromFinal;
const browserDecisionService = createBrowserDecisionService({
  load,
  listInputs,
  serial,
  commit,
  append: (current, entry) => append(current, entry),
  wakeDecision: async (entry, signal) => { await deliveryHooks?.wakeDecision?.(entry, signal); }
});

function bindChatOrigin(...args: Parameters<typeof noteChatOrigin>) {
  return noteChatOrigin(...args);
}

const inputStartupRecovery = createInputStartupRecovery({
  migrateLegacyOpeningOwners,
  terminal,
  materializeOpening,
  commit,
  removeWithdrawnOpening,
  retireRemovedSessionReceipts,
  listUsageSessions,
  noteChatOrigin: bindChatOrigin,
  bindHelper: (conversationId, sourceSessionId) => deliveryHooks?.bindHelper?.(conversationId, sourceSessionId),
  hasDecisionWaiter: id => browserDecisionService.hasWaiter(id),
  invalidateLoadedState: () => { entries = null; }
});
export const publishBrowserDecision = browserDecisionService.publishBrowserDecision;
export const requestBrowserDecision = browserDecisionService.requestBrowserDecision;
export const completeBrowserDecision = browserDecisionService.completeBrowserDecision;
export const collectRecordedBrowserDecision = browserDecisionService.collectRecordedBrowserDecision;
const pickupRecoveryService = createPickupRecoveryService({
  load,
  serial,
  commit,
  eligibleStageEnd,
  getSession,
  activity: session => deliveryHooks?.activity?.(session),
  recoveryAllowed: (sessionId, conversationId) => deliveryHooks?.recoveryAllowed?.(sessionId, conversationId),
  isChatBlocked,
  conversationWasSuperseded,
  inFlightToolCalls,
  readRecentEvents,
  logInfo
});
export const syncQueuedPickupRecoveryNow = pickupRecoveryService.syncQueuedPickupRecoveryNow;
export const recordQueuedPickupAttemptNow = pickupRecoveryService.recordQueuedPickupAttemptNow;
export const retryUnclaimedInput = pickupRecoveryService.retryUnclaimedInput;
turnQueries = createInputTurnQueries({
  serial,
  load,
  ordered,
  getSession,
  readRecentEvents,
  eligibleStageEnd,
  browserInputAllowed,
  pickupRecovery: pickupRecoveryService
});
export const { hasEligibleToolInput, hasQueuedAfterTurnInput, pendingQueuedPickups, inputBeforeGoal, finishNeedsBrowserInput } = turnQueries;
const recoveryOperations = createInputRecoveryOperations({
  serial, load, commit, append: (current, entry) => append(current, entry), terminal, ordered,
  manualInput, queuedFollowup, queuedAfterTurn: turnQueries.queuedAfterTurn, consumedTurn: turnQueries.consumedTurn,
  eligibleStageEnd, recoveryCurrent, recoveryInvalidReason,
  getSession, isChatBlocked, inFlightToolCalls, readLatestUserMessage: (id, turn) => readLatestUserMessage(id, turn),
  readRecentEvents, workSequence, turnHasMcpCall,
  recoveryBusyMs, recoveryMessage, isProModel, logInfo
});
const releaseRecoveryClaim = recoveryOperations.releaseRecoveryClaim;
const withoutSilenceClaim = recoveryOperations.withoutSilenceClaim;
queueExpiration = createInputQueueExpiration({
  getSession,
  readRecentEvents,
  recoveryInvalidReason,
  finishInputCurrent,
  activity: session => deliveryHooks?.activity?.(session),
  settleToolInputFromFinal,
  releaseRecoveryClaim,
  commit,
  logInfo,
  currentEntries: () => entries!
}).expireQueued;
export const fileRecoveryInput = recoveryOperations.fileRecoveryInput;
export const advanceRecoveryInput = recoveryOperations.advanceRecoveryInput;
export const fileSilenceInput = recoveryOperations.fileSilenceInput;
export const deferSilenceInput = recoveryOperations.deferSilenceInput;
export const revokeSilenceInputs = recoveryOperations.revokeSilenceInputs;

export const enqueueInput = createInputEnqueuer({
  serial,
  load,
  terminal,
  neverAuthorized,
  sessionInputPolicy,
  activityFor: session => deliveryHooks?.activity?.(session) ?? null,
  materializeOpening,
  target,
  finishInputCurrent,
  append,
  materializeStages,
  commit
});
const queueControls = createInputQueueControls({
  serial,
  load,
  commit,
  materializeOpening,
  automationHooks: () => deliveryHooks,
  rejectBrowserDecision: (id, error) => browserDecisionService.rejectWaiter(id, error),
  removeWithdrawnOpening: async id => {
    const current = entries ?? [];
    const row = current.find(entry => entry.id === id);
    if (row) await removeWithdrawnOpening(row, current);
  }
});
export const { cancelInput, reorderQueuedInputs, cancelFinishInputs, editQueuedInput, setInputAutomation, noteInputStartupError } = queueControls;
export { authorizeBrowserInput, nextAfterTurnLocalInput };

export const inputBrowserClaimRuntime = {
  MAX_INPUT_IMAGES,
  hasDecisionWaiter: (id: string) => browserDecisionService.hasWaiter(id),
  browserInputAllowed,
  browserInputModel,
  commit,
  combinedInput,
  companionOf,
  completedStageBoundary: turnQueries.completedStageBoundary,
  consumeGoalReplyForInputNow: (conversationId: string, sessionId: string, sourceTurnId: string) =>
    consumeGoalReplyForInputNow(conversationId, sessionId, sourceTurnId),
  eligibleStageEnd,
  finishInstruction,
  getConfig,
  getSession,
  inputArgs,
  isAstraModel,
  load,
  logInfo,
  manualInput,
  ordered,
  prepare,
  preparable,
  projectWorkspace,
  queuedAfterTurn: turnQueries.queuedAfterTurn,
  queuedFollowup,
  readRecentEvents,
  sameDelivery,
  serial,
  target,
  transition,
  turnHasMcpCall
};

export const inputDeliveryReceiptRuntime = {
  assignSessionProject,
  browserDecisionService,
  commit,
  companionOf,
  consumeGoalReplyForInputNow: (conversationId: string, sessionId: string, sourceTurnId: string) =>
    consumeGoalReplyForInputNow(conversationId, sessionId, sourceTurnId),
  conversationWasSuperseded,
  createSession,
  deliveryHooks: () => deliveryHooks,
  eligibleStageEnd,
  findSessionByConversation,
  getConfig,
  getSession,
  isApiConversationId,
  listInputs,
  logInfo,
  logWarn,
  load,
  materializeOpening,
  noteChatOrigin: bindChatOrigin,
  publishHistory,
  providerForConversationId,
  rebindSession,
  releaseRecoveryClaim,
  sameDelivery,
  serial,
  terminal,
  transition,
  UNCONFIRMED_SEND,
  userTitle,
  withoutSilenceClaim,
  RECEIPT_UNCONFIRMED
};

const deliveryReceipts = createInputDeliveryReceipts(inputDeliveryReceiptRuntime);
export const {
  acceptLocalExecutorInput,
  acknowledgeBrowserInput,
  authorizeBrowserHelperRetry,
  bindBrowserInputProject,
  endRecoveryInput,
  failBrowserInput,
  failLocalExecutorInput,
  pausedBrowserHelpers
} = deliveryReceipts;
const browserClaims = createInputBrowserClaims(inputBrowserClaimRuntime);
export const pendingBrowserInputs = browserClaims.pendingBrowserInputs;
export const claimBrowserInput = browserClaims.claimBrowserInput;
const toolDelivery = createInputToolDelivery({
  serial,
  load,
  getSession,
  commit,
  terminal,
  offered,
  publishHistory,
  ordered,
  prepare,
  activity: session => deliveryHooks?.activity?.(session),
  transition
});
export const { acknowledgeToolInput, offerToolInput } = toolDelivery;

export function resetInputForTests(): void { entries = null; chain = Promise.resolve(); offered.clear(); browserDecisionService.reset(); }
