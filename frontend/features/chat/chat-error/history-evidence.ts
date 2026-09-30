import type { SessionEvent } from '../../../../contracts/session.js';
import { positionOf } from '../../../../contracts/chronology.js';
import { chatErrorMessageKey } from '../../../../contracts/chat-error.js';

type ChatError = Extract<SessionEvent, { kind: 'chat_error' }>;
type ProgressEvent = Extract<SessionEvent, { kind: 'progress' }>;

export interface ChatErrorEvidence {
  questionPosition: number;
  previousErrorReload: boolean;
  repair?: ProgressEvent;
  continuedPosition: number;
  completedPosition: number;
}

function chronological(history: readonly SessionEvent[]): SessionEvent[] {
  return [...history].sort((left, right) => positionOf(left) - positionOf(right));
}

function isRepair(event: SessionEvent): event is ProgressEvent {
  return event.kind === 'progress' && event.source === 'app' && event.progressId?.startsWith('browser-repair:') === true;
}

function matchesErrorTurn(error: ChatError, event: SessionEvent): boolean {
  return !!error.turnId && event.turnId === error.turnId;
}

export function duplicateChatErrors(history: readonly SessionEvent[]): Set<number> {
  const duplicates = new Set<number>();
  const seen = new Set<string>();
  let hasQuestion = false;

  for (const event of chronological(history)) {
    if (event.kind === 'user_message') {
      hasQuestion = true;
      seen.clear();
      continue;
    }
    if (event.kind !== 'chat_error' || event.recoverable !== true || !hasQuestion) continue;

    const identity = chatErrorMessageKey(event.message.text, true);
    if (seen.has(identity)) duplicates.add(event.seq);
    else seen.add(identity);
  }

  return duplicates;
}

export function collectChatErrorEvidence(
  error: ChatError,
  history: readonly SessionEvent[],
  duplicates: ReadonlySet<number>
): ChatErrorEvidence {
  const events = chronological(history);
  let questionPosition = 0;
  let previousErrorReload = false;

  for (const event of events) {
    const position = positionOf(event);
    if (event.kind === 'user_message' && position < error.seq) questionPosition = Math.max(questionPosition, position);
  }

  if (questionPosition > 0 && error.recoverable === true) {
    previousErrorReload = events.some(event => isRepair(event) &&
      positionOf(event) > questionPosition && event.seq < error.seq &&
      /^(?:Reloaded|Reopened) chat to recover an interrupted response\.$/.test(event.message.text));
  }

  let repair: ProgressEvent | undefined;
  let continuedPosition = 0;
  let completedPosition = 0;

  for (const event of events) {
    const position = positionOf(event);
    const eventPosition = event.kind === 'assistant_message' ? event.seq : position;
    if (eventPosition <= error.seq || duplicates.has(event.seq)) continue;
    if (event.kind === 'user_message' || event.kind === 'chat_error') break;
    if (questionPosition === 0 && event.kind === 'turn_start' && event.turnId !== error.turnId) break;

    if (event.kind === 'turn_end' && matchesErrorTurn(error, event) && event.outcome === 'completed') {
      completedPosition = Math.max(completedPosition, event.seq);
    }
    if (event.kind === 'assistant_message' && questionPosition > 0 && position > questionPosition && event.final === true) {
      const finalPosition = event.finalContentSeq ?? event.seq;
      if (finalPosition > error.seq) completedPosition = Math.max(completedPosition, finalPosition);
    }
    if ((questionPosition > 0 || matchesErrorTurn(error, event)) && event.time > error.time &&
        (event.kind === 'tool_call' || (event.kind === 'turn_start' && event.source === 'app'))) {
      continuedPosition = Math.max(continuedPosition, position);
    }
    if (isRepair(event) && (questionPosition > 0 || !event.turnId || matchesErrorTurn(error, event))) repair = event;
  }

  return { questionPosition, previousErrorReload, repair, continuedPosition, completedPosition };
}
