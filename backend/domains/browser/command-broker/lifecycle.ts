import type { Command } from './model.js';
import type { BridgeCommandLedgerRuntime } from './ledger.js';
import { continuationByToken } from '../../sessions/continuity/continuation.js';

type CommandLedger = ReturnType<typeof import('./ledger.js').createBridgeCommandLedger>;
type CommandDeadlines = ReturnType<typeof import('./deadlines.js').createBridgeCommandDeadlines>;

export interface BridgeCommandLifecycleRuntime {
  COMMANDS_STATE: string;
  COMMAND_TTL_MS: number;
  abortContinuation: typeof import('../../sessions/continuity/continuation.js').abortContinuation;
  changed: BridgeCommandLedgerRuntime['changed'];
  commandDeadlineDelay: CommandDeadlines['commandDeadlineDelay'];
  commandExpiryReason: CommandDeadlines['commandExpiryReason'];
  commandRetirementsAwaitingBroker: Map<string, Command>;
  commandSnapshot: CommandLedger['commandSnapshot'];
  commandWrites: Map<string, Promise<boolean>>;
  failAgent: typeof import('../../automation/agents.js').failAgent;
  failWorkerRevival: typeof import('../../automation/agents.js').failWorkerRevival;
  logWarn(message: string): void;
  pendingWorkerRevivals: typeof import('../../automation/agents.js').pendingWorkerRevivals;
  pendingWorkerSpawns: typeof import('../../automation/agents.js').pendingWorkerSpawns;
  persistCommands: CommandLedger['persistCommands'];
  persistCriticalSwarmNow: BridgeCommandLedgerRuntime['persistCriticalSwarmNow'];
  releaseContinuationDestinationSendNow: typeof import('../../sessions/continuity/continuation.js').releaseContinuationDestinationSendNow;
  releaseQuiescentRun: () => void;
  revivalDeadlineAt: CommandDeadlines['revivalDeadlineAt'];
  retire: CommandDeadlines['retire'];
  scheduleDeliver: CommandDeadlines['scheduleDeliver'];
  specKey: BridgeCommandLedgerRuntime['specKey'];
  swarmRunning: typeof import('../../automation/agents.js').swarmRunning;
  writeCommandTransition: CommandLedger['writeCommandTransition'];
  writeDurableNow: BridgeCommandLedgerRuntime['writeDurableNow'];
  getCommands(): Command[];
  replaceCommands(commands: Command[]): void;
}

export function createBridgeCommandLifecycle(runtime: BridgeCommandLifecycleRuntime) {
  function drop(command: Command, why: string): boolean {
    const commands = runtime.getCommands();
    if (!commands.includes(command)) return false;
    const automaticEntry = command.spec.type === 'resume' ? continuationByToken(command.spec.token) : null;
    const automaticResume = automaticEntry?.automatic === true && automaticEntry.state !== 'committing' && automaticEntry.state !== 'committed';
    if (automaticResume) {
      void runtime.writeCommandTransition(command, async () => {
        if (!runtime.getCommands().includes(command) || command.spec.type !== 'resume') return false;
        const entry = continuationByToken(command.spec.token);
        if (!entry?.automatic || entry.state === 'committing' || entry.state === 'committed') return false;
        if (entry.destinationSend.state === 'not-attempted') await runtime.releaseContinuationDestinationSendNow(command.spec.token, command.id);
        await runtime.writeDurableNow(runtime.COMMANDS_STATE, runtime.commandSnapshot({ removeCommandId: command.id }));
        if (command.timer) clearTimeout(command.timer);
        command.timer = null;
        runtime.replaceCommands(runtime.getCommands().filter(candidate => candidate !== command));
        runtime.logWarn(`bridge: released ${runtime.specKey(command.spec)} browser attempt without closing its ticket — ${why}`);
        runtime.changed();
        return true;
      }).then(retired => {
        if (retired) runtime.scheduleDeliver();
      }).catch(error => {
        runtime.persistCommands();
        runtime.logWarn(`bridge: could not durably retire ${runtime.specKey(command.spec)} — ${error instanceof Error ? error.message : String(error)}`);
      });
      return true;
    }
    const needsBrokerFence = command.spec.type === 'worker' || command.spec.type === 'revive';
    if (needsBrokerFence) runtime.commandRetirementsAwaitingBroker.set(command.id, command);
    if (command.spec.type === 'resume') {
      const before = continuationByToken(command.spec.token);
      const aborted = before ? runtime.abortContinuation(command.spec.token, why) : false;
      const after = continuationByToken(command.spec.token);
      if (!aborted && (after?.state === 'committing' || after?.state === 'committed')) {
        runtime.logWarn(`bridge: ${runtime.specKey(command.spec)} could not be cancelled after its commit boundary — ${why}`);
        return false;
      }
    }
    if (command.timer) clearTimeout(command.timer);
    command.timer = null;
    runtime.replaceCommands(runtime.getCommands().filter(entry => entry !== command));
    if (command.spec.type === 'worker') runtime.failAgent(command.spec.agent, why, undefined, {}, command.spec.runId);
    if (command.spec.type === 'revive') runtime.failWorkerRevival(command.spec.agent, why, command.spec.runId);
    runtime.logWarn(`bridge: gave up on ${runtime.specKey(command.spec)} — ${why}`);
    runtime.changed();
    runtime.persistCommands();
    runtime.releaseQuiescentRun();
    if (needsBrokerFence) {
      void runtime.persistCriticalSwarmNow()
        .then(durable => {
          if (!durable) {
            runtime.logWarn(`bridge: kept retired ${runtime.specKey(command.spec)} durable because its broker transition had no immediate persistence sink`);
            return;
          }
          if (runtime.commandRetirementsAwaitingBroker.delete(command.id)) runtime.persistCommands();
        })
        .catch(err => {
          runtime.logWarn(`bridge: kept retired ${runtime.specKey(command.spec)} durable because its broker transition could not be persisted — ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    return true;
  }

  function tidyCommands(): void {
    const now = Date.now();
    const pendingWorkers = new Set(runtime.pendingWorkerSpawns().map(worker => `${worker.runId}:${worker.id}`));
    const wakingWorkers = new Set(runtime.pendingWorkerRevivals().map(revival => `${revival.runId}:${revival.id}`));
    for (const command of [...runtime.getCommands()]) {
      const workerAgent = command.spec.type === 'worker' ? command.spec.agent : null;
      if ((command.spec.type === 'worker' || command.spec.type === 'revive') && !runtime.swarmRunning(command.spec.runId)) {
        runtime.retire(command, `its worker run ${command.spec.runId} is no longer current`);
        continue;
      }
      if (command.spec.type === 'revive' && !wakingWorkers.has(`${command.spec.runId}:${command.spec.agent}`)) {
        runtime.retire(command, 'its worker is no longer waiting to be woken');
        continue;
      }
      if (workerAgent && command.spec.type === 'worker' && command.claimedAt === null && !pendingWorkers.has(`${command.spec.runId}:${workerAgent}`)) {
        runtime.retire(command, 'its worker is bound and running');
        continue;
      }
      const automaticResume = command.spec.type === 'resume' && continuationByToken(command.spec.token)?.automatic === true;
      const stale = command.spec.type === 'revive'
        ? now >= runtime.revivalDeadlineAt(command)
        : !automaticResume && now - command.createdAt > runtime.COMMAND_TTL_MS;
      if (stale) {
        drop(command, command.spec.type === 'revive'
          ? runtime.commandExpiryReason(command)
          : 'it has been waiting too long to still be what the user expects');
      }
    }
  }

  function isLeased(command: Command): boolean {
    if (command.claimedAt === null) return false;
    if (runtime.commandDeadlineDelay(command) > 0) return true;
    if (command.spec.type !== 'resume') return false;
    const state = continuationByToken(command.spec.token)?.state;
    return state === 'committing' || state === 'committed';
  }

  function nextDeliverable(): Command | null {
    if (runtime.commandWrites.size > 0) return null;
    return runtime.getCommands().find(command => command.claimedAt === null &&
      (command.spec.type === 'worker' || command.spec.type === 'resume')) ?? null;
  }

  return { drop, isLeased, nextDeliverable, tidyCommands };
}
