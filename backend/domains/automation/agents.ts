// Independent prime-owned worker families. Each active incarnation has its own maxWorkers admission limit. Conversation identity resolves an owner; local names such as worker-1 never select an owner. Browser transactions additionally carry the exact incarnation ID. When a family's last worker stops, its full history parks under its prime conversation. Waking that family creates a fresh incarnation without changing any worker conversation. The continuation transaction alone can transfer the prime binding to another conversation. Spawn/message/finish plans cross the existing durable snapshot barrier before publication. Every closure retains its exact owner/agent objects, so another owner's work cannot change where a pending transaction commits or rolls back. Slots are admission, never eviction: workers that prove they were still running remain recognized even above the current limit.

import type { SwarmState } from '../../../contracts/session.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { releasePrimeWorkspace, bindAgentWorkspace } from '../workspace/workspace.js';
import { requestCorrelation } from '../sessions/history/correlation.js';
import { getSession, findSessionByConversation } from '../sessions/history/store.js';
import { continuationForSession } from '../sessions/continuity/continuation.js';
import { createAgentRequestOwnership } from './agents-request-ownership.js';
import { createAgentBindings } from './agents-bindings.js';
import { createAgentControls } from './agents-controls.js';
import { createAgentDurability } from './agents-durability.js';
import { createAgentPersistence } from './agents-persistence.js';
import { createAgentLifecycle } from './agents-lifecycle.js';
import { createAgentMessage, createAgentMessaging } from './agents-messaging.js';
import { createAgentRevival } from './agents-revival.js';
import { createAgentModelPolicy } from './agents-model-policy.js';
import { createAgentIdentity, type Caller } from './agents-identity.js';
import { createAgentCapacity } from './agents-capacity.js';
import { createAgentSpawner, createPrimeAgent, createWorkerBootstrapRequester } from './agents-spawning.js';
import { isLocalAgentDeliveryActive, onSpawnRequest, pendingWorkerSpawns, setLocalAgentDeliveryActive } from './agents-bridge-registration.js';
import { createAgentFinishing } from './agents-finishing.js';
import { createAgentReadModel } from './agents-read-model.js';
import { createAgentRunRegistry } from './agents-run-registry.js';
import { createAgentStateReset } from './agents-reset.js';
import { canStageFinish, canStop, ceilingCrossed, hasStopped, isOver, occupiesSlot, WORKER_CONTEXT_CEILING_TOKENS } from './agents-state-policy.js';
import { PRIME_ID } from './agents-types.js';
import type { Agent, Run } from './agents-types.js';
import { AgentError, AgentsBusyError, IdentityLostError } from './agents-errors.js';
import { DORMANT_RUN_TTL_MS, MAX_BATCH_MESSAGES, MAX_CONTEXT_CHARS, MAX_DORMANT_RUNS, MAX_INBOX_OFFER_CHARS, MAX_LABEL_CHARS, MAX_MESSAGE_CHARS, MAX_QUEUE, MAX_TASK_CHARS, PAGE_GENERATING_FRESH_MS, RETIRED_WORKER_TTL_MS, WAKE_FAILURES_BEFORE_GIVING_UP, WORKER_SILENCE_MS, WORKER_THINKING_MAX_MS } from './agents-limits.js';
import { activeFinishStages, activeSpawnStages, consecutiveWakeFailures, dormantRuns, getLivenessFloor, getSpawnRequest, pageGenerating, retiredWorkers, runs, setLivenessFloor, setLocalAgentDeliveryActive as writeLocalAgentDeliveryActive, setSpawnRequest, unpublishedAgents, unpublishedMessages, unpublishedRuns } from './agents-runtime-state.js';
export { PRIME_ID } from './agents-types.js';
export { isOver, occupiesSlot, WORKER_CONTEXT_CEILING_TOKENS } from './agents-state-policy.js';
export type { Agent, CallerSwarmStatus, ClearResult, DormantRun, FinishStageState, RetiredChat, Run, SpawnStageState, WorkerSpawn } from './agents-types.js';
export { AgentError, AgentsBusyError, IdentityLostError } from './agents-errors.js';
export { MAX_BATCH_MESSAGES, MAX_MESSAGE_CHARS, PAGE_GENERATING_FRESH_MS, WAKE_FAILURES_BEFORE_GIVING_UP, WORKER_SILENCE_MS, WORKER_THINKING_MAX_MS } from './agents-limits.js';
export type { WorkerPrimeOwner } from './agents-read-model.js';
import type { FinishResult, StagedFinish } from './agents-finishing.js';
export type { FinishResult, StagedFinish } from './agents-finishing.js';
export type { Caller, Family, FamilyOwner } from './agents-identity.js';
export type { SpawnInput, SpawnResult, StagedSpawn } from './agents-spawning.js';
export type { WorkerRevival } from './agents-revival.js';
export type { StagedAgentMessages, StagedPrimeMessage } from './agents-messaging.js';
export type { AliveResult } from './agents-lifecycle.js';
import type { RetiredWorkersSnapshot, SwarmSnapshot } from './agents-persistence.js';
export type { RetiredWorkersSnapshot, SwarmSnapshot } from './agents-persistence.js';

let persistence: ReturnType<typeof createAgentPersistence>;
const durability = createAgentDurability({
  archiveWorkerAssignments: snapshot => persistence.archiveWorkerAssignments(snapshot),
  snapshotRetiredWorkers: () => persistence.snapshotRetiredWorkers(),
  snapshotSwarmIncludingUnpublished: () => persistence.snapshotSwarmIncludingUnpublished()
});
const { changed, endListeners } = durability;
export const {
  onRetiredWorkersPersist,
  onRetiredWorkersPersistNow,
  onSwarmChange,
  onSwarmEnd,
  onSwarmPersist,
  onSwarmPersistNow,
  persistAgentAuthorityNow,
  persistCriticalSwarmNow,
  persistRetiredWorkersNow
} = durability;

export { isLocalAgentDeliveryActive, onSpawnRequest, pendingWorkerSpawns, setLocalAgentDeliveryActive };


const identity = createAgentIdentity({
  primeId: PRIME_ID,
  runs,
  dormantRuns,
  unpublishedRuns,
  makeBusyError: () => new AgentsBusyError(),
  makeError: message => new AgentError(message),
  makeIdentityLostError: () => new IdentityLostError(),
  runForConversation: conversationId => runRegistry.runForConversation(conversationId),
  stateForAgents: (agents, running, retainedHistory) => stateForAgents(agents, running, retainedHistory),
  freeWorkerSlots: runId => capacity.freeWorkerSlots(runId),
  retiredAgent: caller => messaging.retiredAgent(caller)
});
const {
  allFamilies,
  answersTo,
  agentFamiliesForCaller,
  agentForCaller,
  agentForFinishCaller,
  agentForConversationId,
  boundedFormerRunIds,
  currentRunForCaller,
  dormantAgentForConversation,
  dormantRunForCaller,
  exactCaller,
  familiesForCaller,
  familyForAddress,
  familyKey,
  familyReplyAddress,
  hasCallerIdentity,
  identify,
  ownsPrime,
  requireEnabled,
  requireFamilySelection,
  requireMember,
  resolve,
  runForCaller,
  selectedFamily,
  statusForCaller,
  swarmStateForCaller
} = identity;
export { agentFamiliesForCaller, agentForCaller, agentForFinishCaller, currentRunForCaller, identify, statusForCaller, swarmStateForCaller };

const runRegistry = createAgentRunRegistry({
  boundedFormerRunIds: identity.boundedFormerRunIds,
  dormantRunTtlMs: DORMANT_RUN_TTL_MS,
  endListeners,
  familyKey: identity.familyKey,
  hasWorkingWorkers: run => capacity.workingWorkers(run).length > 0,
  logInfo,
  maxDormantRuns: MAX_DORMANT_RUNS,
  primeId: PRIME_ID,
  notifyChanged: () => changed(),
  persistRetiredWorkers: () => durability.persistRetiredWorkers(),
  releasePrimeWorkspace,
  retiredWorkerTtlMs: RETIRED_WORKER_TTL_MS,
  retiredWorkers,
  runs,
  dormantRuns,
  unpublishedRuns,
  consecutiveWakeFailures
});
const {
  activeRunIds,
  endRun,
  hasRetiredWorkerLeases,
  parkRun,
  pruneDormantRuns,
  pruneRetiredWorkers,
  reactivateDormantRun,
  retiredWorkerForConversation,
  runForAgent,
  runForConversation,
  scopedRun,
  stampOwner
} = runRegistry;
export { activeRunIds, hasRetiredWorkerLeases, retiredWorkerForConversation };

const requestOwnership = createAgentRequestOwnership({
  allFamilies,
  changed,
  continuationForSession: sessionId => continuationForSession(sessionId),
  findSessionByConversation: (conversationId, options) => findSessionByConversation(conversationId, options),
  getSession: sessionId => getSession(sessionId),
  isWorkerConversation,
  recordWorkerOrigin: async (conversationId, origin) => {
    const { noteChatOrigin } = await import('../sessions/history/recorder.js');
    await noteChatOrigin(conversationId, origin);
  },
  requestCorrelation: requestId => requestCorrelation(requestId),
  retiredWorkerForConversation,
  unpublishedRuns
});

export function reconcileAgentRequestOwners(): Promise<void> {
  return requestOwnership.reconcile();
}

export const agentsBindingRuntime = {
  get PRIME_ID() { return PRIME_ID; },
  get bindAgentWorkspace() { return bindAgentWorkspace; },
  get changed() { return changed; },
  get dormantAgentForConversation() { return dormantAgentForConversation; },
  get hasStopped() { return hasStopped; },
  get logInfo() { return logInfo; },
  get logWarn() { return logWarn; },
  get runForConversation() { return runForConversation; },
  get scopedRun() { return scopedRun; },
  get unpublishedAgents() { return unpublishedAgents; }
};
const bindings = createAgentBindings(agentsBindingRuntime);
const { boundAgent } = bindings;
export const { bindConversation } = bindings;

const makePrime = (conversationId: string | null): Agent => createPrimeAgent(conversationId, PRIME_ID);


const capacity = createAgentCapacity({ runs, unpublishedAgents, scopedRun, runForConversation, occupiesSlot });
export const { freeWorkerSlots, waitingForSubAgents } = capacity;
const { globalFreeWorkerSlots, globalOccupiedWorkerSlots, workingWorkers } = capacity;

function recount(agent: Agent): void {
  const live = agent.queue.filter((message) => message.ackedAt === null && !unpublishedMessages.has(message));
  agent.info.pending = live.length;
  agent.info.awaitingAck = live.filter((message) => message.offeredAt !== null).length;
}

function primeAgent(run: Run | null): Agent {
  const agent = run?.agents.get(PRIME_ID);
  if (!agent) throw new AgentError('No sub-agent run is active.');
  return agent;
}

const modelPolicy = createAgentModelPolicy({
  agentError: (message) => new AgentError(message)
});
const { normalizeModel, normalizeReasoningEffort } = modelPolicy;
export const isProviderModelId = modelPolicy.isModelId;

export const requestWorkerBootstraps = createWorkerBootstrapRequester({
  scopedRun,
  unpublishedAgents,
  spawnRequest: () => getSpawnRequest(),
  logWarn
});

const spawning = createAgentSpawner({
  PRIME_ID,
  MAX_CONTEXT_CHARS,
  MAX_TASK_CHARS,
  MAX_LABEL_CHARS,
  runs,
  dormantRuns,
  activeSpawnStages,
  unpublishedAgents,
  unpublishedRuns,
  makeAgentError: message => new AgentError(message),
  makeBusyError: () => new AgentsBusyError(),
  makeIdentityLostError: message => new IdentityLostError(message),
  requireEnabled,
  exactCaller,
  requireFamilySelection,
  runForCaller,
  hasCallerIdentity,
  resolve,
  ownsPrime,
  isWorkerConversation,
  retiredWorkerForConversation,
  dormantRunForCaller,
  reactivateDormantRun,
  familyKey,
  makePrime,
  stampOwner,
  workingWorkers,
  requestWorkerBootstraps,
  parkRun,
  globalOccupiedWorkerSlots,
  logInfo,
  changed,
  normalizeModel,
  normalizeReasoningEffort
});
export const { spawn, stageSpawn } = spawning;
const { settleSpawnStage } = spawning;
// Agent routing and inbox delivery are owned by agents-messaging.ts.
const newMessage = createAgentMessage;
let finishing: ReturnType<typeof createAgentFinishing> | null = null;

function activeFinishing(): ReturnType<typeof createAgentFinishing> {
  if (!finishing) throw new Error('Agent finishing is not initialized.');
  return finishing;
}

function runProjectionStillOwned(owner: Run): boolean {
  return activeFinishing().runProjectionStillOwned(owner);
}

function upgradeStagedFinishAtCeiling(agent: Agent): boolean {
  return activeFinishing().upgradeStagedFinishAtCeiling(agent);
}

export function stageFinishAgent(caller: Caller, result: string): StagedFinish {
  return activeFinishing().stageFinishAgent(caller, result);
}

export function finishAgent(caller: Caller, result: string): FinishResult {
  return activeFinishing().finishAgent(caller, result);
}

export function finishWorkerConversation(conversationId: string, result: string): FinishResult | null {
  return activeFinishing().finishWorkerConversation(conversationId, result);
}

export function stageWorkerConversationFinish(conversationId: string, result: string): StagedFinish | null {
  return activeFinishing().stageWorkerConversationFinish(conversationId, result);
}

export function failAgent(
  id: string,
  reason: string,
  note?: string,
  options: { revivable?: boolean } = {},
  runId?: string
): FinishResult | null {
  return activeFinishing().failAgent(id, reason, note, options, runId);
}
// Worker liveness and prime transfer are owned by agents-lifecycle.ts.
let readModel: ReturnType<typeof createAgentReadModel> | null = null;

function activeReadModel(): ReturnType<typeof createAgentReadModel> {
  if (!readModel) throw new Error('Agent read model is not initialized.');
  return readModel;
}

function stateForAgents(agents: Map<string, Agent>, running: boolean, retainedHistory = !running): SwarmState {
  return activeReadModel().stateForAgents(agents, running, retainedHistory);
}

export function isWorkerConversation(conversationId: string): boolean {
  return activeReadModel().isWorkerConversation(conversationId);
}

const agentsReadModelRuntime = {
  get PRIME_ID() { return PRIME_ID; },
  get allFamilies() { return allFamilies; },
  get answersTo() { return answersTo; },
  get agentForConversationId() { return agentForConversationId; },
  get dormantAgentForConversation() { return dormantAgentForConversation; },
  get dormantRuns() { return dormantRuns; },
  get familyKey() { return familyKey; },
  get getConfig() { return getConfig; },
  get runForConversation() { return runForConversation; },
  get runs() { return runs; },
  get scopedRun() { return scopedRun; },
  get unpublishedAgents() { return unpublishedAgents; },
  get unpublishedRuns() { return unpublishedRuns; }
};
readModel = createAgentReadModel(agentsReadModelRuntime);
export const {
  swarmState,
  agentConversation,
  agentForConversation,
  agentForOwnedConversation,
  primeForOwnedConversation,
  workerPrimeOwner,
  liveAgentForOwnedConversation,
  agentInfoForOwnedConversation
} = activeReadModel();
export const agentsControlRuntime = {
  get MAX_MESSAGE_CHARS() { return MAX_MESSAGE_CHARS; },
  get PRIME_ID() { return PRIME_ID; },
  get activeSpawnStages() { return activeSpawnStages; },
  get changed() { return changed; },
  get consecutiveWakeFailures() { return consecutiveWakeFailures; },
  get dormantRuns() { return dormantRuns; },
  get endRun() { return endRun; },
  get failAgent() { return failAgent; },
  get parkRun() { return parkRun; },
  persistRetiredWorkers: () => durability.persistRetiredWorkers(),
  get recount() { return recount; },
  get runs() { return runs; },
  get scopedRun() { return scopedRun; },
  get settleSpawnStage() { return settleSpawnStage; },
  get retiredWorkers() { return retiredWorkers; }
};
const controls = createAgentControls(agentsControlRuntime);
export const { clearAgent, pauseSwarmForDisable, resetSwarm } = controls;
export function snapshotRetiredWorkers(): RetiredWorkersSnapshot { return persistence.snapshotRetiredWorkers(); }
export function restoreRetiredWorkers(snapshot: RetiredWorkersSnapshot | null): void { persistence.restoreRetiredWorkers(snapshot); }
export function snapshotSwarm(): SwarmSnapshot | null { return persistence.snapshotSwarm(); }
export function restoreSwarm(snapshot: SwarmSnapshot | null): void { persistence.restoreSwarm(snapshot); }
export async function archiveWorkerAssignments(snapshot: SwarmSnapshot | null): Promise<void> { return persistence.archiveWorkerAssignments(snapshot); }

// Supplies snapshot persistence with the live agent state and lifecycle operations.
export const agentsPersistenceRuntime = {
  get PRIME_ID() { return PRIME_ID; },
  get RETIRED_WORKER_TTL_MS() { return RETIRED_WORKER_TTL_MS; },
  get activeFinishStages() { return activeFinishStages; },
  get activeSpawnStages() { return activeSpawnStages; },
  get boundedFormerRunIds() { return boundedFormerRunIds; },
  get changed() { return changed; },
  get dormantRuns() { return dormantRuns; },
  get isProviderModelId() { return isProviderModelId; },
  get occupiesSlot() { return occupiesSlot; },
  get parkRun() { return parkRun; },
  get pendingWorkerSpawns() { return pendingWorkerSpawns; },
  get pruneDormantRuns() { return pruneDormantRuns; },
  get pruneRetiredWorkers() { return pruneRetiredWorkers; },
  get recount() { return recount; },
  get retiredWorkers() { return retiredWorkers; },
  get runs() { return runs; },
  get spawnRequest() { return getSpawnRequest(); },
  get stampOwner() { return stampOwner; },
  get unpublishedAgents() { return unpublishedAgents; },
  get unpublishedMessages() { return unpublishedMessages; },
  get unpublishedRuns() { return unpublishedRuns; },
  get workingWorkers() { return workingWorkers; },
  resetRequestOwnerRecovery: () => requestOwnership.reset(),
  get criticalMutationRevision() { return durability.criticalMutationRevision; },
  set criticalMutationRevision(value: number) { durability.criticalMutationRevision = value; },
  get persistedCriticalRevision() { return durability.persistedCriticalRevision; },
  set persistedCriticalRevision(value: number) { durability.persistedCriticalRevision = value; },
  get criticalPersistFlight() { return durability.criticalPersistFlight; },
  set criticalPersistFlight(value: Promise<boolean> | null) { durability.criticalPersistFlight = value; },
  get livenessFloor() { return getLivenessFloor(); },
  set livenessFloor(value: number) { setLivenessFloor(value); },
};
persistence = createAgentPersistence(agentsPersistenceRuntime);

// Supplies the worker revival module with the current broker owners.
export const agentsRevivalRuntime = {
  get AgentError() { return AgentError; },
  get MAX_INBOX_OFFER_CHARS() { return MAX_INBOX_OFFER_CHARS; },
  get MAX_TASK_CHARS() { return MAX_TASK_CHARS; },
  get PRIME_ID() { return PRIME_ID; },
  get WAKE_FAILURES_BEFORE_GIVING_UP() { return WAKE_FAILURES_BEFORE_GIVING_UP; },
  get activeFinishStages() { return activeFinishStages; },
  get boundAgent() { return boundAgent; },
  get canStop() { return canStop; },
  get changed() { return changed; },
  get ceilingCrossed() { return ceilingCrossed; },
  get consecutiveWakeFailures() { return consecutiveWakeFailures; },
  get dormantRuns() { return dormantRuns; },
  get failAgent() { return failAgent; },
  get freeWorkerSlots() { return freeWorkerSlots; },
  get globalFreeWorkerSlots() { return globalFreeWorkerSlots; },
  get logInfo() { return logInfo; },
  get logWarn() { return logWarn; },
  get newMessage() { return newMessage; },
  get primeAgent() { return primeAgent; },
  get recount() { return recount; },
  get runForAgent() { return runForAgent; },
  get runForConversation() { return runForConversation; },
  get runs() { return runs; },
  get scopedRun() { return scopedRun; },
  get unpublishedMessages() { return unpublishedMessages; }
};
const revival = createAgentRevival(agentsRevivalRuntime);
export const {
  failWorkerRevival,
  claimWorkerRevival,
  noteWorkerRevived,
  onReviveRequest,
  pendingWorkerRevivals,
  requestWorkerRevivals,
  rollbackWorkerRevivalClaim,
  sleepWorker,
  stageQueuedWorkerRevivals,
  workerRevivalClaimed,
  workerRevivalDeliveredSince
} = revival;
const { beginRevival, finishStoppedWorkerAtCeiling, primeForOwnedAgent, returnWakingWorkerToStopped, sleepAgent } = revival;

const resetAgentStateForTests = createAgentStateReset({
  activeFinishStages,
  activeSpawnStages,
  consecutiveWakeFailures,
  dormantRuns,
  durability,
  pageGenerating,
  persistence,
  requestOwnership,
  retiredWorkers,
  revival,
  runs,
  setLivenessFloor,
  setSpawnRequest,
  unpublishedRuns,
  writeLocalAgentDeliveryActive
});

/** Test seam: forgets everything without touching disk. */
export function resetAgentsForTests(): void {
  resetAgentStateForTests();
}


// Supplies worker lifecycle operations with the current broker state.
export const agentsLifecycleRuntime = {
  get PAGE_GENERATING_FRESH_MS() { return PAGE_GENERATING_FRESH_MS; },
  get PRIME_ID() { return PRIME_ID; },
  get WORKER_CONTEXT_CEILING_TOKENS() { return WORKER_CONTEXT_CEILING_TOKENS; },
  get WORKER_SILENCE_MS() { return WORKER_SILENCE_MS; },
  get WORKER_THINKING_MAX_MS() { return WORKER_THINKING_MAX_MS; },
  get allFamilies() { return allFamilies; },
  get boundAgent() { return boundAgent; },
  get ceilingCrossed() { return ceilingCrossed; },
  get changed() { return changed; },
  get consecutiveWakeFailures() { return consecutiveWakeFailures; },
  get dormantAgentForConversation() { return dormantAgentForConversation; },
  get dormantRuns() { return dormantRuns; },
  get endRun() { return endRun; },
  get finishStoppedWorkerAtCeiling() { return finishStoppedWorkerAtCeiling; },
  getLivenessFloor,
  get hasStopped() { return hasStopped; },
  get isOver() { return isOver; },
  get logInfo() { return logInfo; },
  get newMessage() { return newMessage; },
  get occupiesSlot() { return occupiesSlot; },
  get pageGenerating() { return pageGenerating; },
  get primeAgent() { return primeAgent; },
  get reactivateDormantRun() { return reactivateDormantRun; },
  get recount() { return recount; },
  get runForAgent() { return runForAgent; },
  get runForConversation() { return runForConversation; },
  get runs() { return runs; },
  get scopedRun() { return scopedRun; },
  get sleepAgent() { return sleepAgent; },
  get unpublishedAgents() { return unpublishedAgents; },
  get upgradeStagedFinishAtCeiling() { return upgradeStagedFinishAtCeiling; }
};

const lifecycle = createAgentLifecycle(agentsLifecycleRuntime);
export const { reactivateDormantRunForConversation, silentCeilingRecoveryTurn, silentCeilingRecoveryAuthority, silentCeilingWorkerNotice, recoverSilentCeilingWorker, reactivateSilentCeilingRunForTerminal, finishSilentCeilingWorker, noteAgentContextTokens, swarmRunning, primeConversation, currentRunId, swarmTransferActive, primeConversationGone, workerConversationGone, noteAgentAlive, endedWorkerNotice, notePageGenerating, sleepSilentWorkers, beginPrimeTransfer, cancelPrimeTransfer, freezePrimeTransfer, thawPrimeTransfer, commitPrimeTransfer, dormantWorkerNotice, closableWorkerConversations, hasDormantWorkerLeases, primeFleetIn, repairPrimeConversationAfterRecovery } = lifecycle;


// Supplies message orchestration with the current broker state and policy helpers.
export const agentsMessagingRuntime = {
  get AgentError() { return AgentError; },
  get IdentityLostError() { return IdentityLostError; },
  get MAX_BATCH_MESSAGES() { return MAX_BATCH_MESSAGES; },
  get MAX_INBOX_OFFER_CHARS() { return MAX_INBOX_OFFER_CHARS; },
  get MAX_LABEL_CHARS() { return MAX_LABEL_CHARS; },
  get MAX_MESSAGE_CHARS() { return MAX_MESSAGE_CHARS; },
  get MAX_QUEUE() { return MAX_QUEUE; },
  get PRIME_ID() { return PRIME_ID; },
  get activeFinishStages() { return activeFinishStages; },
  get activeSpawnStages() { return activeSpawnStages; },
  get allFamilies() { return allFamilies; },
  get answersTo() { return answersTo; },
  get beginRevival() { return beginRevival; },
  get boundAgent() { return boundAgent; },
  get changed() { return changed; },
  get dormantAgentForConversation() { return dormantAgentForConversation; },
  get dormantRunForCaller() { return dormantRunForCaller; },
  get exactCaller() { return exactCaller; },
  get familiesForCaller() { return familiesForCaller; },
  get familyForAddress() { return familyForAddress; },
  get familyKey() { return familyKey; },
  get familyReplyAddress() { return familyReplyAddress; },
  get freeWorkerSlots() { return freeWorkerSlots; },
  get getConfig() { return getConfig; },
  get globalFreeWorkerSlots() { return globalFreeWorkerSlots; },
  get hasCallerIdentity() { return hasCallerIdentity; },
  get hasStopped() { return hasStopped; },
  get isOver() { return isOver; },
  get newMessage() { return newMessage; },
  get ownsPrime() { return ownsPrime; },
  get parkRun() { return parkRun; },
  get recount() { return recount; },
  get reactivateDormantRun() { return reactivateDormantRun; },
  get requireEnabled() { return requireEnabled; },
  get requireFamilySelection() { return requireFamilySelection; },
  get requireMember() { return requireMember; },
  get returnWakingWorkerToStopped() { return returnWakingWorkerToStopped; },
  get runForCaller() { return runForCaller; },
  get runForConversation() { return runForConversation; },
  get runProjectionStillOwned() { return runProjectionStillOwned; },
  get runs() { return runs; },
  get scopedRun() { return scopedRun; },
  get selectedFamily() { return selectedFamily; },
  get unpublishedAgents() { return unpublishedAgents; },
  get unpublishedMessages() { return unpublishedMessages; },
  get workingWorkers() { return workingWorkers; }
};

const messaging = createAgentMessaging(agentsMessagingRuntime);
export const { sendMessage, stagePrimeMessage, stageMessages, sendMessages, offerMessages, offerMessagesForConversation, offerMessagesForCaller, acknowledgeOffers, acknowledgeOffersForConversation, acknowledgeOffersForCaller, pendingCount, releaseQuiescentRun, retiredAgent } = messaging;

export const agentsFinishingRuntime = {
  get AgentError() { return AgentError; },
  get AgentsBusyError() { return AgentsBusyError; },
  get IdentityLostError() { return IdentityLostError; },
  get MAX_MESSAGE_CHARS() { return MAX_MESSAGE_CHARS; },
  get PRIME_ID() { return PRIME_ID; },
  get activeFinishStages() { return activeFinishStages; },
  get agentForConversationId() { return agentForConversationId; },
  get canStageFinish() { return canStageFinish; },
  get canStop() { return canStop; },
  get changed() { return changed; },
  get ceilingCrossed() { return ceilingCrossed; },
  get dormantAgentForConversation() { return dormantAgentForConversation; },
  get dormantRuns() { return dormantRuns; },
  get exactCaller() { return exactCaller; },
  get getConfig() { return getConfig; },
  get hasCallerIdentity() { return hasCallerIdentity; },
  get hasStopped() { return hasStopped; },
  get isOver() { return isOver; },
  get logInfo() { return logInfo; },
  get logWarn() { return logWarn; },
  get newMessage() { return newMessage; },
  get occupiesSlot() { return occupiesSlot; },
  get primeAgent() { return primeAgent; },
  get primeForOwnedAgent() { return primeForOwnedAgent; },
  get recount() { return recount; },
  get requireEnabled() { return requireEnabled; },
  get requireFamilySelection() { return requireFamilySelection; },
  get resolve() { return resolve; },
  get retiredAgent() { return retiredAgent; },
  get runForAgent() { return runForAgent; },
  get runForConversation() { return runForConversation; },
  get runs() { return runs; },
  get scopedRun() { return scopedRun; }
};
finishing = createAgentFinishing(agentsFinishingRuntime);

export { agentsReadModelRuntime };
