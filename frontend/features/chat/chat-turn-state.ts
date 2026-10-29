import type { SessionEvent, SessionSummary } from '../../../contracts/session.js';

const RECENT_TURN_ACTIVITY_MS = 10_000;
let currentChatSelection: { sessionId: string | null; generation: number; at: number } | null = null;

/** Provider bootstrap prompts can be replayed without their outbox metadata. */
export function isInternalWarmupQuestionText(text: string | null | undefined, internalWarmupText?: string): boolean {
  const value = String(text ?? '').trim();
  return (!!internalWarmupText && value === internalWarmupText) ||
    /^(?:NEURAFLOK_WARMUP|NEURAFLOK_READY|NEURAL_JAM_READY)$/i.test(value) ||
    /^NEURAFLOK_CONTEXT_CHECK\b/i.test(value) ||
    /^Initialize this NEURAFLOK conversation using the instructions below\. This is configuration only, not a user task\./i.test(value);
}

export interface InternalWarmupTurnBoundary {
  firstWarmupSeq: number;
  authoredQuestionSeq: number | null;
}

/**
 * Finds the hidden preparation prefix of each provider turn. Providers can put
 * an internal handshake and the user's first question in the same turn, so a
 * warmup marker must not hide later authored work from the UI.
 */
export function internalWarmupTurnBoundaries(
  events: readonly SessionEvent[],
  internalInputIds: ReadonlySet<string> = new Set(),
  internalWarmupText?: string,
): ReadonlyMap<string, InternalWarmupTurnBoundary> {
  const ordered = events.map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.seq - right.event.seq || left.index - right.index);
  const isWarmup = (event: SessionEvent): boolean => {
    const inputId = 'inputId' in event ? event.inputId : undefined;
    return event.internalWarmup === true || (!!inputId && internalInputIds.has(inputId)) ||
      (event.kind === 'user_message' && isInternalWarmupQuestionText(event.message.text, internalWarmupText));
  };
  const boundaries = new Map<string, InternalWarmupTurnBoundary>();
  for (const { event } of ordered) {
    if (!event.turnId) continue;
    if (!isWarmup(event)) continue;
    const existing = boundaries.get(event.turnId);
    if (!existing || event.seq < existing.firstWarmupSeq) {
      boundaries.set(event.turnId, { firstWarmupSeq: event.seq, authoredQuestionSeq: null });
    }
  }
  // Some provider transcripts omit turnId on the bootstrap user row. Tie it
  // to the nearest turn start without crossing another authored question.
  for (const marker of ordered.filter(({ event }) => !event.turnId && isWarmup(event))) {
    const nearbyStart = ordered
      .filter(({ event }) => event.kind === 'turn_start' && !!event.turnId)
      .filter(start => !ordered.some(candidate => candidate.event.kind === 'user_message' &&
        candidate.index !== marker.index && candidate.event.seq > Math.min(marker.event.seq, start.event.seq) &&
        candidate.event.seq < Math.max(marker.event.seq, start.event.seq) && !isWarmup(candidate.event)))
      .sort((left, right) => Math.abs(left.event.seq - marker.event.seq) - Math.abs(right.event.seq - marker.event.seq))[0];
    if (!nearbyStart?.event.turnId) continue;
    const existing = boundaries.get(nearbyStart.event.turnId);
    if (!existing) boundaries.set(nearbyStart.event.turnId, {
      firstWarmupSeq: marker.event.seq,
      authoredQuestionSeq: null,
    });
    else existing.firstWarmupSeq = Math.min(existing.firstWarmupSeq, marker.event.seq);
  }
  for (const { event } of ordered) {
    if (event.kind !== 'turn_start' || !event.turnId) continue;
    const boundary = boundaries.get(event.turnId);
    if (boundary && event.seq <= boundary.firstWarmupSeq) boundary.firstWarmupSeq = event.seq;
  }
  for (const { event } of ordered) {
    if (!event.turnId || event.kind !== 'user_message' || event.internalWarmup === true ||
        isInternalWarmupQuestionText(event.message.text, internalWarmupText)) continue;
    const inputId = event.inputId;
    if (inputId && internalInputIds.has(inputId)) continue;
    const boundary = boundaries.get(event.turnId);
    if (boundary && event.seq > boundary.firstWarmupSeq &&
        (boundary.authoredQuestionSeq === null || event.seq < boundary.authoredQuestionSeq)) {
      boundary.authoredQuestionSeq = event.seq;
    }
  }
  // The matching authored message may also lack turnId. Attribute it to the
  // warmup turn only when it follows that preparation before the turn closes.
  for (const { event } of ordered) {
    if (event.turnId || event.kind !== 'user_message' || isWarmup(event)) continue;
    const match = [...boundaries.entries()]
      .filter(([turnId, boundary]) => event.seq > boundary.firstWarmupSeq &&
        !ordered.some(candidate => candidate.event.turnId === turnId && candidate.event.seq > boundary.firstWarmupSeq &&
          candidate.event.seq < event.seq && candidate.event.kind === 'turn_end'))
      .sort((left, right) => right[1].firstWarmupSeq - left[1].firstWarmupSeq)[0];
    if (match && (match[1].authoredQuestionSeq === null || event.seq < match[1].authoredQuestionSeq))
      match[1].authoredQuestionSeq = event.seq;
  }
  return boundaries;
}

/** Identifies whole turns that contain only provider bootstrap activity. */
export function internalWarmupTurnIds(
  events: readonly SessionEvent[],
  internalInputIds: ReadonlySet<string> = new Set(),
  internalWarmupText?: string,
): ReadonlySet<string> {
  return new Set([...internalWarmupTurnBoundaries(events, internalInputIds, internalWarmupText)]
    .flatMap(([turnId, boundary]) => boundary.authoredQuestionSeq === null ? [turnId] : []));
}

/** True while a known internal warmup turn is open, even if later events omit its marker. */
export function isInternalWarmupTurnOpen(
  events: readonly SessionEvent[],
  turnId: string,
  latestSummaryTerminalAt = Number.NEGATIVE_INFINITY,
): boolean {
  let latestStart = Number.NEGATIVE_INFINITY;
  let latestTerminal = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.turnId !== turnId) continue;
    if (event.kind === 'turn_start') latestStart = Math.max(latestStart, event.time);
    else if ((event.kind === 'turn_end' && event.outcome !== 'unknown') || event.kind === 'chat_error' ||
      (event.kind === 'assistant_message' && (event.final === true || event.state === 'final'))) {
      latestTerminal = Math.max(latestTerminal, event.time);
    }
  }
  return Number.isFinite(latestStart) && latestTerminal < latestStart && latestSummaryTerminalAt < latestStart;
}

/** Records the instant navigation committed to a selection, before its history read begins. */
export function recordChatSelection(sessionId: string | null, generation: number, at = Date.now()): void {
  currentChatSelection = { sessionId, generation, at };
}

/** Returns the timestamp only for the matching chat and navigation generation. */
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
  internalInputIds: ReadonlySet<string> = new Set(),
  internalWarmupText?: string,
): boolean {
  if (!turnId) return false;
  const internalWarmupTurns = internalWarmupTurnIds(events, internalInputIds, internalWarmupText);
  if (internalWarmupTurns.has(turnId)) return false;
  let latestQuestion: Extract<SessionEvent, { kind: 'user_message' }> | undefined;
  let latestUserAt = Number.NEGATIVE_INFINITY;
  for (const event of events)
    if (event.kind === 'user_message' && !internalWarmupTurns.has(event.turnId ?? '') &&
        !isInternalWarmupQuestionText(event.message.text, internalWarmupText) &&
        !(event.inputId && internalInputIds.has(event.inputId))) {
      latestQuestion = event;
      latestUserAt = Math.max(latestUserAt, event.time);
    }
  const latestQuestionIsCurrent = latestQuestion &&
    (latestQuestion.turnId === turnId || latestQuestion.time >= (selectedAt ?? now - RECENT_TURN_ACTIVITY_MS));
  const latestQuestionHasCompleted = latestQuestion && events.some(event => event.time > latestQuestion!.time &&
    ((event.kind === 'turn_end' && event.outcome !== 'unknown') ||
      (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) ||
      event.kind === 'chat_error') &&
    (!latestQuestion!.turnId || !event.turnId || event.turnId === latestQuestion!.turnId));
  if (latestQuestionHasCompleted && !latestQuestionIsCurrent) return false;
  // A provider turn started by the hidden chat handshake is not the user's
  // turn. The provider can briefly keep it active after acknowledging setup;
  // exposing Stop in that gap lets navigation cancel internal preparation.
  if (latestQuestion?.kind === 'user_message' && latestQuestion.inputId &&
      internalInputIds.has(latestQuestion.inputId)) return false;
  // Provider-observed warmup messages do not always carry the app outbox id,
  // so also recognize the exact internal handshake text while it settles.
  if (latestQuestion?.kind === 'user_message' && internalWarmupText &&
      latestQuestion.message.text.trim() === internalWarmupText) return false;
  const recent = (event: SessionEvent): boolean => now - event.time >= -1_000 &&
    now - event.time < RECENT_TURN_ACTIVITY_MS;
  const actualActivity = events.some(event => {
    const sameTurn = event.turnId === turnId || (!event.turnId && event.source === 'mcp');
    if (!sameTurn || !recent(event) ||
        (selectedAt !== null && event.time < selectedAt) ||
        (event.turnId !== undefined && internalWarmupTurns.has(event.turnId)) ||
        event.internalWarmup === true ||
        (latestUserAt !== Number.NEGATIVE_INFINITY && event.time < latestUserAt)) return false;
    // A fresh extension observation after reopening can confirm that a
    // recently interrupted provider turn resumed. MCP progress can be replayed
    // from the old transcript, so it still needs a question in this selection.
    if (selectedAt !== null && latestUserAt !== Number.NEGATIVE_INFINITY && latestUserAt < selectedAt &&
        event.source !== 'extension') return false;
    if (event.kind === 'assistant_message') return event.final !== true && event.state !== 'final';
    return ['tool_call', 'page_tool', 'progress'].includes(event.kind);
  });
  if (actualActivity) return true;

  // A turn start restored from an older chat is not evidence that the provider
  // is still working. It must belong to this selection and its latest question.
  const started = events.some(event => event.kind === 'turn_start' && event.turnId === turnId &&
    !internalWarmupTurns.has(event.turnId) &&
    event.internalWarmup !== true && recent(event) &&
    (selectedAt === null || (event.time >= selectedAt &&
      (event.source === 'extension' || (event.time >= latestUserAt && events.some(question =>
        question.kind === 'user_message' && question.internalWarmup !== true &&
        question.time >= selectedAt && question.time >= latestUserAt && recent(question)))))));
  return started;
}
