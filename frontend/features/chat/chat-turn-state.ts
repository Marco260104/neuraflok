import type { SessionEvent, SessionSummary } from '../../../contracts/session.js';

const RECENT_TURN_ACTIVITY_MS = 10_000;
let currentChatSelection: { sessionId: string | null; generation: number; at: number } | null = null;

/** Records the instant navigation committed to a selection, before its history read begins. */
export function recordChatSelection(sessionId: string | null, generation: number, at = Date.now()): void {
  currentChatSelection = { sessionId, generation, at };
}

/** Returns null for the app's initial selection, where no navigation race exists. */
export function chatSelectionStartedAt(sessionId: string | null, generation: number): number | null {
  return currentChatSelection?.sessionId === sessionId && currentChatSelection.generation === generation
    ? currentChatSelection.at
    : null;
}

function isFinalAssistantMessage(event: SessionEvent): boolean {
  return event.kind === 'assistant_message' && (event.final === true || event.state === 'final');
}

/** True when the latest authored question (or an internal turn with no question) has a recorded terminal event after it. */
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
  return latestTerminal > latestUser;
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

/** A restored activeTurnId may replay a recent start without any provider work. */
export function hasRecentTurnActivity(
  events: readonly SessionEvent[],
  turnId: string | null | undefined,
  selectedAt: number | null,
  now = Date.now(),
): boolean {
  if (!turnId) return false;
  const recent = (event: SessionEvent): boolean => now - event.time >= -1_000 &&
    now - event.time < RECENT_TURN_ACTIVITY_MS;
  const actualActivity = events.some(event => {
    if (event.turnId !== turnId || !recent(event)) return false;
    if (event.kind === 'assistant_message') return event.final !== true && event.state !== 'final';
    return ['tool_call', 'page_tool', 'progress'].includes(event.kind);
  });
  if (actualActivity) return true;

  // A current turn can start immediately after the user submits a new message.
  // On chat restoration, however, a recent/replayed turn_start without fresh
  // output is not evidence that the provider is still working.
  const started = events.some(event => event.kind === 'turn_start' && event.turnId === turnId && recent(event) &&
    (selectedAt === null || (event.time >= selectedAt && events.some(question =>
      question.kind === 'user_message' && question.time >= selectedAt && recent(question)))));
  return started;
}
