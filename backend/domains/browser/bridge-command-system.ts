import { randomBytes } from 'node:crypto';
import { createBridgeCommandRestore } from './command-broker/restore.js';
import { createBridgeCommandRestoration, type BridgeCommandRestorationRuntime } from './command-broker/restoration.js';
import {
  COMMANDS_STATE,
  COMMAND_DEADLINE_MS,
  COMMAND_STEP_TEXT,
  COMMAND_TTL_MS,
  MAX_COMMANDS,
  MAX_COMMAND_RECEIPTS,
  RESUME_STALL_STEPS,
  RESUME_STEP_STALL_MS,
  REVIVAL_ACTIVITY_MS,
  REVIVAL_DEADLINE_MS,
  REVIVAL_WAIT_STEPS,
  STOP_COMMAND_TIMEOUT_MS,
  WORKER_BOOTSTRAP_LIMIT_MS,
  WORKER_REDEEM_MS
} from './command-broker/policy.js';
import { createBridgeCommandAdmission, specKey, type BridgeCommandAdmissionRuntime } from './command-broker/admission.js';
import { createBridgeCommandRuntime } from './command-broker/runtime.js';
import {
  commands,
  commandReceipts,
  commandRedeems,
  commandRetirementsAwaitingBroker,
  commandWrites,
  replaceCommands,
  replaceCommandReceipts
} from './command-broker/state.js';
import type { BridgeCommandLedgerRuntime } from './command-broker/ledger.js';
import type { BridgeCommandDeadlineRuntime } from './command-broker/deadlines.js';
import type { BridgeCommandLifecycleRuntime } from './command-broker/lifecycle.js';
import type { BridgeCommandProjectionRuntime } from './command-broker/projection.js';
import { createBridgeCommandDelivery } from './command-broker/delivery.js';
import type { Command, CommandSpec, CommandStep } from './command-broker/model.js';
import type { createBridgeBrowserOpening } from './bridge-browser-opening.js';
import { createBridgeResumeControls } from './bridge-resume-controls.js';
import { wakeBrowserWork, type WakeHost } from './browser-wake.js';
import { expectReplacementChatOpening } from '../sessions/continuity/replacement-chat-gate.js';
import { automaticCompactionAllowed } from '../sessions/history/store.js';
import {
  agentForConversation,
  claimWorkerRevival,
  failAgent,
  failWorkerRevival,
  pendingWorkerRevivals,
  pendingWorkerSpawns,
  persistCriticalSwarmNow,
  releaseQuiescentRun,
  rollbackWorkerRevivalClaim,
  swarmRunning,
  workerRevivalDeliveredSince,
  type WorkerRevival
} from '../automation/agents.js';
import {
  abortContinuation,
  abortContinuationNow,
  continuationByToken,
  continuationForSession,
  pendingContinuations,
  releaseContinuationDestinationSendNow
} from '../sessions/continuity/continuation.js';
import { readDurable, writeDurableNow, writeDurableSoon } from '../../persistence/durable.js';
import type { Config } from '../../../contracts/types.js';

type BridgeResumeControlOptions = Parameters<typeof createBridgeResumeControls>[0];

interface BridgeCommandSystemOptions {
  browserLaunchGraceMs: number;
  browserOpening: ReturnType<typeof createBridgeBrowserOpening>;
  browserPresent(): boolean;
  browserWakeConnected(host?: WakeHost): boolean;
  chatHolders: ReturnType<typeof import('./bridge-companion-clients.js').createBridgeCompanionClients>['chatHolders'];
  changed(): void;
  getBridgeLifecycleEpoch(): number;
  getCompactionOpeningEvery(): number;
  getConfig(): Config;
  getPlacementCollector(): string | null;
  clearAutomaticCompactionState: BridgeResumeControlOptions['clearAutomaticCompactionState'];
  clearCompactionState: BridgeResumeControlOptions['clearCompactionState'];
  logInfo(message: string): void;
  logWarn(message: string): void;
  askForTheTabToWakeIn(command: Command, lifecycle: number): Promise<void>;
  deliver(): Promise<void>;
  wakeBrowserWork: typeof wakeBrowserWork;
}

export function createBridgeCommandSystem(options: BridgeCommandSystemOptions) {
  const { browserOpening } = options;
  let commandLifecycle: ReturnType<typeof import('./command-broker/lifecycle.js').createBridgeCommandLifecycle>;
  let commandProjection: ReturnType<typeof import('./command-broker/projection.js').createBridgeCommandProjection>;

  const bridgeCommandLedgerRuntime: BridgeCommandLedgerRuntime = {
    COMMANDS_STATE,
    COMMAND_TTL_MS,
    MAX_COMMAND_RECEIPTS,
    commandWrites,
    commandRedeems,
    commandRetirementsAwaitingBroker,
    getCommands: () => commands,
    replaceCommands,
    getCommandReceipts: () => commandReceipts,
    replaceCommandReceipts,
    writeDurableNow,
    writeDurableSoon,
    logWarn: options.logWarn,
    specKey,
    revivalFor,
    claimWorkerRevival,
    persistCriticalSwarmNow,
    rollbackWorkerRevivalClaim,
    changed: options.changed
  };

  const bridgeCommandDeadlineRuntime: Omit<BridgeCommandDeadlineRuntime, 'finalizeCommand' | 'persistCommands'> = {
    get COMMAND_DEADLINE_MS() { return COMMAND_DEADLINE_MS; },
    get REVIVAL_ACTIVITY_MS() { return REVIVAL_ACTIVITY_MS; },
    get REVIVAL_DEADLINE_MS() { return REVIVAL_DEADLINE_MS; },
    get RESUME_STEP_STALL_MS() { return RESUME_STEP_STALL_MS; },
    get STOP_COMMAND_TIMEOUT_MS() { return STOP_COMMAND_TIMEOUT_MS; },
    get WORKER_BOOTSTRAP_LIMIT_MS() { return WORKER_BOOTSTRAP_LIMIT_MS; },
    get WORKER_REDEEM_MS() { return WORKER_REDEEM_MS; },
    get browserLaunchGraceMs() { return options.browserLaunchGraceMs; },
    get commandStepText() { return (step: string) => COMMAND_STEP_TEXT[step as CommandStep]; },
    get compactionOpeningEvery() { return options.getCompactionOpeningEvery(); },
    get revivalWaitSteps() { return REVIVAL_WAIT_STEPS; },
    get resumeStallSteps() { return RESUME_STALL_STEPS; },
    getCommands: () => commands,
    replaceCommands,
    lastBrowserLaunchAt: browserOpening.lastBrowserLaunchAt,
    workerRevivalDeliveredSince,
    pendingWorkerSpawns,
    revivalFor,
    specKey,
    changed: options.changed,
    logInfo: options.logInfo,
    drop,
    deliver: options.deliver
  };

  const bridgeCommandLifecycleRuntime: Omit<
    BridgeCommandLifecycleRuntime,
    | 'commandDeadlineDelay'
    | 'commandExpiryReason'
    | 'commandSnapshot'
    | 'persistCommands'
    | 'revivalDeadlineAt'
    | 'retire'
    | 'scheduleDeliver'
    | 'writeCommandTransition'
  > = {
    get COMMANDS_STATE() { return COMMANDS_STATE; },
    get COMMAND_TTL_MS() { return COMMAND_TTL_MS; },
    get abortContinuation() { return abortContinuation; },
    get changed() { return options.changed; },
    get commandRetirementsAwaitingBroker() { return commandRetirementsAwaitingBroker; },
    get commandWrites() { return commandWrites; },
    get failAgent() { return failAgent; },
    get failWorkerRevival() { return failWorkerRevival; },
    get logWarn() { return options.logWarn; },
    get pendingWorkerRevivals() { return pendingWorkerRevivals; },
    get pendingWorkerSpawns() { return pendingWorkerSpawns; },
    get persistCriticalSwarmNow() { return persistCriticalSwarmNow; },
    get releaseContinuationDestinationSendNow() { return releaseContinuationDestinationSendNow; },
    get releaseQuiescentRun() { return releaseQuiescentRun; },
    get specKey() { return specKey; },
    get swarmRunning() { return swarmRunning; },
    get writeDurableNow() { return writeDurableNow; },
    getCommands: () => commands,
    replaceCommands
  };
  const bridgeCommandProjectionRuntime: Omit<BridgeCommandProjectionRuntime, 'commandDeadlineDelay'> = {
    getCommands: () => commands
  };
  const commandRuntime = createBridgeCommandRuntime({
    ledger: bridgeCommandLedgerRuntime,
    deadlines: bridgeCommandDeadlineRuntime,
    lifecycle: bridgeCommandLifecycleRuntime,
    projection: bridgeCommandProjectionRuntime
  });
  const { commandSnapshot, durableCommand, persistCommandLease, persistCommands } = commandRuntime.ledger;
  const { armDeadline, rearmRetainedCommandDeadlines, revivalDeadlineAt, revivalDeliveryProven, retire, scheduleDeliver } = commandRuntime.deadlines;
  commandLifecycle = commandRuntime.lifecycle;
  commandProjection = commandRuntime.projection;
  const { isLeased, nextDeliverable, tidyCommands } = commandLifecycle;
  const { bootstrapText, commandHomeConversation, describe } = commandProjection;

  const resumeControls = createBridgeResumeControls({
    abortContinuation,
    abortContinuationNow,
    changed: options.changed,
    clearAutomaticCompactionState: options.clearAutomaticCompactionState,
    clearCompactionState: options.clearCompactionState,
    continuationByToken,
    continuationForSession,
    getCommands: () => commands,
    hasBrowserOpener: browserOpening.hasOpener,
    isLeased,
    logInfo: options.logInfo,
    logWarn: options.logWarn,
    pendingContinuations,
    persistCommands,
    removeCommandFromDurableSnapshot: commandId => writeDurableNow(COMMANDS_STATE, commandSnapshot({ removeCommandId: commandId })),
    replaceCommands
  });
  const { cancelAutomaticResumesNow, cancelResume, cancelResumeNow, rememberToken, resumeJobFor, reset: resetResumeControls } = resumeControls;

  const commandDelivery = createBridgeCommandDelivery({
    getCommands: () => commands,
    commandHomeConversation,
    browserWakeConnected: options.browserWakeConnected,
    chatHolders: options.chatHolders,
    placementCollector: options.getPlacementCollector,
    backgroundChats: () => options.getConfig().ui.backgroundChats === true,
    wakeBrowserWork: options.wakeBrowserWork,
    browserPresent: options.browserPresent,
    browserLaunchGraceMs: options.browserLaunchGraceMs,
    lastBrowserLaunchAt: browserOpening.lastBrowserLaunchAt,
    openInBrowser: browserOpening.openInBrowser,
    openFreshChatInBrowser: browserOpening.openFreshChatInBrowser,
    persistCommandLease,
    armDeadline,
    changed: options.changed,
    expectReplacementChatOpening,
    tidyCommands,
    nextDeliverable,
    drop,
    scheduleDeliver,
    specKey,
    logInfo: options.logInfo,
    deliver: options.deliver
  });
  const { deliverOne } = commandDelivery;

  const bridgeCommandAdmissionRuntime: BridgeCommandAdmissionRuntime = {
    MAX_COMMANDS,
    get armDeadline() { return armDeadline; },
    get askForTheTabToWakeIn() { return options.askForTheTabToWakeIn; },
    automaticCompactionAllowed,
    bridgeLifecycleEpoch: options.getBridgeLifecycleEpoch,
    changed: options.changed,
    createCommandId: () => randomBytes(8).toString('hex'),
    deliver: options.deliver,
    get describe() { return describe; },
    get drop() { return drop; },
    getCommands: () => commands,
    getConfig: options.getConfig,
    logInfo: options.logInfo,
    logWarn: options.logWarn,
    persistCommands,
    get rememberToken() { return rememberToken; },
    replaceCommands,
    revivalDeliveryProven,
    swarmRunning,
    get tidyCommands() { return tidyCommands; }
  };
  const commandAdmission = createBridgeCommandAdmission(bridgeCommandAdmissionRuntime);
  const { cancelWorkerCommands, pendingCommands, queueResume, queueWorkerBootstrap, queueWorkerRevival } = commandAdmission;
  const { queueResumeCommand } = commandAdmission;

  function queue(spec: CommandSpec): Command {
    return commandAdmission.queue(spec);
  }

  function revivalFor(agent: string, runId: string): WorkerRevival | null {
    return commandProjection.revivalFor(agent, runId);
  }

  function drop(command: Command, why: string): boolean {
    return commandLifecycle.drop(command, why);
  }

  const commandRestorePlanner = createBridgeCommandRestore({
    get commands() { return commands; },
    get commandReceipts() { return commandReceipts; },
    COMMAND_DEADLINE_MS,
    COMMAND_TTL_MS,
    MAX_COMMAND_RECEIPTS,
    REVIVAL_ACTIVITY_MS,
    specKey,
    durableCommand,
    revivalDeadlineAt
  });
  const bridgeCommandRestorationRuntime: BridgeCommandRestorationRuntime = {
    COMMANDS_STATE,
    agentForConversation,
    commandRestorePlanner,
    changed: options.changed,
    failWorkerRevival,
    logInfo: options.logInfo,
    logWarn: options.logWarn,
    pendingWorkerRevivals,
    persistCommands,
    persistCriticalSwarmNow,
    readDurable,
    rearmRetainedCommandDeadlines,
    releaseQuiescentRun,
    rememberToken,
    setCommands: replaceCommands,
    setCommandReceipts: replaceCommandReceipts,
    writeDurableNow
  };
  const restoreCommands = createBridgeCommandRestoration(bridgeCommandRestorationRuntime).restoreCommands;

  return {
    armDeadline,
    bridgeCommandAdmissionRuntime,
    bridgeCommandRestorationRuntime,
    cancelAutomaticResumesNow,
    cancelResume,
    cancelResumeNow,
    cancelWorkerCommands,
    commandAdmission,
    commandDelivery,
    commandLifecycle,
    commandProjection,
    commandRuntime,
    commandSnapshot,
    durableCommand,
    deliverOne,
    drop,
    isLeased,
    nextDeliverable,
    pendingCommands,
    persistCommandLease,
    persistCommands,
    queue,
    queueResume,
    queueResumeCommand,
    queueWorkerBootstrap,
    queueWorkerRevival,
    rearmRetainedCommandDeadlines,
    rememberToken,
    restoreCommands,
    resumeControls,
    resumeJobFor,
    revivalDeliveryProven,
    revivalDeadlineAt,
    revivalFor,
    resetResumeControls,
    retire,
    scheduleDeliver,
    tidyCommands,
    bootstrapText,
    commandHomeConversation,
    describe
  };
}
