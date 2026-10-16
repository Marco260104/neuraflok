import { recordedRequestTurn, responseTurnId } from '../../../../contracts/chronology.js';
import type { LiveConversation } from './recorder-observations.js';
import { appendEvent, getSession, readCompletedFinal, readRecentEvents } from './store.js';
import { logInfo } from '../../../infrastructure/settings/logger.js';

export function createRecorderTurnRecovery(conversations: Map<string, LiveConversation>) {
  async function reopenThinkingFailure(sessionId: string, live: LiveConversation | undefined, at: number,
    owner?: string): Promise<string | null> {
    if (!live || live.turnId) return null;
    const [boundary] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end', 'user_message'] });
    if (live.turnId || boundary?.kind !== 'turn_end' || boundary.reason !== 'thinking_failed' ||
        !boundary.turnId || (owner && boundary.turnId !== owner) || at <= boundary.time) return null;
    await appendEvent(sessionId, { source: 'app', time: at, kind: 'turn_start', turnId: boundary.turnId,
      detail: 'fresh work resumed the same turn after its native view failed' });
    live.knownTurnEnds.delete(boundary.turnId);
    live.openTurns.add(boundary.turnId);
    live.turnId = boundary.turnId;
    live.turnStartedAt = live.lastTurnStartedAt ?? at;
    live.lastTurnOutcome = null;
    live.endedTurn = null;
    return boundary.turnId;
  }

  async function reopenFalselyEndedTurn(
    sessionId: string,
    conversationId: string | null,
    requestId: string | null,
    startedAt: number,
    agent: string | null,
    callTurnId: string | null
  ): Promise<string | null> {
    if (!conversationId || !requestId) return null;
    const live = conversations.get(conversationId);
    if (!live || live.sessionId !== sessionId) return null;
    const failed = await reopenThinkingFailure(sessionId, live, startedAt, callTurnId ?? undefined);
    if (failed) {
      live.turnRequestIds.add(requestId);
      return failed;
    }
    if (live.turnStartedAt !== null) {
      if (callTurnId === live.turnId) live.turnRequestIds.add(requestId);
      return null;
    }
    const previousEnd = live.endedTurn;
    let ended = previousEnd;
    const current = (): boolean => conversations.get(conversationId) === live &&
      live.endedTurn === previousEnd && live.turnStartedAt === null;
    if (!ended) {
      const [boundary] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end', 'user_message'] });
      const summary = await getSession(sessionId);
      const owner = recordedRequestTurn(summary?.requestTurns, requestId, conversationId);
      if (!current() || summary?.conversationId !== conversationId || boundary?.kind !== 'turn_end' ||
          !boundary.turnId || !owner || owner.origin >= boundary.seq ||
          responseTurnId(summary.timelineTurns, owner.turnId) !== responseTurnId(summary.timelineTurns, boundary.turnId)) return null;
      ended = { turnId: boundary.turnId, startedAt: live.lastTurnStartedAt,
        endedAt: boundary.time, requestIds: new Set([requestId]) };
    }
    if (!ended || !ended.requestIds.has(requestId) || startedAt <= ended.endedAt) return null;
    if (await readCompletedFinal(sessionId, conversationId, ended.turnId) || !current()) return null;
    await appendEvent(sessionId, {
      time: startedAt,
      source: 'app',
      kind: 'turn_start',
      turnId: ended.turnId,
      detail: 'the same provider request kept calling tools after the page reported this turn ended',
      ...(agent ? { agent } : {})
    });
    live.endedTurn = null;
    live.knownTurnEnds.delete(ended.turnId);
    live.openTurns.add(ended.turnId);
    live.turnId = ended.turnId;
    live.turnStartedAt = ended.startedAt ?? startedAt;
    live.lastTurnOutcome = null;
    live.turnRequestIds = new Set(ended.requestIds);
    logInfo(
      `session ${sessionId} reopened turn ${ended.turnId} — request ${requestId} kept calling tools after the page reported it ended`
    );
    return ended.turnId;
  }

  return { reopenThinkingFailure, reopenFalselyEndedTurn };
}
