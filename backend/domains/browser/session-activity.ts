import { isProModel } from '../../../contracts/model-capabilities.js';
import { isApiConversationId } from '../../../contracts/chat-protocol.js';
import { CHAT_ACTIVE_MS, type SessionSummary } from '../../../contracts/session.js';
import { providerForConversationId } from '../../../contracts/web-providers.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { apiChatFlightTurnId } from '../providers/api-chat.js';
import { webProviderAuthoredFlightTurnId } from '../providers/browser-chat.js';
import { runningToolProgress } from '../../infrastructure/tool-gateway/protocol/call-context.js';

export interface ActivityGrant {
  sessionId: string;
  evidenceAt: number;
  until: number;
  turnId: string | null;
  model: 'pro' | 'other' | 'unknown';
  thinkingFailed?: true;
  mcpBacked?: true;
  deliberate?: true;
}

export const activeUntil = new Map<string, ActivityGrant>();
export const PRO_ACTIVITY_MS = 10 * 60_000;

export function activityDeadline(grant: Pick<ActivityGrant, 'model' | 'evidenceAt'>): number {
  return grant.evidenceAt + (grant.model === 'pro' ? PRO_ACTIVITY_MS : CHAT_ACTIVE_MS);
}

export function sessionActivityExpiresAt(summary: SessionSummary): number | null | undefined {
  const id = summary.conversationId;
  if (id && isChatBlocked(id)) return null;
  const flightTurn = webProviderAuthoredFlightTurnId(summary.id) ?? apiChatFlightTurnId(summary.id);
  if (flightTurn) return Date.now() + 600_000;
  if (id && (providerForConversationId(id) || isApiConversationId(id))) return null;
  const grant = id ? activeUntil.get(id) : undefined;
  if (id && (summary.activeTurnId || (grant?.sessionId === summary.id && grant.mcpBacked)) && runningToolProgress(id)) {
    const pro = grant?.sessionId === summary.id ? grant.model === 'pro' :
      summary.selectedModel?.conversationId === id && isProModel(summary.selectedModel.model, summary.selectedModel.reasoningEffort);
    return Date.now() + (pro ? PRO_ACTIVITY_MS : CHAT_ACTIVE_MS);
  }
  if (!grant || grant.sessionId !== summary.id || grant.thinkingFailed) return null;
  return activityDeadline(grant);
}
