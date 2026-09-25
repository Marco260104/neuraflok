import type { bridgeRecoveryControlRuntime } from './bridge.js';
import { noticeChatStopped } from '../../infrastructure/desktop-shell/stuck-notice.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { runningToolCalls } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { agentInfoForOwnedConversation, liveAgentForOwnedConversation, pendingWorkerRevivals } from '../automation/agents.js';
import { goalPendingReplyFor, loopAfterTurnFor } from '../automation/goal.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { pendingContinuations } from '../sessions/continuity/continuation.js';
import { liveConversations, recordNote } from '../sessions/history/recorder.js';
import { getSession, findSessionByConversation, turnHasMcpCall } from '../sessions/history/store.js';
import { hasQueuedAfterTurnInput } from '../sessions/input/input.js';
import { createBridgeRecoveryPolicy } from './bridge-recovery-policy.js';
import { createBridgeRepairFeedback } from './bridge-repair-feedback.js';
import { createBridgePickupRecovery } from './bridge-pickup-recovery.js';
import { createBridgeActivityPolicy } from './bridge-activity-policy.js';
import { createBridgeAttributionRecovery, UNATTRIBUTED_FINAL_WINDOW_MS, UNATTRIBUTED_FIRST_WINDOW_MS, UNATTRIBUTED_SINGLE_WINDOW_MS } from './bridge-attribution-recovery.js';
import { createBridgeRecoveryReadModel } from './bridge-recovery-read-model.js';
import { createBridgeRecoveryNotices } from './bridge-recovery-notices.js';
import { createBridgeTabRecovery } from './bridge-tab-recovery.js';
import { createBridgeGoalRecovery } from './bridge-goal-recovery.js';
import { createBridgeSilenceSchedule } from './bridge-silence-schedule.js';
import { createBridgeSilenceTickets } from './bridge-silence-tickets.js';
import { createBridgeAssistantRecovery } from './bridge-assistant-recovery.js';
import { createBridgeSilenceMonitor } from './bridge-silence-monitor.js';
import { createBridgePendingRepairs } from './bridge-pending-repairs.js';
import { createBridgeRepairConfirmation } from './bridge-repair-confirmation.js';
import { createBridgeUnattributedRecoveryTimer } from './bridge-unattributed-recovery-timer.js';
import { createBridgeRepairQueue } from './bridge-repair-queue.js';
import { createBridgeAutomaticCompaction } from './bridge-automatic-compaction.js';
import { createBridgeRecoveryIncidentState } from './bridge-recovery-incident-state.js';
import type { Repair } from './bridge-recovery-types.js';
import { activeUntil, activityDeadline, PRO_ACTIVITY_MS } from './session-activity.js';
import type { ActivityGrant } from './session-activity.js';

// Owns browser activity, silence recovery, compaction pickup and repair policy.
type Runtime = typeof bridgeRecoveryControlRuntime;

export type { Repair } from './bridge-recovery-types.js';

// Recovery uses phase-specific bounded pickup schedules for asking, writing, and opening; page activity never grants a second Send.
export function createBridgeRecoveryControl(runtime: Runtime) {
  const { BROWSER_RECOVERY_COOLDOWN_MS, awaitingReturn, browserPresent, changed, chatIsWorking, chatUrl, deliverOne, goalActiveFor, goalFencedChat, goalModeFor, goalWorkerChat, liveTurnIsCurrent, recoveryInputAllowed, rememberToken, runStaleSwarmSweep, stopRequestedFor } = runtime;
  const recoveryNotices = createBridgeRecoveryNotices({ logInfo, logWarn });
  const { noteFiberHealth, noticeRefusal, noteSilence, noticeMarkedReplacement } = recoveryNotices;
  const { FIBER_HEALTH_GRACE_MS, FIBER_HEALTH_GAP_MS, fiberHealth, REFUSAL_NOTICE_EVERY_MS, refusalNoticedAt, silenceNotes, markedReplacementNotices } = recoveryNotices.state;
  const recoveryIncidents = createBridgeRecoveryIncidentState();
  let recoveryReadModel: ReturnType<typeof createBridgeRecoveryReadModel>;
  let pendingRepairs: ReturnType<typeof createBridgePendingRepairs>;
  let pickupRecovery!: ReturnType<typeof createBridgePickupRecovery>;
  let recoveryPolicy!: ReturnType<typeof createBridgeRecoveryPolicy>;
  // Last attributed tool activity is the shared evidence for Goal settling and repair decisions.
  const lastAttributedCallAt = new Map<string, number>();
  const GOAL_QUIET_MS = 60_000;
  const goalRecovery = createBridgeGoalRecovery({
    activeUntil,
    chatIsWorking,
    lastAttributedCallAt,
    sessionRecoveryCountdowns: (sessionId, conversationId) => recoveryReadModel.sessionRecoveryCountdowns(sessionId, conversationId)
  });
  const {
    chatStillWorking,
    extendedSilenceWindowFor,
    failedCompactionTurnCurrent,
    goalInputPriority,
    goalWaitFor,
    revokeSilenceLoop,
    silenceContinuationAllowed,
    suppressProSilence
  } = goalRecovery;
  const automaticCompaction = createBridgeAutomaticCompaction({
    goalFencedChat,
    stopRequestedFor,
    liveTurnIsCurrent,
    failedCompactionTurnCurrent,
    rememberToken,
    changed
  });
  const { considerAutomaticCompaction, compactionFilings } = automaticCompaction;
  let scheduleSilenceSweep: (now?: number) => void = () => {};
  function armSilenceSweep(now = Date.now()): void {
    scheduleSilenceSweep(now);
  }
  const activityPolicy = createBridgeActivityPolicy({
    awaitingReturn,
    stopRequestedFor,
    armSilenceSweep,
    considerAutomaticCompaction,
  });
  const {
    grantActivity,
    silenceHeldByCalls,
    recoveryHeldByCalls,
    silenceWindowMs,
    sessionInputActivity,
    unknownCallHold,
    UNKNOWN_CALL_HOLD_MS,
    PRO_SILENCE_MS,
    DELIBERATE_SILENCE_MS,
  } = activityPolicy;
  let silenceMonitor: ReturnType<typeof createBridgeSilenceMonitor> | null = null;
  function currentSilenceMonitor(): ReturnType<typeof createBridgeSilenceMonitor> {
    if (!silenceMonitor) throw new Error('Browser silence monitor is unavailable.');
    return silenceMonitor;
  }
  async function inspectSilentChats(now: number): Promise<{ queued: boolean; spent: string[] }> {
    return currentSilenceMonitor().inspectSilentChats(now);
  }
  function finishSilentChats(conversationIds: readonly string[]): void {
    currentSilenceMonitor().finishSilentChats(conversationIds);
  }
  async function silenceSourceCurrent(conversationId: string, grant: ActivityGrant): Promise<boolean> {
    return recoveryPolicy.silenceSourceCurrent(conversationId, grant);
  }
  const silenceSchedule = createBridgeSilenceSchedule({
    state: runtime,
    grantActivity,
    runStaleSwarmSweep,
    inspectSilentChats,
    silenceSourceCurrent
  });
  scheduleSilenceSweep = silenceSchedule.armSilenceSweep;
  const { armResumedChat, restoreReturnedPageActivity, endActivity, forgetActivity } = silenceSchedule;

async function sessionRecoveryCountdowns(sessionId: string, conversationId: string) {
  return recoveryReadModel.sessionRecoveryCountdowns(sessionId, conversationId);
}

// One scheduler for bounded, request-specific incidents, including their spent budgets.
const {
  unattributedIncidents,
  UNATTRIBUTED_REQUEST_MEMORY,
  TURN_SCOPED_REPAIRS,
  repairsInFlight,
  lastBrowserRecoveryAt,
  turnRepairSpent,
  assistantRecoveryCancelled,
  failedTurnQuiet,
  UNCLAIMED_REPAIR_OFFERS,
  unclaimedRepairTold,
  pagelessChats
} = recoveryIncidents;

// Turn-scoped failures retire only after a later turn; chat-level repairs clear on activity.
recoveryPolicy = createBridgeRecoveryPolicy({
  runtime,
  repairsInFlight,
  getPickupWatch: conversationId => pickupRecovery.pickupWatch.get(conversationId),
  getPickupWatchCount: () => pickupRecovery.pickupWatch.size,
  getCompactionWatchCount: () => pickupRecovery.compactionWatch.size,
  owedPickups: now => pickupRecovery.owedPickups(now),
  compactionPhaseOf: entry => pickupRecovery.compactionPhaseOf(entry),
  silenceHeldByCalls,
  armSilenceSweep
});
const {
  departureAllowsRepair,
  departureAllowsRepairFor,
  workerRecoveryAllowed,
  retireInactiveWorkerRecovery,
  repairNeedsClaim,
  compactionRepairCurrent,
  silenceRepairCurrent,
  noteRecoveryActivity,
  browserTabPolicy,
  tabRecoveryWanted,
  browserRecoveryMonitoring
} = recoveryPolicy;
const attributionRecovery = createBridgeAttributionRecovery({
  incidents: unattributedIncidents,
  repairsInFlight,
  browserPresent,
  workerRecoveryAllowed,
  stopRequestedFor
});
const {
  repairCandidates,
  retireSpentRepairs,
  unattributedCandidateCurrent,
  pendingSuspects,
  unattributedRepairEta,
  attributionCandidateProven,
  attributionRepairAllowed,
  attributionRepairCurrent
} = attributionRecovery;

const silenceTickets = createBridgeSilenceTickets({
  repairsInFlight,
  lastBrowserRecoveryAt,
  get observationWritesInFlight() { return runtime.observationWritesInFlight; },
  PRO_SILENCE_MS,
  silenceWindowMs,
  stopRequestedFor,
  silenceHeldByCalls,
  recoveryInputAllowed,
  goalActiveFor,
  goalWorkerChat
});
const { fileSilenceInputTicket, fileSilenceTickets } = silenceTickets;

const assistantRecovery = createBridgeAssistantRecovery({ repairsInFlight, turnRepairSpent, assistantRecoveryCancelled });
const { assistantRecoveryCancelledFor, cancelAssistantRecovery, settledQuestionOf, assistantRepairSource, assistantRepairCurrent } = assistantRecovery;
// Consolidates repair triggers and bounds unclaimed offers for each recovery episode.
// A page-less verdict blocks repeated offers until the browser reports activity again.
const repairQueue = createBridgeRepairQueue({
  BROWSER_RECOVERY_COOLDOWN_MS,
  bridgeLifecycleEpoch: () => runtime.bridgeLifecycleEpoch,
  bridgeShutdownRequested: () => runtime.bridgeShutdownRequested,
  chatUrl,
  stopRequestedFor,
  repairsInFlight,
  turnRepairSpent,
  lastAttributedCallAt,
  lastBrowserRecoveryAt,
  activeUntil,
  turnScopedRepairs: TURN_SCOPED_REPAIRS,
  pagelessChats,
  getPickupWatch: conversationId => pickupWatch.get(conversationId),
  owedPickups: now => owedPickups(now),
  workerRecoveryAllowed,
  assistantRecoveryCancelledFor,
  departureAllowsRepairFor
});
const { queueBrowserRecovery } = repairQueue;

const unattributedRecoveryTimer = createBridgeUnattributedRecoveryTimer({
  incidents: unattributedIncidents,
  repairsInFlight,
  finalWindowMs: UNATTRIBUTED_FINAL_WINDOW_MS,
  retireSpentRepairs,
  pendingSuspects,
  getSession,
  attributionCandidateProven,
  queueBrowserRecovery,
  changed,
  logInfo,
  logWarn
});
const { armUnattributedTick, tickUnattributedIncident } = unattributedRecoveryTimer;

  pickupRecovery = createBridgePickupRecovery({
    runtime,
    repairsInFlight,
    pagelessChats,
    goalInputPriority,
    suppressProSilence,
    workerRecoveryAllowed,
    queueBrowserRecovery,
    deliver
  });
  const {
    compactionPhaseOf,
    expediteCompactionPickup,
    forgetGoalWatch,
    notePickupActivity,
    owedPickups,
    inspectOwedPickups,
    inspectOwedCompactions,
    PICKUP_BACKOFF_MS,
    pickupWatch,
    PICKUP_WATCH_LIFETIME_MS,
    COMPACTION_PICKUPS,
    compactionWatch,
    AUTOMATIC_ASKING_RETRY_PAUSE_MS,
    AUTOMATIC_ASKING_RETRY_BURSTS
  } = pickupRecovery;
  recoveryReadModel = createBridgeRecoveryReadModel({
    repairsInFlight,
    pickupWatch,
    unattributedIncidents,
    lastBrowserRecoveryAt,
    browserPresent,
    stopRequestedFor,
    workerRecoveryAllowed,
    departureAllowsRepair,
    assistantRepairCurrent,
    attributionRepairAllowed,
    silenceRepairCurrent,
    recoveryInputAllowed,
    goalActiveFor,
    goalModeFor,
    tabRecoveryWanted,
    pendingSuspects
  });
const tabRecovery = createBridgeTabRecovery({
  bridgeLifecycleEpoch: () => runtime.bridgeLifecycleEpoch,
  bridgeShutdownRequested: () => runtime.bridgeShutdownRequested,
  commands: () => runtime.commands,
  revivalDeliveryProven: command => runtime.revivalDeliveryProven(command),
  revivalFor: (agent, runId) => runtime.revivalFor(agent, runId),
  isConversationLive: conversationId => liveConversations().some(entry => entry.conversationId === conversationId),
  findSession: (conversationId, requireUnique = false) => findSessionByConversation(conversationId,
    requireUnique ? { requireUnique: true } : {}),
  agentInfo: agentInfoForOwnedConversation,
  liveAgent: liveAgentForOwnedConversation,
  hasPendingWorkerRevival: (conversationId, runId) => pendingWorkerRevivals().some(revival =>
    revival.conversationId === conversationId && revival.runId === runId && revival.messageIds.length > 0),
  departureAllowsRepair,
  tabRecoveryWanted,
  goalActiveFor,
  hasGoalReply: conversationId => Boolean(goalPendingReplyFor(conversationId)),
  hasPendingCompaction: conversationId => pendingContinuations().some(entry => entry.from === conversationId),
  hasCurrentWork: (conversationId, now) =>
    liveConversations().some(entry => entry.conversationId === conversationId && (entry.generating || Boolean(entry.activeTurnId))) ||
    (activeUntil.get(conversationId)?.until ?? 0) > now,
  queueBrowserRecovery,
  noticeRefusal,
  logInfo
});
silenceMonitor = createBridgeSilenceMonitor({
  activeUntil,
  awaitingReturn,
  BROWSER_RECOVERY_COOLDOWN_MS,
  failedTurnQuiet,
  GOAL_QUIET_MS,
  PRO_ACTIVITY_MS,
  repairsInFlight,
  TURN_SCOPED_REPAIRS,
  UNKNOWN_CALL_HOLD_MS,
  activityDeadline,
  armSilenceSweep,
  changed,
  extendedSilenceWindowFor,
  forgetActivity,
  hasQueuedAfterTurnInput,
  isChatBlocked,
  lastBrowserRecoveryAt,
  logInfo,
  logWarn,
  loopAfterTurnFor,
  noteSilence,
  noticeChatStopped,
  pendingContinuations,
  queueBrowserRecovery,
  recordNote,
  recoveryInputAllowed,
  runningToolCalls,
  silenceHeldByCalls,
  silenceSourceCurrent,
  silenceWindowMs,
  tabRecoveryWanted,
  turnHasMcpCall
});
const { askForTheTabToWakeIn, queueMissingTab, queueStalledTabRecovery } = tabRecovery;

// Due repairs are returned together; Goal and queue pickups keep their token until acknowledged.
async function takePendingRepairs(
  now = Date.now(),
  browser: string | null = null
): Promise<Array<{ conversationId: string; token: string; reason: Repair['reason']; focus: boolean }>> {
  return pendingRepairs.takePendingRepairs(now, browser);
}
const repairFeedback = createBridgeRepairFeedback({ repairsInFlight, turnRepairSpent });
const {
  noteRepairHeld,
  repairChangeDetail,
  failRepairAttempt,
  repairPurpose,
  repairReason,
  updateRepairProgress
} = repairFeedback;
const { REPAIR_HOLD_REASONS, repairHoldsLogged, REPAIR_FAIL_REASONS, REPAIR_CHANGE_DETAILS, REPAIR_PROGRESS_SOURCES } = repairFeedback.state;
const { confirmRepair } = createBridgeRepairConfirmation({
  repairsInFlight,
  awaitingReturn,
  lastBrowserRecoveryAt,
  turnRepairSpent,
  compactionRepairCurrent,
  fileSilenceInputTicket,
  fileSilenceTickets,
  loopAfterTurnFor,
  goalActiveFor,
  goalWorkerChat,
  armSilenceSweep,
  grantActivity,
  repairPurpose,
  updateRepairProgress
});
pendingRepairs = createBridgePendingRepairs({
  runtime,
  repairsInFlight,
  pickupWatch,
  owedPickups,
  clearTurnRepairSpent: conversationId => { turnRepairSpent.delete(conversationId); },
  pagelessChats,
  unclaimedRepairTold,
  unclaimedRepairOffers: UNCLAIMED_REPAIR_OFFERS,
  retireSpentRepairs,
  departureAllowsRepairFor,
  endActivity,
  attributionRepairAllowed,
  assistantRepairCurrent,
  silenceRepairCurrent,
  compactionRepairCurrent,
  repairNeedsClaim,
  compactionWatchDelete: conversationId => { compactionWatch.delete(conversationId); },
  armSilenceSweep,
  forgetGoalWatch,
  logInfo,
  repairPurpose,
  updateRepairProgress
});
// Clears shared recovery incident state when the bridge lifecycle is reset.
function clearUnattributedIncident(): void {
  recoveryIncidents.clear({ clearUnattributedTimer: unattributedRecoveryTimer.clearTimer });
}

// Delivers the next queued bootstrap through its single authorized browser route.
async function deliver(): Promise<void> {
  try {
    await deliverOne();
  } catch (err) {
    logWarn(`bridge command delivery failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

  return {
    grantActivity,
    silenceHeldByCalls,
    recoveryHeldByCalls,
    silenceWindowMs,
    sessionInputActivity,
    extendedSilenceWindowFor,
    silenceContinuationAllowed,
    suppressProSilence,
    revokeSilenceLoop,
    goalInputPriority,
    goalWaitFor,
    chatStillWorking,
    failedCompactionTurnCurrent,
    considerAutomaticCompaction,
    fileSilenceTickets,
    fileSilenceInputTicket,
    armResumedChat,
    restoreReturnedPageActivity,
    endActivity,
    forgetActivity,
    armSilenceSweep,
    unattributedRepairEta,
    sessionRecoveryCountdowns,
    noticeMarkedReplacement,
    departureAllowsRepair,
    departureAllowsRepairFor,
    workerRecoveryAllowed,
    retireInactiveWorkerRecovery,
    repairNeedsClaim,
    compactionRepairCurrent,
    silenceRepairCurrent,
    silenceSourceCurrent,
    assistantRecoveryCancelledFor,
    cancelAssistantRecovery,
    settledQuestionOf,
    assistantRepairSource,
    assistantRepairCurrent,
    queueBrowserRecovery,
    noteRecoveryActivity,
    noteFiberHealth,
    noticeRefusal,
    browserTabPolicy,
    tabRecoveryWanted,
    browserRecoveryMonitoring,
    noteSilence,
    inspectSilentChats,
    finishSilentChats,
    compactionPhaseOf,
    expediteCompactionPickup,
    forgetGoalWatch,
    notePickupActivity,
    owedPickups,
    inspectOwedPickups,
    inspectOwedCompactions,
    queueMissingTab,
    queueStalledTabRecovery,
    askForTheTabToWakeIn,
    repairCandidates,
    retireSpentRepairs,
    unattributedCandidateCurrent,
    pendingSuspects,
    armUnattributedTick,
    tickUnattributedIncident,
    takePendingRepairs,
    attributionCandidateProven,
    attributionRepairAllowed,
    attributionRepairCurrent,
    confirmRepair,
    noteRepairHeld,
    repairChangeDetail,
    failRepairAttempt,
    repairPurpose,
    repairReason,
    updateRepairProgress,
    clearUnattributedIncident,
    deliver,
    compactionFilings,
    lastAttributedCallAt,
    GOAL_QUIET_MS,
    UNKNOWN_CALL_HOLD_MS,
    unknownCallHold,
    PRO_SILENCE_MS,
    DELIBERATE_SILENCE_MS,
    UNATTRIBUTED_SINGLE_WINDOW_MS,
    UNATTRIBUTED_FIRST_WINDOW_MS,
    UNATTRIBUTED_FINAL_WINDOW_MS,
    unattributedIncidents,
    unattributedTimer: unattributedRecoveryTimer.timer,
    UNATTRIBUTED_REQUEST_MEMORY,
    TURN_SCOPED_REPAIRS,
    repairsInFlight,
    markedReplacementNotices,
    lastBrowserRecoveryAt,
    turnRepairSpent,
    assistantRecoveryCancelled,
    failedTurnQuiet,
    UNCLAIMED_REPAIR_OFFERS,
    unclaimedRepairTold,
    pagelessChats,
    FIBER_HEALTH_GRACE_MS,
    FIBER_HEALTH_GAP_MS,
    fiberHealth,
    REFUSAL_NOTICE_EVERY_MS,
    refusalNoticedAt,
    silenceNotes,
    PICKUP_BACKOFF_MS,
    pickupWatch,
    PICKUP_WATCH_LIFETIME_MS,
    COMPACTION_PICKUPS,
    compactionWatch,
    AUTOMATIC_ASKING_RETRY_PAUSE_MS,
    AUTOMATIC_ASKING_RETRY_BURSTS,
    REPAIR_HOLD_REASONS,
    repairHoldsLogged,
    REPAIR_FAIL_REASONS,
    REPAIR_CHANGE_DETAILS,
    REPAIR_PROGRESS_SOURCES,
    state: { compactionFilings, lastAttributedCallAt, unknownCallHold, UNATTRIBUTED_SINGLE_WINDOW_MS, UNATTRIBUTED_FIRST_WINDOW_MS, UNATTRIBUTED_FINAL_WINDOW_MS, unattributedIncidents, unattributedTimer: unattributedRecoveryTimer.timer, UNATTRIBUTED_REQUEST_MEMORY, TURN_SCOPED_REPAIRS, repairsInFlight, markedReplacementNotices, lastBrowserRecoveryAt, turnRepairSpent, assistantRecoveryCancelled, failedTurnQuiet, UNCLAIMED_REPAIR_OFFERS, unclaimedRepairTold, pagelessChats, FIBER_HEALTH_GRACE_MS, FIBER_HEALTH_GAP_MS, fiberHealth, REFUSAL_NOTICE_EVERY_MS, refusalNoticedAt, silenceNotes, PICKUP_BACKOFF_MS, pickupWatch, PICKUP_WATCH_LIFETIME_MS, COMPACTION_PICKUPS, compactionWatch, AUTOMATIC_ASKING_RETRY_PAUSE_MS, AUTOMATIC_ASKING_RETRY_BURSTS, REPAIR_HOLD_REASONS, repairHoldsLogged, REPAIR_CHANGE_DETAILS, REPAIR_PROGRESS_SOURCES }
  };
}
