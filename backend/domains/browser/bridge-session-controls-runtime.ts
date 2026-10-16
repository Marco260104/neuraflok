import { isApiConversationId } from '../../../contracts/chat-protocol.js';
import { providerForConversationId } from '../../../contracts/web-providers.js';
import { supportsFinishAutomation } from '../../../contracts/automation/completion-policy.js';
import { revokeSilenceInputs, sessionInputPolicy } from '../sessions/input/input.js';
import { sessionFinishHeld, releaseSessionFinish, getSessionFinishDraft, sessionFinishWaiting } from '../sessions/input/finish.js';
import {
  automaticCompactionAllowed,
  conversationWasSuperseded,
  getSession,
  readSessionPlan,
  readRecentEvents
} from '../sessions/history/store.js';
import { runningToolCalls } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { isWorkerConversation, retiredWorkerForConversation } from '../automation/agents.js';
import {
  continuationForSession,
  openContinuationNow
} from '../sessions/continuity/continuation.js';
import { STOP_COMMAND_TIMEOUT_MS } from './command-broker/policy.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { logInfo } from '../../infrastructure/settings/logger.js';
import { activeUntil, sessionActivityExpiresAt } from './session-activity.js';
import { liveConversations } from '../sessions/history/recorder.js';
import {
  loopAfterTurnFor,
  goalKeyPresent,
  isGoalDecisionChat,
  goalArmedFor,
  goalObjectiveFor,
  goalPendingReplyFor,
  goalSwitchFor,
  goalViewFor,
  goalOutcomeFor,
  setGoalReplyActiveNow,
  setGoalObjectiveNow,
  setGoalSwitchNow
} from '../automation/goal.js';
import { apiChatFlightTurnId } from '../providers/api-chat.js';
import { webProviderFlightTurnId } from '../providers/browser-chat.js';
import { wakeBrowserWork } from './browser-wake.js';
import { wakeBrowserUrl } from './browser-startup.js';
import { chatIsWorking } from './bridge-chat-activity.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { bridgeRuntimeState } from './bridge-runtime-state.js';
import { commands, commandWrites } from './command-broker/state.js';
import type { createBridgeCommandSystem } from './bridge-command-system.js';
import type { createBridgeBrowserOpening } from './bridge-browser-opening.js';
import type { createBridgeRecoveryControl } from './bridge-recovery-control.js';

type BridgeLifecycleView = { epoch: number; shutdownRequested: boolean };

export function createBridgeSessionControlsRuntime(dependencies: {
  commandSystem: ReturnType<typeof createBridgeCommandSystem>;
  browserOpening: ReturnType<typeof createBridgeBrowserOpening>;
  changed(): void;
  getLifecycle(): BridgeLifecycleView;
  getRecoveryControl(): ReturnType<typeof createBridgeRecoveryControl>;
}) {
  const { commandSystem, browserOpening, changed, getLifecycle, getRecoveryControl } = dependencies;

  return {
    get STOP_COMMAND_TIMEOUT_MS() { return STOP_COMMAND_TIMEOUT_MS; },
    get activeUntil() { return activeUntil; },
    get apiChatFlightTurnId() { return apiChatFlightTurnId; },
    get armDeadline() { return commandSystem.armDeadline; },
    get automaticCompactionAllowed() { return automaticCompactionAllowed; },
    get getBridgeLifecycleEpoch() { return () => getLifecycle().epoch; },
    get isBridgeShutdownRequested() { return () => getLifecycle().shutdownRequested; },
    get cancelResumeNow() { return commandSystem.cancelResumeNow; },
    get chatUrl() { return browserOpening.chatUrl; },
    get commandWrites() { return commandWrites; },
    get getCommands() { return () => commands; },
    get compactionPhaseOf() { return (...args: Parameters<ReturnType<typeof createBridgeRecoveryControl>['compactionPhaseOf']>) => getRecoveryControl().compactionPhaseOf(...args); },
    get conversationWasSuperseded() { return conversationWasSuperseded; },
    get continuationForSession() { return continuationForSession; },
    get endActivity() { return (...args: Parameters<ReturnType<typeof createBridgeRecoveryControl>['endActivity']>) => getRecoveryControl().endActivity(...args); },
    get forgetGoalWatch() { return (...args: Parameters<ReturnType<typeof createBridgeRecoveryControl>['forgetGoalWatch']>) => getRecoveryControl().forgetGoalWatch(...args); },
    get getConfig() { return getConfig; },
    get getSession() { return getSession; },
    get getSessionFinishDraft() { return getSessionFinishDraft; },
    get goalArmedFor() { return goalArmedFor; },
    get goalKeyPresent() { return goalKeyPresent; },
    get goalObjectiveFor() { return goalObjectiveFor; },
    get goalOutcomeFor() { return goalOutcomeFor; },
    get goalPendingReplyFor() { return goalPendingReplyFor; },
    get goalSwitchFor() { return goalSwitchFor; },
    get goalViewFor() { return goalViewFor; },
    get goalWaitFor() { return (...args: Parameters<ReturnType<typeof createBridgeRecoveryControl>['goalWaitFor']>) => getRecoveryControl().goalWaitFor(...args); },
    get isApiConversationId() { return isApiConversationId; },
    get isChatBlocked() { return isChatBlocked; },
    get isGoalDecisionChat() { return isGoalDecisionChat; },
    get isWorkerConversation() { return isWorkerConversation; },
    get liveConversations() { return liveConversations; },
    get logInfo() { return logInfo; },
    get loopAfterTurnFor() { return loopAfterTurnFor; },
    get openContinuationNow() { return openContinuationNow; },
    get persistCommandLease() { return commandSystem.persistCommandLease; },
    get providerForConversationId() { return providerForConversationId; },
    get queue() { return commandSystem.queue; },
    get queueBrowserRecovery() { return (...args: Parameters<ReturnType<typeof createBridgeRecoveryControl>['queueBrowserRecovery']>) => getRecoveryControl().queueBrowserRecovery(...args); },
    get readRecentEvents() { return readRecentEvents; },
    get readSessionPlan() { return readSessionPlan; },
    get rememberToken() { return commandSystem.rememberToken; },
    get releaseSessionFinish() { return releaseSessionFinish; },
    get getRepairsInFlight() { return () => getRecoveryControl().repairsInFlight; },
    get resumeJobFor() { return commandSystem.resumeJobFor; },
    get retire() { return commandSystem.retire; },
    get retiredWorkerForConversation() { return retiredWorkerForConversation; },
    get revokeSilenceInputs() { return revokeSilenceInputs; },
    get revokeSilenceLoop() { return (...args: Parameters<ReturnType<typeof createBridgeRecoveryControl>['revokeSilenceLoop']>) => getRecoveryControl().revokeSilenceLoop(...args); },
    get runningToolCalls() { return runningToolCalls; },
    get chatIsWorking() { return chatIsWorking; },
    get observationWritesInFlight() { return bridgeRuntimeState.observationWritesInFlight; },
    get sessionActivityExpiresAt() { return sessionActivityExpiresAt; },
    get sessionFinishHeld() { return sessionFinishHeld; },
    get sessionFinishWaiting() { return sessionFinishWaiting; },
    get sessionInputActivity() { return (...args: Parameters<ReturnType<typeof createBridgeRecoveryControl>['sessionInputActivity']>) => getRecoveryControl().sessionInputActivity(...args); },
    get sessionInputPolicy() { return sessionInputPolicy; },
    get sessionRecoveryCountdowns() { return (...args: Parameters<ReturnType<typeof createBridgeRecoveryControl>['sessionRecoveryCountdowns']>) => getRecoveryControl().sessionRecoveryCountdowns(...args); },
    get setGoalObjectiveNow() { return setGoalObjectiveNow; },
    get setGoalReplyActiveNow() { return setGoalReplyActiveNow; },
    get setGoalSwitchNow() { return setGoalSwitchNow; },
    get supportsFinishAutomation() { return supportsFinishAutomation; },
    get wakeBrowserUrl() { return wakeBrowserUrl; },
    get wakeBrowserWork() { return wakeBrowserWork; },
    get webProviderFlightTurnId() { return webProviderFlightTurnId; },
    get changed() { return changed; }
  };
}

export type BridgeSessionControlsRuntime = ReturnType<typeof createBridgeSessionControlsRuntime>;
