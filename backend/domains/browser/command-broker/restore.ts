import { isReasoningEffort } from '../../../../contracts/session.js';
import { conversationId } from '../companion-payload.js';
import { continuationByToken } from '../../sessions/continuity/continuation.js';
import { agentConversation, isProviderModelId, swarmRunning, swarmState } from '../../automation/agents.js';
import type { Command, CommandReceipt, CommandSpec } from './model.js';

export interface DurableCommandRecord {
  id: string;
  spec: CommandSpec;
  createdAt: number;
  phase: 'queued' | 'leased';
  claimedAt: number | null;
  owner: string | null;
  lastError: string | null;
}

export interface DurableCommandSnapshot {
  version: 4;
  commands: DurableCommandRecord[];
  receipts: CommandReceipt[];
}

export interface CommandRestorePlan {
  commands: Command[];
  receipts: CommandReceipt[];
  // Revival deadlines that expired offline are settled against the broker before publication.
  expiredRevivals: Array<{ id: string; spec: Extract<CommandSpec, { type: 'revive' }> }>;
  // Resume tokens discovered in the durable command file, published only with the plan.
  resumeTokens: Array<{ sessionId: string; token: string }>;
  // Number of durable commands newly reconstructed rather than retained from this process.
  restored: number;
}

interface Runtime {
  readonly commands: readonly Command[];
  readonly commandReceipts: readonly CommandReceipt[];
  readonly COMMAND_DEADLINE_MS: number;
  readonly COMMAND_TTL_MS: number;
  readonly MAX_COMMAND_RECEIPTS: number;
  readonly REVIVAL_ACTIVITY_MS: number;
  specKey(spec: CommandSpec): string;
  durableCommand(command: Command): DurableCommandRecord;
  revivalDeadlineAt(command: Command): number;
}

export function createBridgeCommandRestore(runtime: Runtime) {
  // Rebuild one receipt that is still useful, validating every persisted field.
  function restoredReceipt(raw: Partial<CommandReceipt>, now: number): CommandReceipt | null {
    if (
      typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 64 ||
      (raw.client !== null && raw.client !== undefined && (typeof raw.client !== 'string' || raw.client.length > 64)) ||
      (raw.conversationId !== null && raw.conversationId !== undefined && typeof raw.conversationId !== 'string') ||
      (raw.outcome !== 'committed' && raw.outcome !== 'terminal-failure') ||
      typeof raw.committed !== 'boolean' ||
      !Number.isFinite(raw.completedAt) ||
      now - Number(raw.completedAt) > runtime.COMMAND_TTL_MS ||
      (raw.outcome === 'committed') !== raw.committed
    ) {
      return null;
    }
    return {
      id: raw.id,
      client: typeof raw.client === 'string' ? raw.client : null,
      conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : null,
      outcome: raw.outcome,
      committed: raw.committed,
      error: typeof raw.error === 'string' ? raw.error.slice(0, 200) : null,
      completedAt: Number(raw.completedAt)
    };
  }

  // Rebuild one command spec against current durable authority.
  function restoredCommandSpec(version: number, raw: Partial<CommandSpec>): CommandSpec | null {
    if (raw.type === 'stop') {
      const stop = raw as Partial<Extract<CommandSpec, { type: 'stop' }>>;
      if (typeof stop.sessionId !== 'string' || !/^[a-z0-9-]{8,64}$/i.test(stop.sessionId) ||
          typeof stop.conversationId !== 'string' || !conversationId(stop.conversationId) ||
          typeof stop.turnId !== 'string' || !stop.turnId || stop.turnId.length > 256) return null;
      if (stop.userMessageId !== undefined && (typeof stop.userMessageId !== 'string' || !stop.userMessageId || stop.userMessageId.length > 256)) return null;
      return { type: 'stop', sessionId: stop.sessionId, conversationId: stop.conversationId, turnId: stop.turnId, ...(stop.userMessageId ? { userMessageId: stop.userMessageId } : {}) };
    }
    if (
      version >= 3 &&
      raw.type === 'worker' &&
      typeof (raw as Partial<Extract<CommandSpec, { type: 'worker' }>>).agent === 'string' &&
      /^[a-z0-9-]{1,40}$/i.test((raw as Extract<CommandSpec, { type: 'worker' }>).agent) &&
      typeof (raw as Partial<Extract<CommandSpec, { type: 'worker' }>>).task === 'string' &&
      typeof (raw as Partial<Extract<CommandSpec, { type: 'worker' }>>).runId === 'string'
    ) {
      const worker = raw as Extract<CommandSpec, { type: 'worker' }>;
      if (!swarmRunning(worker.runId)) return null;
      // Keep only bootstraps that still belong to an invited or active worker.
      const workerState = swarmState(worker.runId).agents.find((entry) => entry.id === worker.agent && entry.role === 'worker')?.state;
      if (workerState !== 'invited' && workerState !== 'active') return null;
      // Invalid model preferences restore to the account defaults.
      return {
        type: 'worker',
        agent: worker.agent,
        task: worker.task.slice(0, 512 * 1024),
        model: isProviderModelId(worker.model) ? worker.model : null,
        reasoningEffort: isReasoningEffort(worker.reasoningEffort) ? worker.reasoningEffort : null,
        runId: worker.runId
      };
    }
    if (
      version >= 4 &&
      raw.type === 'revive' &&
      typeof (raw as Partial<Extract<CommandSpec, { type: 'revive' }>>).agent === 'string' &&
      /^[a-z0-9-]{1,40}$/i.test((raw as Extract<CommandSpec, { type: 'revive' }>).agent) &&
      typeof (raw as Partial<Extract<CommandSpec, { type: 'revive' }>>).conversationId === 'string' &&
      typeof (raw as Partial<Extract<CommandSpec, { type: 'revive' }>>).runId === 'string'
    ) {
      const revive = raw as Extract<CommandSpec, { type: 'revive' }>;
      if (!swarmRunning(revive.runId)) return null;
      if (agentConversation(revive.agent, revive.runId) !== revive.conversationId) return null;
      const revivalState = swarmState(revive.runId).agents.find((entry) => entry.id === revive.agent && entry.role === 'worker')?.state;
      if (revivalState !== 'waking' && revivalState !== 'active') return null;
      return {
        type: 'revive',
        agent: revive.agent,
        conversationId: revive.conversationId,
        runId: revive.runId,
        wake: typeof revive.wake === 'string' ? revive.wake : ''
      };
    }
    if (
      raw.type === 'resume' &&
      typeof (raw as Partial<Extract<CommandSpec, { type: 'resume' }>>).sessionId === 'string' &&
      typeof (raw as Partial<Extract<CommandSpec, { type: 'resume' }>>).token === 'string'
    ) {
      const resume = raw as Extract<CommandSpec, { type: 'resume' }>;
      const continuation = continuationByToken(resume.token);
      if (!continuation || continuation.sessionId !== resume.sessionId || continuation.state === 'aborted') return null;
      return { type: 'resume', sessionId: resume.sessionId, token: resume.token };
    }
    return null;
  }

  // Snapshot an explicit command set without reading the live bridge state mid-plan.
  function snapshot(
    plannedCommands: readonly Command[],
    plannedReceipts: readonly CommandReceipt[],
    now: number
  ): DurableCommandSnapshot {
    return {
      version: 4,
      commands: plannedCommands.map(command => runtime.durableCommand(command)),
      receipts: plannedReceipts
        .filter(receipt => now - receipt.completedAt <= runtime.COMMAND_TTL_MS)
        .slice(-runtime.MAX_COMMAND_RECEIPTS)
    };
  }

  // Reconstruct durable commands locally; publication remains the caller's responsibility.
  function plan(
    saved: { version?: number; commands?: unknown; receipts?: unknown },
    now: number
  ): CommandRestorePlan | null {
    const { commands, commandReceipts } = runtime;
    if (saved.version !== 1 && saved.version !== 2 && saved.version !== 3 && saved.version !== 4 || !Array.isArray(saved.commands)) return null;
    const version = saved.version;
    const plannedCommands = [...commands];
    const plannedReceipts = commandReceipts
      .filter(receipt => now - receipt.completedAt <= runtime.COMMAND_TTL_MS)
      .slice(-runtime.MAX_COMMAND_RECEIPTS);
    const receiptIds = new Set(plannedReceipts.map(receipt => receipt.id));
    if (version !== 1 && Array.isArray(saved.receipts)) {
      for (const raw of saved.receipts as Array<Partial<CommandReceipt>>) {
        const receipt = restoredReceipt(raw, now);
        if (!receipt || receiptIds.has(receipt.id)) continue;
        receiptIds.add(receipt.id);
        plannedReceipts.push(receipt);
      }
      if (plannedReceipts.length > runtime.MAX_COMMAND_RECEIPTS) {
        plannedReceipts.splice(0, plannedReceipts.length - runtime.MAX_COMMAND_RECEIPTS);
      }
    }
    const retainedKeys = new Set(plannedCommands.map(command => runtime.specKey(command.spec)));
    const expiredRevivals: CommandRestorePlan['expiredRevivals'] = [];
    const resumeTokens = plannedCommands
      .filter((command): command is Command & { spec: Extract<CommandSpec, { type: 'resume' }> } => command.spec.type === 'resume')
      .map(command => ({ sessionId: command.spec.sessionId, token: command.spec.token }));
    const durableCandidates = new Map<string, { raw: Partial<DurableCommandRecord>; spec: CommandSpec; createdAt: number }>();
    let restored = 0;
    for (const raw of saved.commands as Array<Partial<DurableCommandRecord>>) {
      const specRaw = raw.spec as Partial<CommandSpec> | undefined;
      if (!specRaw || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 64) continue;
      const spec = restoredCommandSpec(version, specRaw);
      if (!spec) continue;
      const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
      const key = runtime.specKey(spec);
      if (retainedKeys.has(key) || receiptIds.has(raw.id)) continue;
      const prior = durableCandidates.get(key);
      if (!prior || createdAt >= prior.createdAt) durableCandidates.set(key, { raw, spec, createdAt });
    }
    for (const { raw, spec, createdAt } of durableCandidates.values()) {
      if (spec.type === 'resume') resumeTokens.push({ sessionId: spec.sessionId, token: spec.token });
      const persistedLeased = version !== 1 && raw.phase === 'leased';
      const stale = spec.type === 'revive'
        ? now - createdAt >= runtime.REVIVAL_ACTIVITY_MS
        : now - createdAt > runtime.COMMAND_TTL_MS;
      if (stale) {
        if (spec.type === 'revive') expiredRevivals.push({ id: raw.id!, spec });
        continue;
      }
      const continuation = spec.type === 'resume' ? continuationByToken(spec.token) : null;
      const legacyAlreadyClaimed = version === 1 && continuation !== null &&
        (continuation.state === 'claimed' || continuation.state === 'committing' || continuation.state === 'committed');
      const leased = persistedLeased || legacyAlreadyClaimed;
      let claimedAt = leased && typeof raw.claimedAt === 'number' && Number.isFinite(raw.claimedAt) ? raw.claimedAt : null;
      if (leased && claimedAt === null) claimedAt = now;
      if (claimedAt !== null && claimedAt > now + runtime.COMMAND_DEADLINE_MS) claimedAt = now;
      plannedCommands.push({
        id: raw.id!,
        spec,
        createdAt,
        claimedAt,
        timer: null,
        lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
        owner: leased && typeof raw.owner === 'string' ? raw.owner.slice(0, 64) : null
      });
      restored += 1;
    }
    const expiredRetainedRevivalIds = new Set<string>();
    for (const command of plannedCommands) {
      if (command.spec.type !== 'revive' || now < runtime.revivalDeadlineAt(command)) continue;
      expiredRevivals.push({ id: command.id, spec: command.spec });
      expiredRetainedRevivalIds.add(command.id);
    }
    const commandsAfterExpiredRevival = plannedCommands.filter(command => !expiredRetainedRevivalIds.has(command.id));
    return {
      commands: commandsAfterExpiredRevival,
      receipts: plannedReceipts.slice(-runtime.MAX_COMMAND_RECEIPTS),
      expiredRevivals,
      resumeTokens,
      restored
    };
  }

  return { plan, snapshot };
}
