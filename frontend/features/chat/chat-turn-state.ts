import type { SessionEvent, SessionSummary } from '../../../contracts/session.js';

function isFinalAssistantMessage(event: SessionEvent): boolean {
  return event.kind === 'assistant_message' && (event.final === true || event.state === 'final');
}

/** True when the latest authored question has a recorded terminal event after it. */
export function transcriptShowsCompletedLatestTurn(events: readonly SessionEvent[]): boolean {
  let latestUser = -1;
  let latestTerminal = -1;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === 'user_message') latestUser = index;
    else if ((event.kind === 'turn_end' && event.outcome !== 'unknown') ||
      isFinalAssistantMessage(event) || event.kind === 'chat_error') {
      latestTerminal = index;
    }
  }
  return latestUser >= 0 && latestTerminal > latestUser;
}

/**
 * A bounded history page can omit an old turn's terminal event even though the
 * durable session summary already records it. Do not treat a lagging provider
 * activeTurnId as live work when that completion is newer than the latest
 * authored question currently visible in the transcript.
 */
export function transcriptOrSummaryShowsCompletedLatestTurn(
  events: readonly SessionEvent[],
  summary: Pick<SessionSummary, 'lastAssistantFinalAt' | 'lastTurnEndAt'> | null | undefined,
): boolean {
  if (transcriptShowsCompletedLatestTurn(events)) return true;
  let latestUserAt = Number.NEGATIVE_INFINITY;
  for (const event of events)
    if (event.kind === 'user_message') latestUserAt = Math.max(latestUserAt, event.time);
  if (latestUserAt === Number.NEGATIVE_INFINITY) return false;
  const latestCompletion = Math.max(summary?.lastAssistantFinalAt ?? Number.NEGATIVE_INFINITY,
    summary?.lastTurnEndAt ?? Number.NEGATIVE_INFINITY);
  return latestCompletion > latestUserAt;
}

/** True only when the latest authored question has a closed turn boundary. */
export function transcriptShowsClosedLatestTurn(events: readonly SessionEvent[]): boolean {
  let latestUser = -1;
  let latestTurnEnd = -1;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.kind === 'user_message') latestUser = index;
    else if (event.kind === 'turn_end' && event.outcome !== 'unknown') latestTurnEnd = index;
  }
  return latestUser >= 0 && latestTurnEnd > latestUser;
}
