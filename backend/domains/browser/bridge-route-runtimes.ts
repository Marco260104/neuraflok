import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { Command } from './command-broker/model.js';
import { awaitingReturn, commands } from './command-broker/state.js';
import type { BridgePairingRouteRuntime } from './bridge-pairing-routes.js';
import { specKey } from './command-broker/admission.js';
import { COMMAND_STEPS } from './command-broker/model.js';
import { REVIVAL_WAIT_STEPS, STOP_COMMAND_TIMEOUT_MS } from './command-broker/policy.js';
import { bridgeRuntimeState } from './bridge-runtime-state.js';
import { chatIsWorkingNow } from './bridge-chat-activity.js';
import { wakeBrowserWork } from './browser-wake.js';
import * as Agents from '../automation/agents.js';
import * as Goal from '../automation/goal.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../../infrastructure/settings/version.js';
import { getConfig, updateConfig } from '../../infrastructure/settings/config.js';
import { getSecret, secureStorageStatus, setSecret } from '../../infrastructure/settings/secrets.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { runningToolCalls } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { recoveryBusyMs } from '../../../contracts/recovery.js';
import { sessionWorkingAt } from '../../../contracts/sessions/activity-state.js';
import * as BlockedChats from '../sessions/continuity/blocked-chats.js';
import * as Continuation from '../sessions/continuity/continuation.js';
import * as Correlation from '../sessions/history/correlation.js';
import * as Recorder from '../sessions/history/recorder.js';
import * as SessionHistory from '../sessions/history/store.js';
import * as SessionInput from '../sessions/input/input.js';
import * as WindowPlacement from './window-placement/index.js';
import * as BrowserPreferences from './preferences/handshake.js';
import * as BrowserPayload from './companion-payload.js';
import * as SessionActivity from './session-activity.js';
import { pendingProviderPage } from '../providers/provider-page.js';
import { recordWebProviderPresence } from '../providers/presence.js';
import { extensionUpdateOffer } from './extension-path.js';
import { createBridgeHandoffCapture } from './bridge-handoff-capture.js';

interface Dependencies {
  clients: ReturnType<typeof import('./bridge-companion-clients.js').createBridgeCompanionClients>;
  status: ReturnType<typeof import('./bridge-status-runtime.js').createBridgeStatusRuntime>;
  recovery: ReturnType<typeof import('./bridge-recovery-control.js').createBridgeRecoveryControl>;
  commandRuntime: ReturnType<typeof import('./command-broker/runtime.js').createBridgeCommandRuntime>;
  commandAdmission: ReturnType<typeof import('./command-broker/admission.js').createBridgeCommandAdmission>;
  commandDelivery: ReturnType<typeof import('./command-broker/delivery.js').createBridgeCommandDelivery>;
  sessionControls: ReturnType<typeof import('./bridge-session-controls.js').createBridgeSessionControls>;
  resumeControls: ReturnType<typeof import('./bridge-resume-controls.js').createBridgeResumeControls>;
  httpBoundary: ReturnType<typeof import('./bridge-http-boundary.js').createBridgeHttpBoundary>;
  browserCredentials: ReturnType<typeof import('./bridge-browser-credentials.js').createBridgeBrowserCredentials>;
  bindLeasedWorkerCommand: ReturnType<typeof import('./command-broker/worker-lease.js').createBridgeWorkerCommandLease>;
  reconcileWorkerFinish: ReturnType<typeof import('./bridge-worker-finish.js').createBridgeWorkerFinish>['reconcileWorkerFinish'];
  noteExtensionUpdateHold(hold: unknown): void;
  goalJson(res: http.ServerResponse, status: number, body: unknown, origin: string | null): void;
  disconnectedToken: string;
}

export function createBridgeRouteRuntimes({
  clients,
  status,
  recovery,
  commandRuntime,
  commandAdmission,
  commandDelivery,
  sessionControls,
  resumeControls,
  httpBoundary,
  browserCredentials,
  bindLeasedWorkerCommand,
  reconcileWorkerFinish,
  noteExtensionUpdateHold,
  goalJson,
  disconnectedToken
}: Dependencies) {
  const { browserOf, extensionBuildOf, inputHeldElsewhere, openingHeldElsewhere, staleCompanion, takeReveals } = clients;
  const { changed, extensionHost, scheduleBrowserPresence } = status;
  const { lifecycle: commandLifecycle, projection: commandProjection, ledger, deadlines } = commandRuntime;
  const { contextView, pendingBrowserRevival, pendingBrowserRevivals, queueResumeCommand } = commandAdmission;
  const { pendingBrowserPlacement } = commandDelivery;
  const { activateConversationGoalReply, fileCompactionTicket, goalEnabledFor, goalFencedChat, goalWorkerChat, recoveryInputAllowed, setSessionAutomation, stopCommandCurrent, stopRequestedFor } = sessionControls;
  const { cancelAutomaticResumesNow, cancelResumeNow, rememberToken, resumeJobFor } = resumeControls;
  const { json, readBody, tooLarge } = httpBoundary;
  const {
    armResumedChat,
    armSilenceSweep,
    assistantRepairCurrent,
    assistantRepairSource,
    attributionRepairAllowed,
    attributionRepairCurrent,
    browserRecoveryMonitoring,
    browserTabPolicy,
    chatStillWorking,
    compactionRepairCurrent,
    compactionWatch,
    confirmRepair,
    considerAutomaticCompaction,
    departureAllowsRepairFor,
    endActivity,
    expediteCompactionPickup,
    failedTurnQuiet,
    fileSilenceInputTicket,
    forgetGoalWatch,
    inspectSilentChats,
    lastAttributedCallAt,
    lastBrowserRecoveryAt,
    noteFiberHealth,
    notePickupActivity,
    noteRecoveryActivity,
    noteRepairHeld,
    pagelessChats,
    queueBrowserRecovery,
    queueStalledTabRecovery,
    repairCandidates,
    repairNeedsClaim,
    repairsInFlight,
    retireSpentRepairs,
    revokeSilenceLoop,
    silenceContinuationAllowed,
    silenceRepairCurrent,
    silenceWindowMs,
    settledQuestionOf,
    suppressProSilence,
    takePendingRepairs,
    turnRepairSpent,
    unattributedCandidateCurrent,
    unattributedIncidents,
    UNATTRIBUTED_FIRST_WINDOW_MS,
    UNATTRIBUTED_REQUEST_MEMORY,
    UNATTRIBUTED_SINGLE_WINDOW_MS
  } = recovery;
  const deliver = recovery.deliver;

  const bridgeCommandRouteRuntime = {
    armDeadline: deadlines.armDeadline,
    armResumedChat,
    changed,
    commandOrigin: commandProjection.commandOrigin,
    get commands(): Command[] { return commands; },
    deliver,
    describe: commandProjection.describe,
    finalizeCommand: ledger.finalizeCommand,
    json,
    persistCommandLease: ledger.persistCommandLease,
    persistRevivalRedeem: ledger.persistRevivalRedeem,
    readBody,
    receiptFor: ledger.receiptFor,
    receiptReply: ledger.receiptReply,
    reconcileWorkerFinish,
    retire: deadlines.retire,
    revivalDeliveryProven: deadlines.revivalDeliveryProven,
    revivalFor: commandProjection.revivalFor,
    specKey,
    staleCompanion,
    stopCommandCurrent,
    tidyCommands: commandLifecycle.tidyCommands,
    tooLarge,
    writeCommandTransition: ledger.writeCommandTransition,
    COMMAND_STEPS,
    REVIVAL_WAIT_STEPS,
    STOP_COMMAND_TIMEOUT_MS
  };
  const bridgeCompanionRouteRuntime = {
    get readBody() { return readBody; },
    get json() { return json; },
    get extensionBuildOf() { return extensionBuildOf; }
  };

  const bridgeRecoveryObservationRuntime = {
    get activeUntil() { return SessionActivity.activeUntil; },
    get armSilenceSweep() { return armSilenceSweep; },
    get assistantRepairSource() { return assistantRepairSource; },
    get considerAutomaticCompaction() { return considerAutomaticCompaction; },
    get deferSilenceGoalReplyNow() { return Goal.deferSilenceGoalReplyNow; },
    get endActivity() { return endActivity; },
    get expediteCompactionPickup() { return expediteCompactionPickup; },
    get failedTurnQuiet() { return failedTurnQuiet; },
    get fileSilenceInputTicket() { return fileSilenceInputTicket; },
    get getSession() { return SessionHistory.getSession; },
    get goalActiveFor() { return sessionControls.goalActiveFor; },
    get goalPendingReplyFor() { return Goal.goalPendingReplyFor; },
    get grantActivity() { return recovery.grantActivity; },
    get hasQueuedAfterTurnInput() { return SessionInput.hasQueuedAfterTurnInput; },
    get inspectSilentChats() { return inspectSilentChats; },
    get lastBrowserRecoveryAt() { return lastBrowserRecoveryAt; },
    get liveConversations() { return Recorder.liveConversations; },
    get logInfo() { return logInfo; },
    get loopAfterTurnFor() { return Goal.loopAfterTurnFor; },
    get notePickupActivity() { return notePickupActivity; },
    get noteRecoveryActivity() { return noteRecoveryActivity; },
    get pendingContinuations() { return Continuation.pendingContinuations; },
    get queueBrowserRecovery() { return queueBrowserRecovery; },
    get readCompletedFinal() { return SessionHistory.readCompletedFinal; },
    get readRecentEvents() { return SessionHistory.readRecentEvents; },
    get recoveryInputAllowed() { return recoveryInputAllowed; },
    get repairsInFlight() { return repairsInFlight; },
    get revokeSilenceInputs() { return SessionInput.revokeSilenceInputs; },
    get revokeSilenceLoop() { return revokeSilenceLoop; },
    get silenceWindowMs() { return silenceWindowMs; },
    get armUnattributedTick() { return recovery.armUnattributedTick; },
    get attributionRepairCurrent() { return attributionRepairCurrent; },
    get changed() { return changed; },
    get compactionWatch() { return compactionWatch; },
    get forgetGoalWatch() { return forgetGoalWatch; },
    get isChatBlocked() { return BlockedChats.isChatBlocked; },
    get lastAttributedCallAt() { return lastAttributedCallAt; },
    get logWarn() { return logWarn; },
    get noteAgentAlive() { return Agents.noteAgentAlive; },
    get noteAgentContextTokens() { return Agents.noteAgentContextTokens; },
    get repairCandidates() { return repairCandidates; },
    get recordAgentMessage() { return Recorder.recordAgentMessage; },
    get requestCorrelation() { return Correlation.requestCorrelation; },
    get retireGoalDraftsFor() { return Goal.retireGoalDraftsFor; },
    get retireSpentRepairs() { return retireSpentRepairs; },
    get sessionWorkingAt() { return sessionWorkingAt; },
    get unattributedCandidateCurrent() { return unattributedCandidateCurrent; },
    get unattributedIncidents() { return unattributedIncidents; },
    get UNATTRIBUTED_FIRST_WINDOW_MS() { return UNATTRIBUTED_FIRST_WINDOW_MS; },
    get UNATTRIBUTED_REQUEST_MEMORY() { return UNATTRIBUTED_REQUEST_MEMORY; },
    get UNATTRIBUTED_SINGLE_WINDOW_MS() { return UNATTRIBUTED_SINGLE_WINDOW_MS; },
    get turnHasMcpCall() { return SessionHistory.turnHasMcpCall; }
  };

  const bridgeStatusRouteRuntime = {
    get browserOf() { return browserOf; },
    get browserRecoveryMonitoring() { return browserRecoveryMonitoring; },
    get browserTabPolicy() { return browserTabPolicy; },
    get browserWindowBounds() { return WindowPlacement.computeBrowserWindowBounds; },
    get changed() { return changed; },
    get commands() { return commands; },
    get confirmRepair() { return confirmRepair; },
    get conversationId() { return BrowserPayload.conversationId; },
    get currentBrowserWorkArea() { return WindowPlacement.readWorkArea; },
    get extensionBuildOf() { return extensionBuildOf; },
    get extensionHost() { return extensionHost; },
    get extensionUpdateOffer() { return extensionUpdateOffer; },
    get failRepairAttempt() { return recovery.failRepairAttempt; },
    get getConfig() { return getConfig; },
    get inputHeldElsewhere() { return inputHeldElsewhere; },
    get json() { return json; },
    get listInputs() { return SessionInput.listInputs; },
    get liveConversations() { return Recorder.liveConversations; },
    get logInfo() { return logInfo; },
    get noteExtensionUpdateHold() { return noteExtensionUpdateHold; },
    get noteRepairHeld() { return noteRepairHeld; },
    get pendingBrowserInputs() { return SessionInput.pendingBrowserInputs; },
    get pendingBrowserPlacement() { return pendingBrowserPlacement; },
    get pendingBrowserPreferenceRequest() { return BrowserPreferences.pendingBrowserPreferenceRequest; },
    get pendingBrowserRevivals() { return pendingBrowserRevivals; },
    get pendingProviderPage() { return pendingProviderPage; },
    get pendingStopCommands() { return sessionControls.pendingStopCommands; },
    get queueStalledTabRecovery() { return queueStalledTabRecovery; },
    get readBody() { return readBody; },
    get recordWebProviderPresence() { return recordWebProviderPresence; },
    get recordCompanionStatus() { return clients.recordStatus; },
    get retireOpeningCustody() { return clients.retireOpeningCustody; },
    get runningToolCalls() { return runningToolCalls; },
    get scheduleBrowserPresence() { return scheduleBrowserPresence; },
    get takePendingRepairs() { return takePendingRepairs; },
    get takeReveals() { return takeReveals; }
  };

  const bridgeSessionRouteRuntime = {
    get PRIME_ID() { return Agents.PRIME_ID; },
    get acceptGoalReplyNow() { return Goal.acceptGoalReplyNow; },
    get activeUntil() { return SessionActivity.activeUntil; },
    get agentForOwnedConversation() { return Agents.agentForOwnedConversation; },
    get agentInfoForOwnedConversation() { return Agents.agentInfoForOwnedConversation; },
    get assistantRepairCurrent() { return assistantRepairCurrent; },
    get attributionRepairAllowed() { return attributionRepairAllowed; },
    get awaitingReturn() { return awaitingReturn; },
    get bindLeasedWorkerCommand() { return bindLeasedWorkerCommand; },
    get bridgeRecoveryObservationRuntime() { return bridgeRecoveryObservationRuntime; },
    get browserOf() { return browserOf; },
    get changed() { return changed; },
    get chatIsWorkingNow() { return chatIsWorkingNow; },
    get closeConversation() { return Recorder.closeConversation; },
    get collectRecordedBrowserDecision() { return SessionInput.collectRecordedBrowserDecision; },
    get compactionRepairCurrent() { return compactionRepairCurrent; },
    get compactionWatch() { return compactionWatch; },
    get conversationId() { return BrowserPayload.conversationId; },
    get conversationWasSuperseded() { return SessionHistory.conversationWasSuperseded; },
    get departureAllowsRepairFor() { return departureAllowsRepairFor; },
    get endActivity() { return endActivity; },
    get fileSilenceInputTicket() { return fileSilenceInputTicket; },
    get findSessionByConversation() { return SessionHistory.findSessionByConversation; },
    get forgetGoalWatch() { return forgetGoalWatch; },
    get getSession() { return SessionHistory.getSession; },
    get goalFencedChat() { return sessionControls.goalFencedChat; },
    get isChatBlocked() { return BlockedChats.isChatBlocked; },
    get json() { return json; },
    get logInfo() { return logInfo; },
    get logWarn() { return logWarn; },
    get noteAgentAlive() { return Agents.noteAgentAlive; },
    get noteAgentContextTokens() { return Agents.noteAgentContextTokens; },
    get noteChatOrigin() { return Recorder.noteChatOrigin; },
    get observationWritesInFlight() { return bridgeRuntimeState.observationWritesInFlight; },
    get openingHeldElsewhere() { return openingHeldElsewhere; },
    get parseCallEvidence() { return BrowserPayload.parseCallEvidence; },
    get parseObservations() { return BrowserPayload.parseObservations; },
    get primeConversationGone() { return Agents.primeConversationGone; },
    get primeForOwnedConversation() { return Agents.primeForOwnedConversation; },
    get queueMissingTab() { return recovery.queueMissingTab; },
    get readBody() { return readBody; },
    get reconcileWorkerFinish() { return reconcileWorkerFinish; },
    get recordAgentMessage() { return Recorder.recordAgentMessage; },
    get recordChatObservations() { return Recorder.recordChatObservations; },
    get recordRequestEvidence() { return Recorder.recordRequestEvidence; },
    get recoveryInputAllowed() { return recoveryInputAllowed; },
    get repairNeedsClaim() { return repairNeedsClaim; },
    get repairsInFlight() { return repairsInFlight; },
    get requestCorrelation() { return Correlation.requestCorrelation; },
    get revokeSilenceInputs() { return SessionInput.revokeSilenceInputs; },
    get silenceRepairCurrent() { return silenceRepairCurrent; },
    get staleCompanion() { return staleCompanion; },
    get stopRequestedFor() { return stopRequestedFor; },
    get tidyCommands() { return commandLifecycle.tidyCommands; },
    get tooLarge() { return tooLarge; },
    get turnRepairSpent() { return turnRepairSpent; },
    get wakeBrowserWork() { return wakeBrowserWork; },
    get workerConversationGone() { return Agents.workerConversationGone; },
    adjustObservationWritesInFlight: (delta: number) => { bridgeRuntimeState.observationWritesInFlight += delta; }
  };

  const bridgePairingRouteRuntime: BridgePairingRouteRuntime = {
    get APP_VERSION() { return APP_VERSION; },
    get BRIDGE_PROTOCOL() { return BRIDGE_PROTOCOL; },
    get BROWSER_DISCONNECTED() { return disconnectedToken; },
    get browserCredentialEpoch() { return browserCredentials.browserCredentialEpoch; },
    get browserDisconnected() { return httpBoundary.browserDisconnected; },
    get changed() { return changed; },
    get extensionProtocol() { return httpBoundary.extensionProtocol; },
    get getSecret() { return getSecret; },
    get json() { return json; },
    get logInfo() { return logInfo; },
    get noteBrowserSeen() { return status.noteBrowserSeen; },
    get protocolCompatible() { return httpBoundary.protocolCompatible; },
    get randomBytes() { return randomBytes; },
    get rateLimited() { return httpBoundary.rateLimited; },
    get readBody() { return readBody; },
    get secureStorageStatus() { return secureStorageStatus; },
    get setSecret() { return setSecret; },
    get tooLarge() { return tooLarge; },
    get withBrowserCredentials() { return browserCredentials.withBrowserCredentials; }
  };

  const bridgeActivityRouteRuntime = {
    bootstrapText: commandProjection.bootstrapText,
    cancelAutomaticResumesNow,
    chatStillWorking,
    get commands(): Command[] { return commands; },
    contextView,
    goalActiveFor: sessionControls.goalActiveFor,
    goalBlockReason: sessionControls.goalBlockReason,
    goalEnabledFor,
    goalFencedChat,
    goalInputPriority: recovery.goalInputPriority,
    goalModeFor: sessionControls.goalModeFor,
    goalWaitFor: recovery.goalWaitFor,
    goalWorkerChat,
    json,
    noteFiberHealth,
    pagelessChats,
    pendingBrowserPlacement,
    pendingBrowserRevival,
    pendingBrowserRevivals,
    readBody,
    restoreReturnedPageActivity: recovery.restoreReturnedPageActivity,
    resumeJobFor,
    settledQuestionOf,
    stopRequestedFor,
    suppressProSilence,
    tooLarge
  };

  const handoffCapture = createBridgeHandoffCapture({
    abortContinuationNow: Continuation.abortContinuationNow,
    attachSummary: Continuation.attachSummary,
    automaticCompactionAllowed: SessionHistory.automaticCompactionAllowed,
    cancelResumeNow,
    continuationByToken: Continuation.continuationByToken,
    deliver,
    getSession: SessionHistory.getSession,
    logInfo,
    logWarn,
    noticeRefusal: recovery.noticeRefusal,
    pendingBrowserPlacement,
    queueResumeCommand,
    readHandoffResponse: SessionHistory.readHandoffResponse,
    resumeJobFor,
    runningToolCalls,
    setPlacementCollector: conversationId => { bridgeRuntimeState.placementCollector = conversationId; }
  });
  const bridgeContinuationRouteRuntime = {
    abortRejectedResume: handoffCapture.abortRejectedResume,
    armResumedChat,
    cancelAutomaticResumesNow,
    cancelResumeNow,
    captureCompactionBrief: handoffCapture.captureCompactionBrief,
    captureRecordedBrief: handoffCapture.captureRecordedBrief,
    changed,
    get commands(): Command[] { return commands; },
    compactionWatch,
    deliver,
    fileCompactionTicket,
    goalWorkerChat,
    json,
    noticeMarkedReplacement: recovery.noticeMarkedReplacement,
    queueResumeCommand,
    readBody,
    rememberToken,
    repairsInFlight,
    resumeJobFor,
    retire: deadlines.retire,
    tooLarge,
    writeCommandTransition: ledger.writeCommandTransition
  };

  const bridgeAutomationRouteRuntime = {
    acceptGoalReplyNow: Goal.acceptGoalReplyNow,
    activateConversationGoalReply,
    applyGoalSwitch: Goal.applyGoalSwitch,
    astraFinishOnly: Goal.astraFinishOnly,
    beginGoalDraft: Goal.beginGoalDraft,
    cancelAutomaticResumesNow,
    changed,
    chatStillWorking,
    claimGoalRecoveryStopNow: Goal.claimGoalRecoveryStopNow,
    contextView,
    conversationId: BrowserPayload.conversationId,
    conversationWasSuperseded: SessionHistory.conversationWasSuperseded,
    continuationForSession: Continuation.continuationForSession,
    deferSilenceGoalReplyNow: Goal.deferSilenceGoalReplyNow,
    discardPreparedGoalDraft: Goal.discardPreparedGoalDraft,
    extendedSilenceWindowFor: recovery.extendedSilenceWindowFor,
    findSessionByConversation: SessionHistory.findSessionByConversation,
    forgetGoalWatch,
    getConfig,
    goalActiveFor: sessionControls.goalActiveFor,
    goalInputPriority: recovery.goalInputPriority,
    goalJson,
    goalKeyPresent: Goal.goalKeyPresent,
    goalModeFor: sessionControls.goalModeFor,
    goalPendingReplyFor: Goal.goalPendingReplyFor,
    goalProgressFor: Goal.goalProgressFor,
    goalSwitchFor: Goal.goalSwitchFor,
    goalViewFor: Goal.goalViewFor,
    goalWorkerChat,
    isChatBlocked: BlockedChats.isChatBlocked,
    json,
    liveConversations: Recorder.liveConversations,
    logInfo,
    logWarn,
    get loopReplyHasAuthority() { return Goal.loopReplyHasAuthority; },
    notePickupActivity,
    readBody,
    readCompletedFinal: SessionHistory.readCompletedFinal,
    recoveryBusyMs,
    retireGoalDrafts: Goal.retireGoalDrafts,
    runningToolCalls,
    setGoalSwitchNow: Goal.setGoalSwitchNow,
    setSessionAutomation,
    silenceContinuationAllowed,
    startGoalDraft: Goal.startGoalDraft,
    stopRequestedFor,
    suppressProSilence,
    tooLarge,
    updateConfig
  };

  return {
    bridgeCommandRouteRuntime,
    bridgeCompanionRouteRuntime,
    bridgeRecoveryObservationRuntime,
    bridgeStatusRouteRuntime,
    bridgeSessionRouteRuntime,
    bridgePairingRouteRuntime,
    bridgeActivityRouteRuntime,
    bridgeContinuationRouteRuntime,
    bridgeAutomationRouteRuntime
  };
}
