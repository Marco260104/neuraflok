import type { Command, CommandReceipt } from './model.js';
import type { createBridgeCommandRestore } from './restore.js';

export interface BridgeCommandRestorationRuntime {
  COMMANDS_STATE: string;
  agentForConversation: typeof import('../../automation/agents.js').agentForConversation;
  commandRestorePlanner: ReturnType<typeof createBridgeCommandRestore>;
  changed(): void;
  failWorkerRevival: typeof import('../../automation/agents.js').failWorkerRevival;
  logInfo: typeof import('../../../infrastructure/settings/logger.js').logInfo;
  logWarn: typeof import('../../../infrastructure/settings/logger.js').logWarn;
  pendingWorkerRevivals: typeof import('../../automation/agents.js').pendingWorkerRevivals;
  persistCommands(): void;
  persistCriticalSwarmNow: typeof import('../../automation/agents.js').persistCriticalSwarmNow;
  readDurable: typeof import('../../../persistence/durable.js').readDurable;
  rearmRetainedCommandDeadlines(): void;
  releaseQuiescentRun: typeof import('../../automation/agents.js').releaseQuiescentRun;
  rememberToken(sessionId: string, token: string): void;
  setCommands(commands: Command[]): void;
  setCommandReceipts(receipts: CommandReceipt[]): void;
  writeDurableNow: typeof import('../../../persistence/durable.js').writeDurableNow;
}

export function createBridgeCommandRestoration(runtime: BridgeCommandRestorationRuntime) {
  async function restoreCommands(): Promise<void> {
    const saved = await runtime.readDurable<{
      version?: number;
      commands?: unknown;
      receipts?: unknown;
    }>(runtime.COMMANDS_STATE);
    if (!saved) return;
    const now = Date.now();
    const plan = runtime.commandRestorePlanner.plan(saved, now);
    if (!plan) return;

    if (plan.expiredRevivals.length > 0) {
      let brokerRelevant = false;
      for (const expired of plan.expiredRevivals) {
        const revive = expired.spec;
        if (runtime.agentForConversation(revive.conversationId) !== revive.agent) continue;
        brokerRelevant = true;
        const owed = runtime.pendingWorkerRevivals().find(
          entry => entry.id === revive.agent && entry.conversationId === revive.conversationId && entry.runId === revive.runId
        );
        if (!owed) continue;
        runtime.failWorkerRevival(revive.agent, 'its durable revival expired while the app was not running', revive.runId);
      }

      if (brokerRelevant) {
        let persisted = false;
        try {
          persisted = await runtime.persistCriticalSwarmNow();
        } catch (err) {
          throw new Error(
            `could not durably settle expired worker revival(s); bridge startup must retry before pruning them — ${err instanceof Error ? err.message : String(err)}`
          );
        }
        if (!persisted) {
          throw new Error('could not durably settle expired worker revival(s); bridge startup must retry before pruning them');
        }
      }
    }

    let rewriteDurable = true;
    try {
      await runtime.writeDurableNow(runtime.COMMANDS_STATE, runtime.commandRestorePlanner.snapshot(plan.commands, plan.receipts, now));
      rewriteDurable = false;
    } catch (err) {
      runtime.logWarn(`bridge: could not persist reconstructed command state — ${err instanceof Error ? err.message : String(err)}`);
    }

    runtime.setCommands(plan.commands);
    runtime.setCommandReceipts(plan.receipts);
    for (const token of plan.resumeTokens) runtime.rememberToken(token.sessionId, token.token);
    runtime.rearmRetainedCommandDeadlines();
    if (plan.restored > 0) {
      runtime.logInfo(`bridge: restored ${plan.restored} chat command(s) from the previous run`);
      runtime.changed();
    }
    if (rewriteDurable) runtime.persistCommands();
    runtime.releaseQuiescentRun();
  }

  return { restoreCommands };
}
