import { getConfig } from '../../../infrastructure/settings/config.js';
import { workerPrimeOwner } from '../../automation/agents.js';
import { committedResumeAncestorsFromSummary } from '../../../../contracts/session.js';
import { BLOCKED_CHAT_REFUSAL, isChatBlocked } from './blocked-chats.js';
import { findSessionByConversation } from '../history/store.js';
import { isChatTrusted } from './trusted-chats.js';

export const STRICT_CHAT_REFUSAL =
  'CHAT_NOT_TRUSTED: this conversation is outside the approved access list. No tool was run. ' +
  'To allow an existing chat, choose Trust from its row in the sidebar chat list; if blocked, choose Release there. ' +
  'Authorize app-created workers through their owning prime chat. Calls without a verified conversation are refused while strict access is enabled. Retry after the user updates that setting.';

export function strictChatAllowlistEnabled(): boolean {
  return getConfig().multiAgent.strictChatAllowlist === true;
}

async function hasTrustedHistory(conversationId: string): Promise<boolean> {
  if (isChatBlocked(conversationId)) return false;
  const summary = await findSessionByConversation(conversationId, { requireUnique: true });
  if (isChatBlocked(conversationId)) return false;
  if (summary?.conversationId === conversationId && summary.origin?.kind === 'worker') return false;
  if (isChatTrusted(conversationId)) return true;

  const ancestors = summary?.conversationId === conversationId
    ? committedResumeAncestorsFromSummary(summary, conversationId)
    : [];
  for (const ancestorId of ancestors) {
    if (isChatBlocked(ancestorId)) return false;
    if (isChatTrusted(ancestorId)) return true;
  }
  return false;
}

async function isAccessApproved(conversationId: string): Promise<boolean> {
  const owner = workerPrimeOwner(conversationId);
  if (!owner.owned) return hasTrustedHistory(conversationId);
  const primeConversationId = owner.primeConversationId;
  if (!primeConversationId) return false;

  const approved = await hasTrustedHistory(primeConversationId);
  const latestOwner = workerPrimeOwner(conversationId);
  return approved && latestOwner.owned && latestOwner.primeConversationId === primeConversationId;
}

export async function conversationAccessRefusal(conversationId: string | null | undefined): Promise<string | null> {
  if (isChatBlocked(conversationId)) return BLOCKED_CHAT_REFUSAL;
  if (!strictChatAllowlistEnabled()) return null;
  if (!conversationId) return STRICT_CHAT_REFUSAL;
  return await isAccessApproved(conversationId) ? null : STRICT_CHAT_REFUSAL;
}
