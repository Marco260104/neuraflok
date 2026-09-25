import { activeUntil } from './session-activity.js';
import { liveConversations } from '../sessions/history/recorder.js';

const OPEN_TURN_RECOVERY_MS = 60 * 60_000;

// Live page generation is not durable state; recent exact tool activity remains a separate session-scoped work signal.
export function chatIsWorking(conversationId: string): boolean {
  const current = liveConversations().find(entry => entry.conversationId === conversationId);
  return Boolean(current && (current.generating || current.activeTurnId));
}

// Whether a chat is working now, for decisions that act on it: reopening its tab, filing an automatic compaction. A bare open turn counts only for one hour after its start; one left open by a page that went away is history, and briefly visiting that chat must not reopen its tab or compact it. Activity in the silence window counts however old the turn is.
export function liveTurnIsCurrent(conversationId: string, now = Date.now()): boolean {
  return liveConversations().some(entry => entry.conversationId === conversationId &&
    (entry.generating || Boolean(entry.activeTurnId)) &&
    (entry.activeTurnStartedAt === null || now - entry.activeTurnStartedAt < OPEN_TURN_RECOVERY_MS));
}

// A current live turn or recent activity makes a closed tab worth reopening.
export function chatIsWorkingNow(conversationId: string, now = Date.now()): boolean {
  return liveTurnIsCurrent(conversationId, now) || (activeUntil.get(conversationId)?.until ?? 0) > now;
}
