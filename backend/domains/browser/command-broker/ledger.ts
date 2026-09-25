import type { DurableCommandRecord, DurableCommandSnapshot } from './restore.js';
import type { Command, CommandReceipt } from './model.js';
import type { WorkerRevival } from '../../automation/agents.js';

export type RevivalRedeemResult = 'ok' | 'stale' | 'taken' | 'broker-not-durable' | 'lease-not-durable';

export interface BridgeCommandLedgerRuntime {
  COMMANDS_STATE: string;
  COMMAND_TTL_MS: number;
  MAX_COMMAND_RECEIPTS: number;
  commandWrites: Map<string, Promise<boolean>>;
  commandRedeems: Map<string, Promise<void>>;
  commandRetirementsAwaitingBroker: Map<string, Command>;
  getCommands(): Command[];
  replaceCommands(commands: Command[]): void;
  getCommandReceipts(): CommandReceipt[];
  replaceCommandReceipts(receipts: CommandReceipt[]): void;
  writeDurableNow(name: string, value: unknown): Promise<void>;
  writeDurableSoon(name: string, value: unknown): void;
  logWarn(message: string): void;
  specKey(spec: Command['spec']): string;
  revivalFor(agentId: string, runId: string): WorkerRevival | null;
  claimWorkerRevival(agentId: string, conversationId: string, runId: string): boolean;
  persistCriticalSwarmNow(): Promise<boolean>;
  rollbackWorkerRevivalClaim(agentId: string, conversationId: string, runId: string): boolean;
  changed(): void;
}

export function createBridgeCommandLedger(runtime: BridgeCommandLedgerRuntime) {
  const { COMMANDS_STATE, COMMAND_TTL_MS, MAX_COMMAND_RECEIPTS } = runtime;

  function commandPhase(command: Command): 'queued' | 'leased' {
    return command.claimedAt === null ? 'queued' : 'leased';
  }

  function durableCommand(command: Command): DurableCommandRecord {
    return {
      id: command.id,
      spec: command.spec,
      createdAt: command.createdAt,
      phase: commandPhase(command),
      claimedAt: command.claimedAt,
      owner: command.owner,
      lastError: command.lastError
    };
  }

  function pruneReceipts(now = Date.now()): void {
    runtime.replaceCommandReceipts(
      runtime.getCommandReceipts()
        .filter(receipt => now - receipt.completedAt <= COMMAND_TTL_MS)
        .slice(-MAX_COMMAND_RECEIPTS)
    );
  }

  function commandSnapshot(options: {
    commandOverride?: { command: Command; record: DurableCommandRecord };
    removeCommandId?: string;
    addReceipt?: CommandReceipt;
  } = {}): DurableCommandSnapshot {
    const { commandOverride, removeCommandId, addReceipt } = options;
    const commands = runtime.getCommands();
    const snapshotCommands = [
      ...commands,
      ...[...runtime.commandRetirementsAwaitingBroker.values()].filter(
        held => !commands.some(command => command.id === held.id)
      )
    ];
    const records = snapshotCommands
      .filter(command => command.id !== removeCommandId)
      .map(command => commandOverride?.command === command ? commandOverride.record : durableCommand(command));
    let receipts = runtime.getCommandReceipts().filter(receipt => Date.now() - receipt.completedAt <= COMMAND_TTL_MS);
    if (addReceipt) receipts = [...receipts.filter(receipt => receipt.id !== addReceipt.id), addReceipt];
    receipts = receipts.slice(-MAX_COMMAND_RECEIPTS);
    return { version: 4, commands: records, receipts };
  }

  function persistCommands(): void {
    if (runtime.commandWrites.size) {
      void Promise.allSettled([...runtime.commandWrites.values()]).then(() => persistCommands());
      return;
    }
    runtime.writeDurableSoon(COMMANDS_STATE, commandSnapshot());
  }

  async function writeCommandTransition(command: Command, transition: () => Promise<boolean>): Promise<boolean> {
    if (runtime.commandWrites.size) {
      await Promise.allSettled([...runtime.commandWrites.values()]);
      return writeCommandTransition(command, transition);
    }
    const work = Promise.resolve().then(transition);
    runtime.commandWrites.set(command.id, work);
    try {
      return await work;
    } finally {
      if (runtime.commandWrites.get(command.id) === work) runtime.commandWrites.delete(command.id);
    }
  }

  async function persistCommandLease(
    command: Command,
    owner: string | null,
    claimedAt: number,
    allowOwnerTakeover = false
  ): Promise<boolean> {
    return writeCommandTransition(command, async () => {
      if (!runtime.getCommands().includes(command)) return false;
      if (owner !== null && command.owner !== null && command.owner !== owner && !allowOwnerTakeover) return false;
      const record: DurableCommandRecord = { ...durableCommand(command), phase: 'leased', claimedAt, owner };
      try {
        await runtime.writeDurableNow(COMMANDS_STATE, commandSnapshot({ commandOverride: { command, record } }));
      } catch (err) {
        persistCommands();
        runtime.logWarn(`bridge: could not persist the lease for ${runtime.specKey(command.spec)} — ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      if (!runtime.getCommands().includes(command)) return false;
      command.claimedAt = claimedAt;
      command.owner = owner;
      return true;
    });
  }

  async function persistRevivalRedeem(command: Command, client: string, claimedAt: number): Promise<RevivalRedeemResult> {
    const earlier = runtime.commandRedeems.get(command.id);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    runtime.commandRedeems.set(command.id, gate);
    try {
      if (earlier) await earlier;
      if (!runtime.getCommands().includes(command)) return 'stale';
      if (command.owner && command.owner !== client) return 'taken';
      if (command.spec.type !== 'revive') return 'stale';
      const revival = runtime.revivalFor(command.spec.agent, command.spec.runId);
      if (!revival || revival.conversationId !== command.spec.conversationId) return 'stale';
      if (!runtime.claimWorkerRevival(command.spec.agent, command.spec.conversationId, command.spec.runId)) return 'stale';

      let brokerDurable = false;
      try {
        brokerDurable = await runtime.persistCriticalSwarmNow();
      } catch (err) {
        runtime.logWarn(`bridge: could not persist the broker claim for ${runtime.specKey(command.spec)} — ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!brokerDurable) {
        if (runtime.rollbackWorkerRevivalClaim(command.spec.agent, command.spec.conversationId, command.spec.runId)) {
          try {
            await runtime.persistCriticalSwarmNow();
          } catch (err) {
            runtime.logWarn(`bridge: could not persist rollback of ${runtime.specKey(command.spec)} claim — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return 'broker-not-durable';
      }

      if (!(await persistCommandLease(command, client, claimedAt))) {
        if (command.owner && command.owner !== client) return 'taken';
        return 'lease-not-durable';
      }
      return 'ok';
    } finally {
      release();
      if (runtime.commandRedeems.get(command.id) === gate) runtime.commandRedeems.delete(command.id);
    }
  }

  function receiptFor(id: string): CommandReceipt | null {
    pruneReceipts();
    return runtime.getCommandReceipts().find(receipt => receipt.id === id) ?? null;
  }

  function receiptReply(receipt: CommandReceipt): Record<string, unknown> {
    return {
      ok: true,
      final: true,
      committed: receipt.committed,
      outcome: receipt.outcome,
      conversationId: receipt.conversationId,
      error: receipt.error
    };
  }

  async function finalizeCommand(command: Command, receipt: CommandReceipt): Promise<boolean> {
    return writeCommandTransition(command, async () => {
      if (!runtime.getCommands().includes(command)) return receiptFor(receipt.id) !== null;
      try {
        await runtime.writeDurableNow(COMMANDS_STATE, commandSnapshot({ removeCommandId: command.id, addReceipt: receipt }));
      } catch (err) {
        persistCommands();
        runtime.logWarn(`bridge: could not persist the final receipt for ${runtime.specKey(command.spec)} — ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      if (command.timer) clearTimeout(command.timer);
      command.timer = null;
      runtime.replaceCommands(runtime.getCommands().filter(entry => entry !== command));
      runtime.replaceCommandReceipts([...runtime.getCommandReceipts().filter(entry => entry.id !== receipt.id), receipt].slice(-MAX_COMMAND_RECEIPTS));
      runtime.changed();
      return true;
    });
  }

  return {
    commandSnapshot,
    durableCommand,
    finalizeCommand,
    persistCommandLease,
    persistCommands,
    persistRevivalRedeem,
    receiptFor,
    receiptReply,
    writeCommandTransition
  };
}
