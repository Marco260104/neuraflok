import { agentInfoForOwnedConversation, noteAgentAlive, persistCriticalSwarmNow } from './agents.js';
import { recordAgentMessage } from '../sessions/history/recorder.js';
import { logWarn } from '../../infrastructure/settings/logger.js';

export async function noteLocalAgentTurnStarted(conversationId: string, at = Date.now()): Promise<void> {
  if (agentInfoForOwnedConversation(conversationId)?.role !== 'worker') return;
  const alive = noteAgentAlive(conversationId, 'turn', at);
  if (!alive) return;
  if (alive.revived && !(await persistCriticalSwarmNow().catch(() => false))) {
    logWarn(`multi-agent: local turn liveness for ${conversationId} is not durable yet`);
  }
  if (alive.report) await recordAgentMessage(alive.report, 'sent', conversationId);
}
