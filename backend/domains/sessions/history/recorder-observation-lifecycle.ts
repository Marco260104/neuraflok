import { appendEvent, readRecentEvents } from './store.js';
import type { ChatObservation, LiveConversation, ObservationActivity } from './recorder-observations.js';

type ObservationEventBase = {
  time: number;
  source: 'extension';
  authoredAt?: number;
  turnId?: string;
  agent?: string;
};

export async function recordObservationTurnStart(
  sessionId: string,
  item: ChatObservation,
  live: LiveConversation | undefined,
  base: ObservationEventBase,
  activity: ObservationActivity
): Promise<boolean> {
  if (!item.turnId) return false;
  if (live?.knownTurnStarts.has(item.turnId) || live?.knownTurnEnds.has(item.turnId)) return false;
  await appendEvent(sessionId, { ...base, kind: 'turn_start' });
  if (live) {
    live.knownTurnStarts.add(item.turnId);
    live.turnStartedAt = item.time;
    live.turnId = item.turnId;
    live.openTurns.add(item.turnId);
    live.turnRequestIds = new Set<string>();
    live.endedTurn = null;
  }
  activity.startedAt = Math.max(activity.startedAt ?? 0, item.time);
  activity.meaningful = true;
  activity.at = Math.max(activity.at ?? 0, item.time);
  activity.working = true;
  return true;
}

export async function recordObservationTurnEnd(
  sessionId: string,
  item: ChatObservation,
  live: LiveConversation | undefined,
  base: ObservationEventBase,
  activity: ObservationActivity
): Promise<boolean> {
  if (!item.turnId) return false;
  const stopOverride = live?.knownTurnEnds.has(item.turnId) && item.outcome === 'stopped';
  if (live?.knownTurnEnds.has(item.turnId)) {
    if (!stopOverride || (live.turnId && live.turnId !== item.turnId)) return false;
    const [latest] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end', 'user_message'] });
    if (latest?.kind !== 'turn_end' || latest.turnId !== item.turnId ||
        latest.outcome === 'stopped' || item.time < latest.time) return false;
  }
  if (live?.turnId === item.turnId) {
    const [latest] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] });
    if (latest?.kind === 'turn_start' && latest.source === 'app' && latest.turnId === item.turnId &&
        latest.time >= item.time) return false;
  }
  await appendEvent(sessionId, {
    ...base,
    kind: 'turn_end',
    outcome: item.outcome ?? 'unknown',
    ...(item.outcome === 'completed' && item.providerMessageId ? { providerMessageId: item.providerMessageId } : {}),
    ...(item.outcome === 'failed' && item.reason === 'thinking_failed' ? { reason: item.reason } : {}),
    ...(item.detail ? { detail: item.detail } : {})
  });
  if (live) {
    const endedStartedAt = live.turnId === item.turnId ? live.turnStartedAt : null;
    if (live.turnId === item.turnId || stopOverride) activity.endedTurnId = item.turnId;
    live.knownTurnEnds.add(item.turnId);
    live.openTurns.delete(item.turnId);
    live.lastTurnOutcome = item.outcome ?? 'unknown';
    live.lastTurnStartedAt = endedStartedAt;
    live.endedTurn = live.turnId === item.turnId
      ? { turnId: item.turnId, startedAt: endedStartedAt, endedAt: item.time, requestIds: live.turnRequestIds }
      : null;
    live.turnRequestIds = new Set<string>();
    if (live.turnId === item.turnId) {
      live.turnStartedAt = null;
      live.turnId = null;
    }
  }
  if (item.outcome !== 'unknown') {
    activity.meaningful = true;
    activity.at = Math.max(activity.at ?? 0, item.time);
    activity.terminal = true;
  }
  return true;
}
