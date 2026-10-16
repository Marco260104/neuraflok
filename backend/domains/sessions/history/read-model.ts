import { z } from 'zod';
import { primeForOwnedConversation } from '../../automation/agents.js';
import { sessionActivityExpiresAt } from '../../browser/session-activity.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { tokenPressure } from '../../../../contracts/session.js';
import { listInputs } from '../input/input.js';
import { activeSessionId } from './recorder.js';
import { blockedChatIds } from '../continuity/blocked-chats.js';
import { trustedChatIds } from '../continuity/trusted-chats.js';
import { findSessionByConversation, getSession, listSessionPage, readEvents, readRecentEvents } from './store.js';
import type { SessionListCursor } from './store.js';
import type { SessionEventKind, SessionSummary } from '../../../../contracts/session.js';

/** This shared read model enriches sessions for clients; listing can reconcile receipts through the input owner. */

export const sessionListCursorSchema = z.object({
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  id: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i)
});

/** Runtime activity deadlines come from the browser activity owner and are added only at read time. */
function withActivity(summary: SessionSummary): SessionSummary {
  const activityExpiresAt = sessionActivityExpiresAt(summary);
  return activityExpiresAt === undefined ? summary : { ...summary, activityExpiresAt };
}

/** Null when there is no such session. */
export async function readSession(id: string): Promise<SessionSummary | null> {
  const summary = await getSession(id);
  return summary ? withActivity(summary) : null;
}

export async function readSessionList(options: { cursor?: SessionListCursor; limit: number }) {
  const config = getConfig();
  await listInputs(); // Restore exact helper origins before the first sidebar page.
  const page = await listSessionPage({ cursor: options.cursor, limit: options.limit });
  // Older recordings omitted worker origins' parent IDs. The broker's exact retained owner can repair that presentation without reviving a worker or guessing from reusable names such as worker-1.
  const parents = new Map<string, ReturnType<typeof findSessionByConversation>>();
  const sessions = await Promise.all(page.sessions.map(async (summary) => {
    if (summary.origin?.kind !== 'worker' || summary.origin.fromSessionId || !summary.conversationId) return summary;
    const prime = primeForOwnedConversation(summary.conversationId);
    if (!prime || prime === summary.conversationId) return summary;
    if (!parents.has(prime)) parents.set(prime, findSessionByConversation(prime, { requireUnique: true }));
    const parent = await parents.get(prime);
    return parent && parent.id !== summary.id ? { ...summary, origin: { ...summary.origin, fromSessionId: parent.id } } : summary;
  }));
  return {
    sessions: sessions.map(withActivity),
    total: page.total,
    nextCursor: page.nextCursor,
    activeId: activeSessionId(),
    // Live policy, not session history: a block is keyed by provider conversation and does not belong in any session's meta.json. It rides the list for the same reason `activeId` and `pressure` do — one paint, one round trip.
    blocked: blockedChatIds(),
    // Explicit roots only. Renderer projects committed resume lineage from each returned summary; keeping the roots here avoids copying derived trust into a second authority surface.
    trusted: trustedChatIds(),
    pressure: sessions.map((summary) => ({
      id: summary.id,
      // Pressure belongs to the currently attached provider context. `estimatedTokens` is lifetime history and never resets across Compact & Resume.
      ...tokenPressure(summary.contextTokens, config.sessions.advisoryTokens, config.sessions.limitTokens)
    }))
  };
}

/** Null when there is no such session. */
export async function readSessionEvents(
  id: string,
  options: { from?: number; before?: number; after?: number; limit?: number; kinds?: readonly SessionEventKind[] }
) {
  const summary = await getSession(id);
  if (!summary) return null;
  // The renderer draws a timeline, not the whole log: the tail is what matters and the rest stays one click away rather than being pushed over IPC every refresh. The renderer never paints more than 160 rows. Sending nearly twice that on every first load was pure cloning/IPC work; later refreshes use the sequence cursor below.
  const cap = options.limit ?? 160;
  if (options.from === undefined) {
    // Navigation uses immutable origins. `from` alone is a publication cursor for live revisions and must never decide which history page owns a row.
    const events = await readRecentEvents(id, cap, { before: options.before, after: options.after, kinds: options.kinds, orderByOrigin: true });
    const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 0);
    return { summary, events, total: summary.events, nextFrom };
  }
  const events = await readEvents(id, { from: options.from, limit: cap, kinds: options.kinds });
  const nextFrom = events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), options.from);
  return { summary, events, total: summary.events, nextFrom };
}
