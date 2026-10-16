import type { Command } from './model.js';

export interface BridgeWorkerCommandLeaseDependencies {
  getCommands(): readonly Command[];
  isRunActive(runId: string): boolean;
  bindConversation(agentId: string, conversationId: string, runId: string): boolean;
}

export function createBridgeWorkerCommandLease({
  getCommands,
  isRunActive,
  bindConversation
}: BridgeWorkerCommandLeaseDependencies): (agentId: string | null, commandId: string | null, conversationId: string) => boolean {
  return (agentId, commandId, conversationId) => {
    if (!agentId || !commandId) return false;
    const command = getCommands().find(candidate =>
      candidate.id === commandId &&
      candidate.spec.type === 'worker' &&
      candidate.spec.agent === agentId &&
      isRunActive(candidate.spec.runId) &&
      candidate.claimedAt !== null
    );
    return command?.spec.type === 'worker'
      ? bindConversation(agentId, conversationId, command.spec.runId)
      : false;
  };
}
