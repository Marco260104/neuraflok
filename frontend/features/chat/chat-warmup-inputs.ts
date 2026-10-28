import type { SessionEvent } from '../../../contracts/session.js';
import type { InputEntry } from '../../../backend/domains/sessions/input/input.js';

export type DeferredInputProgress = 'thinking';

export function warmupDeferredEntries(
  entries: Iterable<InputEntry>,
  selectedId: string | null,
  selectionGeneration: number,
): InputEntry[] {
  const unique = new Map<string, InputEntry>();
  for (const entry of entries) unique.set(entry.id, entry);
  return [...unique.values()].filter(entry => {
    if (!entry.warmupDeferred || ['failed', 'cancelled', 'decision'].includes(entry.state)) return false;
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
): SessionEvent[] {
  const represented = new Set(events.flatMap(event => event.kind === 'user_message'
    ? [event.inputId, event.messageId].filter((value): value is string => !!value)
    : []));
  const firstSeq = events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
  return warmupDeferredEntries(entries, selectedId, selectionGeneration)
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
): DeferredInputProgress | null {
  const pending = warmupDeferredEntries(entries, selectedId, selectionGeneration);
  if (!pending.length) return null;
  let dispatchedInput = false;
  for (const entry of pending) {
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
  if (dispatchedInput) return null;
  // Project preparation is an internal handshake. An authored message can be
  // visible in the transcript while it waits, but it is not thinking until
  // the outbox confirms the provider has received it.
  // Keep a queued after-turn message quiet after a failed preparation or app
  // restart; the retry/error controls carry the actionable state.
  return null;
}
