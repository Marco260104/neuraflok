export {
  COMMAND_DEADLINE_MS,
  REVIVAL_ACTIVITY_MS,
  REVIVAL_DEADLINE_MS,
  STOP_COMMAND_TIMEOUT_MS,
  WORKER_BOOTSTRAP_LIMIT_MS,
  WORKER_REDEEM_MS
} from './command-broker/policy.js';
import { specKey } from './command-broker/admission.js';
import { createBridgeWorkerCommandLease } from './command-broker/worker-lease.js';
import { createBridgeCommandSystem } from './bridge-command-system.js';
import { bridgeRuntimeState } from './bridge-runtime-state.js';
import {
  awaitingReturn,
  commands,
  resetBridgeCommandState
} from './command-broker/state.js';
import { createBridgeBrowserOpening } from './bridge-browser-opening.js';
import type { Command, CommandSpec } from './command-broker/model.js';
export type { AckStatus, BridgeCommand, Command, CommandReceipt, CommandSpec, CommandStep } from './command-broker/model.js';
import { createBridgeStatusRuntime } from './bridge-status-runtime.js';
export type { RevivalRedeemResult } from './command-broker/ledger.js';
import { createBridgeCompanionClients } from './bridge-companion-clients.js';
import { createBridgeRecoveryControl } from './bridge-recovery-control.js';
import { createBridgeSessionControls } from './bridge-session-controls.js';
import { createBridgeSessionControlsRuntime } from './bridge-session-controls-runtime.js';
import { createBridgeHttpBoundary } from './bridge-http-boundary.js';
import { createBridgeHttpRuntime } from './bridge-http-runtime.js';
import { createBridgeWorkerSweep } from './bridge-worker-sweep.js';
import { createBridgeWorkerFinish, type BridgeWorkerFinishRuntime } from './bridge-worker-finish.js';
import { createBridgeServerHost } from './bridge-server-host.js';
import { chatIsWorking, liveTurnIsCurrent } from './bridge-chat-activity.js';
export { STALE_SWARM_MS } from './bridge-worker-sweep.js';
export type { SessionControlsView } from './bridge-session-controls.js';
export type { ResumeJobView, ResumeStage } from './bridge-resume-types.js';
import { noteCallAttribution } from './bridge-call-attribution.js';
import { bridgeRecoveryObservationRuntime } from './bridge-http-runtime.js';
export {
  bridgeCommandRouteRuntime,
  bridgeRecoveryObservationRuntime,
  bridgeStatusRouteRuntime,
  bridgeSessionRouteRuntime,
  bridgePairingRouteRuntime,
  bridgeActivityRouteRuntime,
  bridgeContinuationRouteRuntime,
  bridgeAutomationRouteRuntime
} from './bridge-http-runtime.js';
import { resetBrowserProofForTests } from './browser-proof.js';
import { browserControl } from './control/index.js';
import type { WebProviderId, WebProviderPresenceMap } from '../../../contracts/web-providers.js';
import { attachBrowserWake, wakeBrowserWork, type WakeHost } from './browser-wake.js';
const companionClients = createBridgeCompanionClients({ shippedExtensionBuild, wakeBrowserWork, browserWakeConnected });
const { chatHeldElsewhere, chatHolders } = companionClients;
export const revealChatInBrowser = companionClients.revealChatInBrowser;
let recoveryControl: ReturnType<typeof createBridgeRecoveryControl>;
let workerSweep: ReturnType<typeof createBridgeWorkerSweep>;
let commandProjection: ReturnType<typeof import('./command-broker/projection.js').createBridgeCommandProjection>;
const browserOpening = createBridgeBrowserOpening({
  getConfig,
  browserPresent,
  commandHomeConversation: spec => commandProjection.commandHomeConversation(spec),
  drop: (command, reason) => drop(command, reason),
  specKey,
  logInfo,
  deliver: () => deliver()
});
export const { chatUrl, commandUrl, setBrowserOpener } = browserOpening;
export { setWorkAreaSource } from './window-placement/index.js';
// The loopback bridge authenticates the browser companion, records provider-page activity, and brokers bounded local browser actions.

import type { BridgeStatus, CompanionDiagnostics } from '../../../contracts/types.js';
import { clearCompanionDiagnostics, requestCompanionDiagnostics } from './companion-diagnostics.js';
export { CHAT_ACTIVE_MS, CHAT_SILENCE_MS } from '../../../contracts/session.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { BROWSER_BRIDGE_PORTS } from '../../../contracts/browser/bridge.js';
import { bridgePortSelection } from './bridge-ports.js';
import { getSecret } from '../../infrastructure/settings/secrets.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { activeUntil, PRO_ACTIVITY_MS, sessionActivityExpiresAt } from './session-activity.js';
export { PRO_ACTIVITY_MS, sessionActivityExpiresAt };
import { recordAgentMessage, setCallAttributionListener } from '../sessions/history/recorder.js';
import {
  readRecentEvents,
  readCompletedFinal,
  turnEndedDurably
} from '../sessions/history/store.js';
import {
  agentInfoForOwnedConversation,
  bindConversation,
  swarmRunning,
  isLocalAgentDeliveryActive,
  onReviveRequest,
  onSpawnRequest,
  onSwarmChange,
  onSwarmEnd,
  releaseQuiescentRun,
  noteAgentAlive,
  reactivateSilentCeilingRunForTerminal,
  persistCriticalSwarmNow,
  stageWorkerConversationFinish
} from '../automation/agents.js';
import { resetContinuationsForTests } from '../sessions/continuity/continuation.js';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../../infrastructure/settings/version.js';
import { shippedExtensionBuild } from './extension-path.js';

// Fixed candidates so the extension can find the app without being told a port.
export const DEFAULT_PORTS = BROWSER_BRIDGE_PORTS;
// Keeps one recovery cooldown per conversation across provider activity and reloads.
export const BROWSER_RECOVERY_COOLDOWN_MS = 3 * 60_000;
// /events batches currently between parse and durable/session+worker lifecycle completion.

// Uses a reserved token value to persist explicit browser disconnection.
const BROWSER_DISCONNECTED = '!browser-disconnected';
const httpBoundary = createBridgeHttpBoundary({
  bridgeProtocol: BRIDGE_PROTOCOL,
  disconnectedToken: BROWSER_DISCONNECTED,
  getBridgeToken: () => getSecret('bridgeToken')
});
const { extensionProtocol, originOf, safeEqual, reset: resetHttpBoundary } = httpBoundary;

// Defines when recent extension activity counts as current browser presence.
const BROWSER_PRESENT_MS = 60_000;
const BROWSER_LAUNCH_GRACE_MS = BROWSER_PRESENT_MS;


// Binds a live worker conversation only to its redeemed bootstrap command.
const bindLeasedWorkerCommand = createBridgeWorkerCommandLease({
  getCommands: () => commands,
  isRunActive: swarmRunning,
  bindConversation
});
// Retains retired worker commands until the broker transition is durable. Serializes the broker-claim + browser-lease half of one revival redeem.
const bridgeStatusRuntime = createBridgeStatusRuntime({
  browserPresentMs: BROWSER_PRESENT_MS,
  browserWakeConnected,
  companionClients,
  disconnectedToken: BROWSER_DISCONNECTED,
  error: () => bridgeRuntimeState.bridgeError,
  extensionProtocol,
  getPort: () => bridgeRuntimeState.port,
  portOverridden: () => bridgePortSelection().overridden,
  revokeBrowserWake: () => bridgeRuntimeState.browserWake?.revoke(),
  running: () => bridgeRuntimeState.server !== null,
  shippedExtensionBuild
});
const {
  bridgePresence,
  browserCredentials,
  changed,
  extensionHealth,
  extensionHost,
  noteBrowserSeen
} = bridgeStatusRuntime;

export function companionDiagnostics(): Promise<CompanionDiagnostics | null> {
  return requestCompanionDiagnostics(wakeBrowserWork, browserPresent);
}

export function onBridgeChange(listener: () => void): () => void {
  return bridgeStatusRuntime.onBridgeChange(listener);
}

export function bridgeStatus(): Promise<BridgeStatus> { return bridgeStatusRuntime.bridgeStatus(); }

// Provider tabs whose signed-in state was checked by their isolated page adapter.
export function webProvidersStatus(): WebProviderPresenceMap {
  return bridgeStatusRuntime.webProvidersStatus();
}

// The main process cleared one provider's app-owned browser storage.
export function clearWebProviderStatus(provider: WebProviderId): void {
  bridgeStatusRuntime.clearWebProviderStatus(provider);
}

// Reports whether recent extension activity makes browser presence reliable.
export function browserPresent(): boolean {
  return bridgeStatusRuntime.browserPresent();
}

// Recent HTTP presence cannot prove that an explicit desktop send can wake Chrome now.
export function browserWakeConnected(host?: WakeHost): boolean { return bridgeRuntimeState.browserWake?.connected(host) === true; }

// Revokes the stored credential so a future browser companion must pair again.
export function unpair(): Promise<void> {
  return bridgeStatusRuntime.unpair();
}

// Bridge status and helper routines.

// Validates bridge origins and reports an incompatible extension build once.
export function noteExtensionUpdateHold(hold: unknown): void {
  bridgeStatusRuntime.noteExtensionUpdateHold(hold);
}

export const bridgeWorkerFinishRuntime: BridgeWorkerFinishRuntime = {
  get commands() { return commands; },
  agentInfoForOwnedConversation,
  readRecentEvents,
  get revivalDeliveryProven() { return revivalDeliveryProven; },
  noteAgentAlive,
  readCompletedFinal,
  turnEndedDurably,
  reactivateSilentCeilingRunForTerminal,
  stageWorkerConversationFinish,
  persistCriticalSwarmNow,
  recordAgentMessage,
  afterFinish: (agentId: string, runId: string) => workerSweep.wakeQueuedStoppedWorkers([agentId], runId),
  releaseQuiescentRun: (runId: string) => releaseQuiescentRun({}, runId),
  logWarn
};

const { reconcileWorkerFinish } = createBridgeWorkerFinish(bridgeWorkerFinishRuntime);



// The command domain owns queue state, delivery, admission, and restart recovery.
const bridgeCommandSystem = createBridgeCommandSystem({
  browserLaunchGraceMs: BROWSER_LAUNCH_GRACE_MS,
  browserOpening,
  browserPresent,
  browserWakeConnected,
  chatHolders,
  changed,
  getBridgeLifecycleEpoch: () => bridgeLifecycle.epoch,
  getCompactionOpeningEvery: () => recoveryControl.COMPACTION_PICKUPS.opening.every,
  getConfig,
  getPlacementCollector: () => bridgeRuntimeState.placementCollector,
  clearAutomaticCompactionState: entry => {
    compactionWatch.delete(entry.from);
    if (repairsInFlight.get(entry.from)?.reason === 'compaction') repairsInFlight.delete(entry.from);
  },
  clearCompactionState: entry => {
    if (compactionWatch.get(entry.from)?.token === entry.token) compactionWatch.delete(entry.from);
    const repair = repairsInFlight.get(entry.from);
    if (repair?.reason === 'compaction' && repair.episode.startsWith(`compaction:${entry.token}:`)) repairsInFlight.delete(entry.from);
  },
  logInfo,
  logWarn,
  askForTheTabToWakeIn: (command, lifecycle) => recoveryControl.askForTheTabToWakeIn(command, lifecycle),
  deliver: () => deliver(),
  wakeBrowserWork
});
commandProjection = bridgeCommandSystem.commandProjection;
const {
  bridgeCommandRestorationRuntime,
  cancelAutomaticResumesNow,
  cancelResume,
  cancelResumeNow,
  commandAdmission,
  commandDelivery,
  commandRuntime,
  deliverOne,
  pendingCommands,
  queueResume,
  queueResumeCommand,
  queueWorkerBootstrap,
  queueWorkerRevival,
  rearmRetainedCommandDeadlines,
  restoreCommands,
  resumeControls,
  rememberToken,
  resumeJobFor,
  revivalDeliveryProven,
  revivalFor,
  resetResumeControls,
  bootstrapText
} = bridgeCommandSystem;
export {
  bridgeCommandRestorationRuntime,
  cancelResume,
  cancelResumeNow,
  pendingCommands,
  queueResume,
  queueWorkerBootstrap,
  queueWorkerRevival,
  restoreCommands,
  resumeJobFor
};
export const { bridgeCommandAdmissionRuntime, cancelWorkerCommands } = bridgeCommandSystem;

function drop(command: Command, reason: string): boolean {
  return bridgeCommandSystem.drop(command, reason);
}

export const bridgeSessionControlsRuntime = createBridgeSessionControlsRuntime({
  commandSystem: bridgeCommandSystem,
  browserOpening,
  changed,
  getLifecycle: () => bridgeLifecycle,
  getRecoveryControl: () => recoveryControl
});
const sessionControls = createBridgeSessionControls(bridgeSessionControlsRuntime);
export const {
  cancelSessionCompaction,
  compactSession,
  goalWorkerChat,
  recoveryInputAllowed,
  sessionControlsFor,
  setSessionAutomation,
  setSessionObjective,
  stopSessionTurn
} = sessionControls;
const {
  goalActiveFor,
  goalFencedChat,
  goalModeFor,
  saveConversationObjective,
  stopRequestedFor
} = sessionControls;

const bridgeHttpRuntime = createBridgeHttpRuntime({
  boundary: httpBoundary,
  appVersion: APP_VERSION,
  bridgeProtocol: BRIDGE_PROTOCOL,
  noteExtensionVersion: extensionHealth.noteVersion,
  noteBrowserSeen,
  changed,
  extensionHost,
  getExtendedSilenceWindowFor: () => recoveryControl.extendedSilenceWindowFor,
  goalMode: () => goalModeFor(),
  saveConversationObjective
});
const { handleRequest: handle } = bridgeHttpRuntime;

export function sweepStaleSwarm(now = Date.now()): Promise<boolean> {
  return workerSweep.sweepStaleSwarm(now);
}

function runStaleSwarmSweep(): Promise<boolean> {
  return bridgeRuntimeState.bridgeServerLifecycle?.runStaleSwarmSweep() ?? Promise.resolve(false);
}

// Browser server construction stays separate from the stable bridge facade.
const bridgeServerHost = createBridgeServerHost({
  backgroundChats: () => getConfig().ui.backgroundChats === true,
  disconnectedToken: BROWSER_DISCONNECTED,
  getSecret,
  handleRequest: handle,
  httpBoundary,
  logInfo,
  logWarn,
  originOf,
  recoveryInputAllowed,
  safeEqual,
  attachBrowserWake,
  changed,
  ports: {
    getCommands: () => commands,
    resetBrowserControl: () => browserControl.reset(),
    clearPresence: () => bridgePresence.clearObservations(),
    clearDiagnostics: clearCompanionDiagnostics,
    deliver: () => deliver(),
    changed,
    logInfo,
    logWarn,
    restoreCommands: () => restoreCommands(),
    rearmRetainedCommandDeadlines: () => rearmRetainedCommandDeadlines(),
    onSwarmChange,
    retireInactiveWorkerRecovery: () => retireInactiveWorkerRecovery(),
    isLocalAgentDeliveryActive,
    onSpawnRequest,
    onReviveRequest,
    onSwarmEnd,
    queueWorkerBootstrap: worker => { queueWorkerBootstrap(worker.id, worker.task, worker.model, worker.reasoningEffort, worker.runId); },
    queueWorkerRevival: revival => { queueWorkerRevival(revival.id, revival.conversationId, revival.messageIds, revival.runId); },
    cancelWorkerCommands: (reason, runId) => { cancelWorkerCommands(reason, undefined, runId); },
    sweepStaleSwarm: () => sweepStaleSwarm(),
    installCallAttributionListener: () => setCallAttributionListener((...args) => noteCallAttribution(bridgeRecoveryObservationRuntime, ...args)),
    removeCallAttributionListener: () => setCallAttributionListener(null),
    setServingWatchFloors: now => { bridgeRuntimeState.pickupWatchFloor = now; bridgeRuntimeState.compactionWatchFloor = now; },
    clearSilenceTimer: () => { if (bridgeRuntimeState.silenceTimer) clearTimeout(bridgeRuntimeState.silenceTimer); bridgeRuntimeState.silenceTimer = null; },
    clearUnattributedIncident: () => clearUnattributedIncident(),
    getConfig,
    selectPorts: value => bridgePortSelection(value)
  }
});
const { bridgeLifecycle } = bridgeServerHost;
export const { bridgeLifecycleRuntime, bridgeListenerRuntime, startBridge, stopBridge, shutdownBridge, publishBridgePortChange } = bridgeServerHost;

// Waits until pending unattributed incidents finish their initial session reads.
export async function unattributedIncidentsSettledForTests(): Promise<void> {
  await Promise.all([...unattributedIncidents.values()].map(incident => incident.ready));
}

// The first message a fresh worker chat receives, for tests of its protocol wording.
export function workerBriefForTests(agent: string, task: string): string {
  return bootstrapText({ type: 'worker', agent, task, model: null, reasoningEffort: null, runId: 'run-test' } as CommandSpec, '');
}

export function resetBridgeForTests(): void {
  clearCompanionDiagnostics();
  for (const command of commands) if (command.timer) clearTimeout(command.timer);
  bridgePresence.reset();
  resetBridgeCommandState();
  bridgeRuntimeState.bridgeRecovering = false;
  bridgeLifecycle.resetShutdownForTests();
  bridgeRuntimeState.bridgeError = null;
  clearUnattributedIncident();
  activeUntil.clear();
  lastAttributedCallAt.clear();
  fiberHealth.clear();
  markedReplacementNotices.clear();
  refusalNoticedAt.clear();
  pickupWatch.clear();
  compactionWatch.clear();
  // Re-arms recovery watchers for the next bridge lifecycle in tests.
  bridgeRuntimeState.pickupWatchFloor = Date.now();
  bridgeRuntimeState.compactionWatchFloor = bridgeRuntimeState.pickupWatchFloor;
  resetContinuationsForTests();
  resetResumeControls();
  browserOpening.reset();
  commandDelivery.reset();
  companionClients.reset();
  extensionHealth.reset();
  resetBrowserProofForTests();
  resetHttpBoundary();
}

export function bridgePort(): number | null {
  return bridgeRuntimeState.port;
}


// Restored watches receive startup grace while retaining their original expiry. Supplies recovery control with current bridge state and lifecycle actions.
export const bridgeRecoveryControlRuntime = {
  get BROWSER_RECOVERY_COOLDOWN_MS() { return BROWSER_RECOVERY_COOLDOWN_MS; },
  get awaitingReturn() { return awaitingReturn; },
  get browserPresent() { return browserPresent; },
  get cancelAutomaticResumesNow() { return cancelAutomaticResumesNow; },
  get changed() { return changed; },
  get chatHeldElsewhere() { return chatHeldElsewhere; },
  get chatIsWorking() { return chatIsWorking; },
  get chatUrl() { return chatUrl; },
  get commands() { return commands; },
  get deliverOne() { return deliverOne; },
  get goalActiveFor() { return goalActiveFor; },
  get goalFencedChat() { return goalFencedChat; },
  get goalModeFor() { return goalModeFor; },
  get goalWorkerChat() { return goalWorkerChat; },
  get liveTurnIsCurrent() { return liveTurnIsCurrent; },
  get revivalDeliveryProven() { return revivalDeliveryProven; },
  get revivalFor() { return revivalFor; },
  get queueResumeCommand() { return queueResumeCommand; },
  get recoveryInputAllowed() { return recoveryInputAllowed; },
  get rememberToken() { return rememberToken; },
  get runStaleSwarmSweep() { return runStaleSwarmSweep; },
  get stopRequestedFor() { return stopRequestedFor; },
  get bridgeLifecycleEpoch() { return bridgeLifecycle.epoch; },
  get bridgeShutdownRequested() { return bridgeLifecycle.shutdownRequested; },
  get compactionWatchFloor() { return bridgeRuntimeState.compactionWatchFloor; },
  set compactionWatchFloor(value: typeof bridgeRuntimeState.compactionWatchFloor) { bridgeRuntimeState.compactionWatchFloor = value; },
  get observationWritesInFlight() { return bridgeRuntimeState.observationWritesInFlight; },
  set observationWritesInFlight(value: typeof bridgeRuntimeState.observationWritesInFlight) { bridgeRuntimeState.observationWritesInFlight = value; },
  get pickupWatchFloor() { return bridgeRuntimeState.pickupWatchFloor; },
  set pickupWatchFloor(value: typeof bridgeRuntimeState.pickupWatchFloor) { bridgeRuntimeState.pickupWatchFloor = value; },
  get silenceTimer() { return bridgeRuntimeState.silenceTimer; },
  set silenceTimer(value: typeof bridgeRuntimeState.silenceTimer) { bridgeRuntimeState.silenceTimer = value; },
};
recoveryControl = createBridgeRecoveryControl(bridgeRecoveryControlRuntime);
workerSweep = createBridgeWorkerSweep({
  getObservationWritesInFlight: () => bridgeRuntimeState.observationWritesInFlight,
  inspectSilentChats: recoveryControl.inspectSilentChats,
  fileSilenceTickets: recoveryControl.fileSilenceTickets,
  inspectOwedPickups: recoveryControl.inspectOwedPickups,
  inspectOwedCompactions: recoveryControl.inspectOwedCompactions,
  finishSilentChats: recoveryControl.finishSilentChats
});
export const recoveryHeldByCalls = recoveryControl.recoveryHeldByCalls;
export const sessionInputActivity = recoveryControl.sessionInputActivity;
export const unattributedRepairEta = recoveryControl.unattributedRepairEta;
const retireInactiveWorkerRecovery = recoveryControl.retireInactiveWorkerRecovery;
export const cancelAssistantRecovery = recoveryControl.cancelAssistantRecovery;
const clearUnattributedIncident = recoveryControl.clearUnattributedIncident;
const lastAttributedCallAt = recoveryControl.lastAttributedCallAt;
export const GOAL_QUIET_MS = recoveryControl.GOAL_QUIET_MS;
export const UNKNOWN_CALL_HOLD_MS = recoveryControl.UNKNOWN_CALL_HOLD_MS;
export const PRO_SILENCE_MS = recoveryControl.PRO_SILENCE_MS;
export const DELIBERATE_SILENCE_MS = recoveryControl.DELIBERATE_SILENCE_MS;
const unattributedIncidents = recoveryControl.unattributedIncidents;
const repairsInFlight = recoveryControl.repairsInFlight;
const markedReplacementNotices = recoveryControl.markedReplacementNotices;
const fiberHealth = recoveryControl.fiberHealth;
const refusalNoticedAt = recoveryControl.refusalNoticedAt;
const pickupWatch = recoveryControl.pickupWatch;
const compactionWatch = recoveryControl.compactionWatch;

function deliver(...args: Parameters<typeof recoveryControl.deliver>): ReturnType<typeof recoveryControl.deliver> {
  return recoveryControl.deliver(...args);
}

bridgeHttpRuntime.initializeRouteRuntimes({
  clients: companionClients,
  status: bridgeStatusRuntime,
  recovery: recoveryControl,
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
  disconnectedToken: BROWSER_DISCONNECTED
});
