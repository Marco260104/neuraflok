import type { SessionEvent } from '../../../contracts/session.js';
import { queuedFollowup } from '../../../contracts/input.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';
import { internalWarmupTurnBoundaries, isInternalWarmupQuestionText } from './chat-turn-state.js';

export type DeferredInputProgress = 'thinking';

/** A sent input older than the selected chat's terminal boundary is historical. */
function completedAuthoredInput(entry: InputEntry, completedThrough: number | null): boolean {
  if (entry.state !== 'sent') return false;
  // Once the history writer assigned a sequence number, this delivery is
  // canonical even when the selected transcript is a bounded page that omits
  // its original user row. Keep it out of optimistic rows and pending UI.
  if (entry.historyAnchored === true) return true;
  if (completedThrough === null) return false;
  const deliveredAt = entry.deliveredAt ?? entry.offeredAt ?? entry.createdAt;
  return Number.isFinite(deliveredAt) && deliveredAt <= completedThrough;
}

/** Match a durable provider transcript even if its delivery receipt lost the local input id. */
function authoredInputHasTerminalResponse(entry: InputEntry, events: readonly SessionEvent[]): boolean {
  const messageId = entry.messageId ?? `input:${entry.id}`;
  const user = events.find(event => event.kind === 'user_message' &&
    (event.inputId === entry.id || event.messageId === messageId)) ??
    [...events].reverse().find(event => event.kind === 'user_message' &&
      event.message.text.trim() === entry.text.trim() &&
      event.time >= (entry.offeredAt ?? entry.deliveredAt ?? entry.createdAt));
  if (!user) return false;
  return events.some(event => event.seq > user.seq &&
    ((event.kind === 'turn_end' && event.outcome !== 'unknown') ||
      (event.kind === 'assistant_message' && (event.final === true || event.state === 'final')) ||
      event.kind === 'chat_error'));
}

export interface PendingNewProjectInput {
  id: string;
  generation: number;
}

/** True only while an authored input owned by the selected chat is still awaiting an answer. */
export function selectedAuthoredInputPending(
  entries: Iterable<InputEntry>,
  selectedId: string | null,
  selectionGeneration: number,
  pendingNewInput: PendingNewProjectInput | null,
  events: readonly SessionEvent[],
  now = Date.now(),
  completedThrough: number | null = null,
): boolean {
  for (const entry of entries) {
    const owner = entry.sessionId ?? entry.deliveredSessionId ?? null;
    const belongsToSelection = selectedId !== null
      ? owner === selectedId
      : pendingNewInput?.generation === selectionGeneration && pendingNewInput.id === entry.id &&
        (owner === null || entry.opening === true);
    if (!belongsToSelection || completedAuthoredInput(entry, completedThrough) || authoredInputHasTerminalResponse(entry, events) ||
        entry.warmup || entry.warmupDeferred || entry.purpose === 'decision' ||
        entry.authoredSource === 'none' || ['failed', 'cancelled', 'decision'].includes(entry.state) ||
        entry.dueAt > now) continue;

    const awaitingScheduledSend = queuedFollowup(entry) &&
      (entry.state === 'queued' || (entry.state === 'browser' && entry.offeredAt === undefined));
    if (awaitingScheduledSend) continue;

    return true;
  }
  return false;
}

/** A warmup-deferred authored message is already visible in the transcript; its delivery row is internal. */
export function isInternallyDeferredAuthoredInput(
  entry: Pick<InputEntry, 'warmup' | 'warmupDeferred' | 'purpose' | 'state'>,
): boolean {
  return entry.warmup !== true && !!entry.warmupDeferred && entry.purpose !== 'decision' &&
    ['queued', 'browser', 'tool'].includes(entry.state);
}

/** Remove internal context warmup rows and their turn activity from the chat transcript. */
export function withoutInternalWarmupEvents(
  events: readonly SessionEvent[],
  entries: Iterable<InputEntry>,
): SessionEvent[] {
  const warmupIds = new Set([...entries].filter(entry => entry.warmup).map(entry => entry.id));
  const warmupTurnBoundaries = internalWarmupTurnBoundaries(events, warmupIds);
  return events.filter(event => {
    const inputId = 'inputId' in event ? event.inputId : undefined;
    const explicitlyInternal = event.internalWarmup === true ||
      (!!inputId && warmupIds.has(inputId)) ||
      (event.kind === 'user_message' && isInternalWarmupQuestionText(event.message.text));
    if (explicitlyInternal) return false;
    const boundary = event.turnId ? warmupTurnBoundaries.get(event.turnId) : undefined;
    if (!boundary || event.seq < boundary.firstWarmupSeq) return true;
    return boundary.authoredQuestionSeq !== null && event.seq >= boundary.authoredQuestionSeq;
  });
}

/** User-authored project sends live in the transcript while the outbox delivers them. */
export function projectAuthoredInputs(
  entries: Iterable<InputEntry>,
  selectedId: string | null,
  projectId: string | null,
  selectionGeneration: number,
  pendingNewInput: PendingNewProjectInput | null,
  completedThrough: number | null = null,
): InputEntry[] {
  if (!projectId) return [];
  const unique = new Map<string, InputEntry>();
  for (const entry of entries) {
    if (completedAuthoredInput(entry, completedThrough) || entry.warmup || entry.warmupDeferred || entry.purpose === 'decision' || entry.finishOwner ||
        entry.authoredSource === 'none' || entry.state === 'failed' || entry.state === 'cancelled' || entry.state === 'decision') continue;
    const owner = entry.sessionId ?? entry.deliveredSessionId ?? null;
    const belongsToSelectedChat = selectedId !== null
      ? owner === selectedId
      : pendingNewInput?.generation === selectionGeneration && pendingNewInput.id === entry.id &&
        entry.projectId === projectId && (owner === null || entry.opening === true);
    if (belongsToSelectedChat) unique.set(entry.id, entry);
  }
  return [...unique.values()];
}

export function warmupDeferredEntries(
  entries: Iterable<InputEntry>,
  selectedId: string | null,
  selectionGeneration: number,
  completedThrough: number | null = null,
): InputEntry[] {
  const unique = new Map<string, InputEntry>();
  for (const entry of entries) unique.set(entry.id, entry);
  return [...unique.values()].filter(entry => {
    if (!entry.warmupDeferred || completedAuthoredInput(entry, completedThrough) || ['failed', 'cancelled', 'decision'].includes(entry.state)) return false;
    const owner = entry.sessionId ?? entry.deliveredSessionId ?? null;
    const sameOpening = owner === null && entry.warmupDeferred.selectionGeneration === selectionGeneration;
    return selectedId === null ? sameOpening : owner === selectedId || sameOpening;
  });
}
export function optimisticWarmupEvents(
  events: readonly SessionEvent[],
  entries: Iterable<InputEntry>,
  selectedId: string | null,
  selectionGeneration: number,
  completedThrough: number | null = null,
): SessionEvent[] {
  const represented = new Set(events.flatMap(event => event.kind === 'user_message'
    ? [event.inputId, event.messageId].filter((value): value is string => !!value)
    : []));
  const firstSeq = events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
  return warmupDeferredEntries(entries, selectedId, selectionGeneration, completedThrough)
    .filter(entry => !represented.has(entry.id) && !represented.has(entry.messageId ?? `input:${entry.id}`))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((entry, index) => {
      const text = entry.deliveryText ?? entry.text;
      return {
        seq: firstSeq + index + 1,
        time: entry.offeredAt ?? entry.deliveredAt ?? entry.createdAt,
        source: 'app',
        kind: 'user_message',
        messageId: entry.messageId ?? `input:${entry.id}`,
        inputId: entry.id,
        authoredText: entry.text,
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
        message: { text, chars: text.length, truncated: false },
      } satisfies SessionEvent;
    });
}

export function optimisticProjectInputEvents(
  events: readonly SessionEvent[],
  entries: Iterable<InputEntry>,
  selectedId: string | null,
  projectId: string | null,
  selectionGeneration: number,
  pendingNewInput: PendingNewProjectInput | null,
  completedThrough: number | null = null,
): SessionEvent[] {
  const represented = new Set(events.flatMap(event => event.kind === 'user_message'
    ? [event.inputId, event.messageId].filter((value): value is string => !!value)
    : []));
  const firstSeq = events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
  return projectAuthoredInputs(entries, selectedId, projectId, selectionGeneration, pendingNewInput, completedThrough)
    .filter(entry => !represented.has(entry.id) && !represented.has(entry.messageId ?? `input:${entry.id}`))
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map((entry, index) => {
      const text = entry.deliveryText ?? entry.text;
      return {
        seq: firstSeq + index + 1,
        time: entry.offeredAt ?? entry.deliveredAt ?? entry.createdAt,
        source: 'app',
        kind: 'user_message',
        messageId: entry.messageId ?? `input:${entry.id}`,
        inputId: entry.id,
        authoredText: entry.text,
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
        message: { text, chars: text.length, truncated: false },
      } satisfies SessionEvent;
    });
}

export function warmupDeferredProgress(
  entries: Iterable<InputEntry>,
  selectedId: string | null,
  selectionGeneration: number,
  events: readonly SessionEvent[],
  options: { showQueued?: boolean; completedThrough?: number | null } = {},
): DeferredInputProgress | null {
  const pending = warmupDeferredEntries(entries, selectedId, selectionGeneration, options.completedThrough ?? null);
  if (!pending.length) return null;
  let dispatchedInput = false;
  for (const entry of pending) {
    if (authoredInputHasTerminalResponse(entry, events)) {
      dispatchedInput = true;
      continue;
    }
    const dispatched = entry.state === 'sent' || entry.state === 'tool' ||
      (entry.state === 'browser' && entry.offeredAt !== undefined);
    if (!dispatched) continue;
    dispatchedInput = true;
    const user = events.find(event => event.kind === 'user_message' &&
      (event.inputId === entry.id || event.messageId === (entry.messageId ?? `input:${entry.id}`)));
    const laterActivity = user && events.some(event => event.seq > user.seq &&
      ['assistant_message', 'tool_call', 'page_tool', 'progress', 'turn_start', 'turn_end', 'chat_error'].includes(event.kind));
    if (!laterActivity) return 'thinking';
  }
  if (options.showQueued && pending.some(entry => entry.state === 'queued' ||
    (entry.state === 'browser' && entry.offeredAt === undefined))) return 'thinking';
  if (dispatchedInput) return null;
  // Project preparation stays internal. Project chat UI can show generic
  // activity while the extension holds an authored message; other callers keep
  // null as the signal that send controls remain paused during preparation.
  return options.showQueued ? 'thinking' : null;
}

export function projectAuthoredInputProgress(
  entries: Iterable<InputEntry>,
  selectedId: string | null,
  projectId: string | null,
  selectionGeneration: number,
  pendingNewInput: PendingNewProjectInput | null,
  events: readonly SessionEvent[],
  completedThrough: number | null = null,
): DeferredInputProgress | null {
  const pending = projectAuthoredInputs(entries, selectedId, projectId, selectionGeneration, pendingNewInput, completedThrough);
  if (!pending.length) return null;
  let waitingForActivity = false;
  for (const entry of pending) {
    if (authoredInputHasTerminalResponse(entry, events)) continue;
    const dispatched = entry.state === 'sent' || entry.state === 'tool' ||
      (entry.state === 'browser' && entry.offeredAt !== undefined);
    if (!dispatched) {
      waitingForActivity = true;
      continue;
    }
    const user = events.find(event => event.kind === 'user_message' &&
      (event.inputId === entry.id || event.messageId === (entry.messageId ?? `input:${entry.id}`)));
    const laterActivity = user && events.some(event => event.seq > user.seq &&
      ['assistant_message', 'tool_call', 'page_tool', 'progress', 'turn_start', 'turn_end', 'chat_error'].includes(event.kind));
    if (!laterActivity) return 'thinking';
  }
  return waitingForActivity ? 'thinking' : null;
}
