import type { Command, CommandReceipt, CommandSpec } from './model.js';
import type { WorkerRevival } from '../../automation/agents.js';
import type { WorkerSpawn } from '../../automation/agents-types.js';
import { continuationByToken } from '../../sessions/continuity/continuation.js';
import { CONTINUATION_TTL_MS } from '../../sessions/continuity/continuation.js';

export interface BridgeCommandDeadlineRuntime {
  COMMAND_DEADLINE_MS: number;
  REVIVAL_ACTIVITY_MS: number;
  REVIVAL_DEADLINE_MS: number;
  RESUME_STEP_STALL_MS: number;
  STOP_COMMAND_TIMEOUT_MS: number;
  WORKER_BOOTSTRAP_LIMIT_MS: number;
  WORKER_REDEEM_MS: number;
  browserLaunchGraceMs: number;
  commandStepText(step: string): string;
  compactionOpeningEvery: number;
  revivalWaitSteps: ReadonlySet<string>;
  resumeStallSteps: ReadonlySet<string>;
  getCommands(): Command[];
  replaceCommands(commands: Command[]): void;
  lastBrowserLaunchAt(): number;
  workerRevivalDeliveredSince(agentId: string, conversationId: string, commandId: string, claimedAt: number, runId?: string): boolean;
  pendingWorkerSpawns(): readonly WorkerSpawn[];
  revivalFor(agentId: string, runId: string): WorkerRevival | null;
  finalizeCommand(command: Command, receipt: CommandReceipt): Promise<boolean>;
  persistCommands(): void;
  specKey(spec: CommandSpec): string;
  changed(): void;
  logInfo(message: string): void;
  drop(command: Command, reason: string): boolean;
  deliver(): void | Promise<void>;
}

export function createBridgeCommandDeadlines(runtime: BridgeCommandDeadlineRuntime) {
  let deliverScheduled = false;

  function revivalDeliveryProven(command: Command): boolean {
    return command.spec.type === 'revive' && command.claimedAt !== null && runtime.workerRevivalDeliveredSince(
      command.spec.agent,
      command.spec.conversationId,
      command.id,
      command.claimedAt,
      command.spec.runId
    );
  }

  function revivalDeadlineAt(command: Command): number {
    return command.createdAt + (revivalDeliveryProven(command) ? runtime.REVIVAL_ACTIVITY_MS : runtime.REVIVAL_DEADLINE_MS);
  }

  function commandDeadlineDelay(command: Command, now = Date.now()): number {
    if (command.spec.type === 'stop') return command.createdAt + runtime.STOP_COMMAND_TIMEOUT_MS - now;
    if (command.spec.type === 'revive') return revivalDeadlineAt(command) - now;
    if (command.spec.type === 'resume' && continuationByToken(command.spec.token)?.automatic) {
      const checkpoint = (command.claimedAt ?? command.createdAt) + runtime.compactionOpeningEvery;
      const { step, stepAt } = command.progress ?? {};
      const stalled = step && stepAt !== undefined && runtime.resumeStallSteps.has(step) ? stepAt + runtime.RESUME_STEP_STALL_MS : Infinity;
      return Math.min(checkpoint, stalled) - now;
    }
    if (command.spec.type === 'resume' && command.owner !== null) {
      const continuation = continuationByToken(command.spec.token);
      if (continuation?.state === 'claimed') return continuation.touchedAt + CONTINUATION_TTL_MS - now;
    }
    if (command.spec.type === 'worker') {
      const limit = command.createdAt + runtime.WORKER_BOOTSTRAP_LIMIT_MS;
      if (command.claimedAt === null) return limit - now;
      if (command.owner === null) {
        const redeemBy = Math.max(command.claimedAt + runtime.WORKER_REDEEM_MS, runtime.lastBrowserLaunchAt() + runtime.browserLaunchGraceMs);
        return Math.min(redeemBy, limit) - now;
      }
      return Math.min(command.claimedAt + runtime.COMMAND_DEADLINE_MS, limit) - now;
    }
    return (command.claimedAt ?? now) + runtime.COMMAND_DEADLINE_MS - now;
  }

  function armDeadline(command: Command, delay = commandDeadlineDelay(command)): void {
    if (command.timer) clearTimeout(command.timer);
    command.timer = setTimeout(() => {
      command.timer = null;
      expire(command);
    }, Math.max(1, delay));
    command.timer.unref?.();
  }

  function rearmRetainedCommandDeadlines(): void {
    const now = Date.now();
    const expired: Command[] = [];
    for (const command of runtime.getCommands()) {
      const automaticResume = command.spec.type === 'resume' && continuationByToken(command.spec.token)?.automatic === true;
      if (
        (command.claimedAt === null && command.spec.type !== 'revive' && command.spec.type !== 'worker' && !automaticResume) ||
        command.timer
      ) continue;
      const remaining = commandDeadlineDelay(command, now);
      if (remaining > 0) armDeadline(command, remaining);
      else expired.push(command);
    }
    for (const command of expired) expire(command);
  }

  function expire(command: Command): void {
    if (!runtime.getCommands().includes(command)) return;
    const spec = command.spec;
    if (spec.type === 'revive') {
      const remaining = commandDeadlineDelay(command);
      if (remaining > 0) {
        armDeadline(command, remaining);
        return;
      }
    }
    if (spec.type === 'resume') {
      const continuation = continuationByToken(spec.token);
      if (continuation?.state === 'committed' && continuation.to) {
        const receipt: CommandReceipt = {
          id: command.id,
          client: command.owner,
          conversationId: continuation.to,
          outcome: 'committed',
          committed: true,
          error: null,
          completedAt: Date.now()
        };
        void runtime.finalizeCommand(command, receipt).then(stored => {
          if (stored) runtime.deliver();
          else if (runtime.getCommands().includes(command)) armDeadline(command, 5_000);
        });
        return;
      }
      if (continuation?.state === 'committing') {
        armDeadline(command, 1_000);
        return;
      }
    }
    if (spec.type === 'worker' && !runtime.pendingWorkerSpawns().some(worker => worker.id === spec.agent && worker.runId === spec.runId)) {
      retire(command, 'its worker is bound and running');
      return;
    }
    if (spec.type === 'revive' && !runtime.revivalFor(spec.agent, spec.runId)) {
      retire(command, 'its worker is no longer waiting to be woken');
      return;
    }
    runtime.drop(command, commandExpiryReason(command));
    runtime.deliver();
  }

  function commandExpiryReason(command: Command): string {
    if (command.lastError) return command.lastError;
    if (command.claimedAt !== null) return `the chat this app opened did not report back in time (${commandProgress(command)})`;
    const step = command.progress?.step;
    return step && runtime.revivalWaitSteps.has(step)
      ? `the browser did not claim this command before its deadline (${runtime.commandStepText(step)})`
      : 'the browser did not claim this command before its deadline';
  }

  function commandProgress(command: Command, now = Date.now()): string {
    const progress = command.progress ?? {};
    if (command.owner === null) {
      if (progress.opened === 'browser') return 'the browser opened it, but the page never picked up its task';
      if (progress.opened === 'os') return 'it was opened through the operating system, and no page with the extension picked up its task';
      return 'no browser opened it';
    }
    if (!progress.step || runtime.revivalWaitSteps.has(progress.step) || progress.stepAt === undefined) {
      return 'the page picked up its task, then reported nothing more';
    }
    const seconds = Math.max(0, Math.round((now - progress.stepAt) / 1000));
    return `last step: ${runtime.commandStepText(progress.step)}, reported ${seconds} s before the app gave up`;
  }

  function retire(command: Command, why: string): void {
    if (command.timer) clearTimeout(command.timer);
    command.timer = null;
    delete command.placement;
    const commands = runtime.getCommands();
    if (!commands.includes(command)) return;
    runtime.replaceCommands(commands.filter(entry => entry !== command));
    runtime.logInfo(`bridge: ${runtime.specKey(command.spec)} is done — ${why}`);
    runtime.changed();
    runtime.persistCommands();
    scheduleDeliver();
  }

  function scheduleDeliver(): void {
    if (deliverScheduled) return;
    deliverScheduled = true;
    queueMicrotask(() => {
      deliverScheduled = false;
      void runtime.deliver();
    });
  }

  return {
    armDeadline,
    commandDeadlineDelay,
    commandExpiryReason,
    commandProgress,
    expire,
    rearmRetainedCommandDeadlines,
    revivalDeadlineAt,
    revivalDeliveryProven,
    retire,
    scheduleDeliver
  };
}
