import { agentInfoForOwnedConversation, closableWorkerConversations, swarmState } from '../automation/agents.js';
import { isGoalDecisionChat } from '../automation/goal.js';
import { activeUntil } from './session-activity.js';
import { isChatBlocked, chatBlockedAt } from '../sessions/continuity/blocked-chats.js';
import { pendingContinuations, supersededSourceConversations } from '../sessions/continuity/continuation.js';
import { getSession, listUsageSessions } from '../sessions/history/store.js';
import { listInputs } from '../sessions/input/input.js';
import { runningToolCalls } from '../../infrastructure/tool-gateway/protocol/call-context.js';

// Selects app-owned pages that can be reused or closed without losing live work.
export async function buildBrowserTabPolicy(
  openConversations: Set<string>,
  goalActiveFor: (conversationId: string) => boolean
) {
  const summaries = await listUsageSessions();
  const managed = new Set(summaries.filter(row => row.origin && row.origin.kind !== 'resume' && row.conversationId &&
    openConversations.has(row.conversationId)).map(row => row.conversationId!));
  for (const id of [...supersededSourceConversations(), ...closableWorkerConversations(0)])
    if (openConversations.has(id)) managed.add(id);
  for (const agent of swarmState().agents)
    if (agent.conversationId && openConversations.has(agent.conversationId)) managed.add(agent.conversationId);
  const protectedChats = new Set(swarmState().agents
    .filter(agent => Boolean(agent.conversationId) && agent.state === 'waking')
    .map(agent => agent.conversationId as string));
  for (const entry of pendingContinuations()) protectedChats.add(entry.from);
  for (const [id, grant] of activeUntil) if (grant.until > Date.now()) protectedChats.add(id);
  const inputs = await listInputs();
  const cancelledDecisionClaims = inputs.filter(row => row.purpose === 'decision' && !row.lifetime &&
    row.state === 'cancelled' && row.owner && row.conversationId && openConversations.has(row.conversationId) &&
    isGoalDecisionChat(row.conversationId) && (!row.decisionSourceSessionId ||
      summaries.some(source => source.id === row.decisionSourceSessionId && source.conversationId !== row.conversationId)));
  for (const row of cancelledDecisionClaims) managed.add(row.conversationId!);
  for (const row of inputs) if (!row.sessionId && row.purpose !== 'decision' && row.deliveredAt !== undefined &&
    row.conversationId && openConversations.has(row.conversationId)) managed.add(row.conversationId);
  for (const id of managed) if (runningToolCalls(id) > 0 || goalActiveFor(id)) protectedChats.add(id);
  for (const row of inputs) {
    if (!['queued', 'browser', 'decision'].includes(row.state)) continue;
    const target = row.state === 'queued' && row.sessionId && row.purpose !== 'decision'
      ? (await getSession(row.sessionId))?.conversationId : row.conversationId;
    if (target) protectedChats.add(target);
  }
  const lastActivity = new Map<string, number>();
  const note = (id: string | null | undefined, at: number | null | undefined) => {
    if (id && typeof at === 'number' && Number.isFinite(at) && at > 0)
      lastActivity.set(id, Math.max(lastActivity.get(id) ?? 0, at));
  };
  for (const row of summaries) {
    note(row.conversationId, row.startedAt);
    note(row.conversationId, row.lastToolCallAt);
    note(row.conversationId, row.lastTurnEndAt);
    note(row.conversationId, row.lastAssistantFinalAt);
  }
  for (const id of managed) {
    const agent = agentInfoForOwnedConversation(id);
    if (!agent) continue;
    note(agent.conversationId, agent.createdAt);
    note(agent.conversationId, agent.activatedAt);
    note(agent.conversationId, agent.finishedAt);
    note(agent.conversationId, agent.sleptAt);
  }
  for (const row of inputs) note(row.conversationId, row.deliveredAt);
  for (const row of cancelledDecisionClaims)
    note(row.conversationId, row.sendAuthorizedAt ?? row.offeredAt ?? row.createdAt);
  const blocked = [...managed].filter(isChatBlocked);
  for (const id of blocked) {
    protectedChats.delete(id);
    const at = chatBlockedAt(id);
    if (at !== null) lastActivity.set(id, at);
  }
  const terminal = new Set([...blocked, ...cancelledDecisionClaims.map(row => row.conversationId!)]);
  const latestDesktopReceipt = new Map<string, (typeof inputs)[number]>();
  for (const row of inputs) {
    if (row.purpose === 'decision' || !row.conversationId || row.deliveredAt === undefined) continue;
    const previous = latestDesktopReceipt.get(row.conversationId);
    if (!previous || row.deliveredAt >= previous.deliveredAt!) latestDesktopReceipt.set(row.conversationId, row);
  }
  for (const [id, row] of latestDesktopReceipt)
    if ((row.opening || !row.sessionId) && row.state === 'cancelled' && managed.has(id)) terminal.add(id);
  for (const id of managed) {
    const agent = agentInfoForOwnedConversation(id);
    if (agent?.role === 'worker' && !agent.revivable && (agent.state === 'finished' || agent.state === 'failed')) terminal.add(id);
  }
  const idle = [...terminal].filter(id => !protectedChats.has(id) && lastActivity.has(id) && Date.now() - lastActivity.get(id)! >= 120_000);
  const summariesByChat = new Map(summaries.map(row => [row.conversationId, row]));
  const available = [...managed].filter(id => {
    if (protectedChats.has(id) || terminal.has(id) || isChatBlocked(id) || !lastActivity.has(id)) return false;
    const agent = agentInfoForOwnedConversation(id);
    if (agent?.role === 'worker') return agent.state === 'sleeping' && agent.revivable;
    const row = summariesByChat.get(id);
    return row?.activeTurnId === null && Math.max(row.lastTurnEndAt ?? 0, row.lastAssistantFinalAt ?? 0) > 0;
  });
  const quietFor = (id: string, ms: number) => Date.now() - lastActivity.get(id)! >= ms;
  const idlePages = available.filter(id => quietFor(id, 300_000));
  return {
    idleReuseAfterMs: 120_000,
    idleCloseAfterMs: 300_000,
    cancelledDecisionClaims: cancelledDecisionClaims.map(row => ({ id: row.id, owner: row.owner, conversationId: row.conversationId })),
    retiredConversations: [...new Set([...idle, ...supersededSourceConversations()])]
      .filter(id => openConversations.has(id) && !protectedChats.has(id)).sort(),
    conversationActivityAt: Object.fromEntries(lastActivity),
    managedConversations: [...managed].sort(),
    reusableConversations: available.filter(id => quietFor(id, 120_000) && !isGoalDecisionChat(id) &&
      !supersededSourceConversations().includes(id)).sort(),
    nonDiscardableConversations: [...protectedChats].sort(),
    blockedConversations: blocked.sort(),
    closableConversations: [...new Set([...idlePages, ...idle,
      ...supersededSourceConversations().filter(id => openConversations.has(id) && !protectedChats.has(id))])].sort()
  };
}
