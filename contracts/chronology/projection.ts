import type { Chronological, RequestTurns, TimelineTurns } from './types.js';
import { recordedRequestTurn, responseTurnId } from './identity.js';
import { positionOf } from './position.js';

/** The older canonical assistant key already contains this exact provider timestamp. */
export function authoredTimeOf(entry: Chronological): number | undefined {
  if (Number.isFinite(entry.authoredAt) && entry.authoredAt! > 0) return entry.authoredAt;
  if (entry.kind !== 'assistant_message') return undefined;
  const id = entry.messageId?.match(/^assistant:([a-f0-9-]{36})?:([a-f0-9-]{36})?:(\d{13})$/i);
  return id && (id[1] || id[2]) ? Number(id[3]) : undefined;
}

/** Both canonical formats retain the native response's working/exchange UUIDs. The parent or creation stamp identifies a message inside it, not another response. */
function assistantResponseKey(entry: Chronological): string | undefined {
  if (entry.kind !== 'assistant_message' || entry.source !== 'extension') return undefined;
  const parts = entry.messageId?.split(':');
  if (parts?.length !== 4 || parts[0] !== 'assistant') return undefined;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const timestamped = /^\d{13}$/.test(parts[3]!);
  if (!timestamped && !uuid.test(parts[1]!)) return undefined;
  const working = parts[timestamped ? 1 : 2]!, exchange = parts[timestamped ? 2 : 3]!;
  if (!uuid.test(working) || !uuid.test(exchange)) return undefined;
  return `${entry.agent ?? ''}\u0000${working.toLowerCase()}:${exchange.toLowerCase()}`;
}

/** Attach the session's recorded boundaries before selecting/rendering a small page. These fields affect presentation only; seq, origin, time and turnId stay untouched. */
export function projectTimeline<T extends Chronological>(
  entries: readonly T[], turns: TimelineTurns = {}, requests: RequestTurns = {},
  messages: Iterable<Chronological> = entries
): T[] {
  const starts = Object.values(turns).sort((a, b) => a.origin - b.origin);
  // Canonical messages recover display groups across pagination without merging sibling messages or inventing a turn id.
  const responses = new Map<string, TimelineTurns[string] | null>();
  for (const message of messages) {
    if (!message.turnId) continue;
    const key = assistantResponseKey(message);
    if (!key) continue;
    const boundary = turns[responseTurnId(turns, message.turnId)] ?? null;
    if (!responses.has(key)) responses.set(key, boundary);
    else if (!boundary || responses.get(key)?.origin !== boundary.origin) responses.set(key, null);
  }
  return entries.map(entry => {
    let boundary = entry.turnId ? turns[responseTurnId(turns, entry.turnId)] : undefined;
    if (!entry.turnId) {
      const response = assistantResponseKey(entry);
      if (response) boundary = responses.get(response) ?? undefined;
    }
    // Exact earlier request proof places late calls even when the originating turn row is outside this page.
    const requestOwner = !entry.turnId && entry.kind === 'tool_call' && entry.source === 'mcp' && entry.call?.attribution === 'request_id'
      ? recordedRequestTurn(requests, entry.call.requestId, entry.call.conversationId) : undefined;
    if (requestOwner) boundary = turns[responseTurnId(turns, requestOwner.turnId)];
    if (!boundary && requestOwner === undefined && !entry.turnId && entry.kind !== 'user_message' && entry.kind !== 'assistant_message' && entry.kind !== 'native_image') {
      let low = 0, high = starts.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (starts[mid]!.origin < positionOf(entry)) low = mid + 1; else high = mid;
      }
      const candidate = starts[low - 1];
      if (candidate && (candidate.endTime === undefined || entry.time <= candidate.endTime)) boundary = candidate;
    }
    const authoredAt = authoredTimeOf(entry);
    return { ...entry, turnOrigin: boundary?.origin ?? null, ...(authoredAt !== undefined ? { authoredAt } : {}) };
  });
}
