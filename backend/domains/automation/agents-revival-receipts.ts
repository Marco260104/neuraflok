import type { agentsRevivalRuntime } from './agents.js';

type Runtime = typeof agentsRevivalRuntime;

// Owns browser delivery receipts for worker revivals.
export function createAgentRevivalReceipts(runtime: Runtime) {
  const { boundAgent, changed, logInfo, logWarn, recount, runForConversation, scopedRun } = runtime;

  // Gives the browser exclusive ownership of an in-flight wake before it receives the text.
  function claimWorkerRevival(id: string, conversationId: string, runId?: string): boolean {
    const run = scopedRun(runId);
    const agent = run?.agents.get(id);
    if (!agent || agent.info.state !== 'waking' || agent.info.conversationId !== conversationId) return false;
    if (!agent.info.revivable) return true;
    agent.info.revivable = false;
    changed('critical');
    return true;
  }

  // Rolls back only the browser-claim marker while the wake is otherwise still untouched.
  function rollbackWorkerRevivalClaim(id: string, conversationId: string, runId?: string): boolean {
    const run = scopedRun(runId);
    const agent = run?.agents.get(id);
    if (!agent || agent.info.state !== 'waking' || agent.info.conversationId !== conversationId || agent.info.revivable) {
      return false;
    }
    agent.info.revivable = true;
    changed('critical');
    return true;
  }

  // Returns whether a browser-owned wake is between durable redeem and sent or failed acknowledgement.
  function workerRevivalClaimed(conversationId: string | null | undefined): boolean {
    const run = runForConversation(conversationId);
    if (!run || !conversationId) return false;
    const agent = boundAgent(conversationId);
    return Boolean(agent?.info.role === 'worker' && agent.info.state === 'waking' &&
      !agent.info.revivable && !agent.info.lastRevivalCommandId);
  }

  // Preserves retry evidence when a crash occurs between the worker snapshot and bridge receipt writes.
  function workerRevivalDeliveredSince(
    id: string,
    conversationId: string,
    commandId: string,
    claimedAt: number,
    runId?: string
  ): boolean {
    const run = scopedRun(runId);
    const agent = run?.agents.get(id);
    if (!agent || !conversationId || agent.info.conversationId !== conversationId) return false;
    if (commandId && agent.info.lastRevivalCommandId === commandId) return true;
    return agent.queue.some(
      (message) =>
        message.ackedAt === null &&
        message.offeredViaRevival === true &&
        message.offeredAt !== null &&
        message.offeredAt >= claimedAt
    );
  }

  // Records a browser acknowledgement as an offer, without treating delivery as worker liveness.
  function noteWorkerRevived(
    id: string,
    conversationId: string,
    messageIds: readonly string[],
    commandId: string | null = null,
    runId?: string
  ): boolean {
    const run = scopedRun(runId);
    const agent = run?.agents.get(id);
    if (!agent || agent.info.state !== 'waking') return false;
    if (!conversationId || agent.info.conversationId !== conversationId) {
      logWarn(`multi-agent: refused a revival ack for ${id} naming conversation ${conversationId}`);
      return false;
    }
    if (commandId && agent.info.lastRevivalCommandId === commandId) return true;
    const now = Date.now();
    agent.info.revivable = false;
    agent.info.finishedAt = null;
    agent.info.result = null;
    if (commandId) agent.info.lastRevivalCommandId = commandId;
    const offered = new Set(messageIds);
    for (const message of agent.queue) {
      if (message.ackedAt !== null || message.offeredViaRevival || !offered.has(message.id)) continue;
      message.offeredAt = now;
      message.offers += 1;
      message.offeredOnFinish = false;
      message.offeredViaRevival = true;
    }
    recount(agent);
    logInfo(`multi-agent: revival message reached ${id} in conversation ${conversationId}; waiting for worker liveness`);
    changed('critical');
    return true;
  }

  return {
    claimWorkerRevival,
    noteWorkerRevived,
    rollbackWorkerRevivalClaim,
    workerRevivalClaimed,
    workerRevivalDeliveredSince
  };
}
