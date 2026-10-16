import { deleteWorkspaceFor, primeWorkspace, pruneWorkspaceCache, setWorkspaceFor, workspaceForChat, workspaceForKey } from './registry.js';

function stagedAgentKey(agentId: string, runId?: string | null): string | null {
  return agentId && runId ? `agent:${runId}:${agentId}` : null;
}

export function inheritWorkspace(toAgent: string, primeConversationId: string | null, runId?: string, requestId?: string): boolean {
  const key = stagedAgentKey(toAgent, runId);
  if (!key) return false;
  const held = primeWorkspace(primeConversationId) ?? (requestId ? workspaceForKey(`request:${requestId}`) : undefined);
  if (!held) { deleteWorkspaceFor(key); return false; }
  setWorkspaceFor(key, { virtual: held.virtual, real: held.real });
  return true;
}

export function releasePrimeWorkspace(_primeConversationId: string | null, runId?: string): boolean {
  const key = stagedAgentKey('prime', runId);
  return key ? deleteWorkspaceFor(key) : false;
}

export function parkAgentWorkspace(agentId: string, conversationId: string | null, runId?: string): boolean {
  const key = stagedAgentKey(agentId, runId);
  if (!key || !conversationId) return false;
  pruneWorkspaceCache();
  const held = workspaceForKey(key);
  if (held && !workspaceForKey(`chat:${conversationId}`)) setWorkspaceFor(`chat:${conversationId}`, { virtual: held.virtual, real: held.real });
  deleteWorkspaceFor(key);
  return Boolean(held);
}

export function bindAgentWorkspace(agentId: string, conversationId: string, runId?: string): boolean {
  return parkAgentWorkspace(agentId, conversationId, runId);
}

export function activateAgentWorkspace(agentId: string, conversationId: string | null, runId?: string): boolean {
  const key = stagedAgentKey(agentId, runId);
  if (!key) return false;
  const held = workspaceForChat(conversationId);
  if (!held) { deleteWorkspaceFor(key); return false; }
  setWorkspaceFor(key, { virtual: held.virtual, real: held.real });
  return true;
}
