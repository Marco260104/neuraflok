import type { SessionEvent, StoredText } from './events.js';

/** Rough token estimate for locally held text. Four characters per token is the usual English approximation. It is deliberately not presented as the provider's context counter: hidden reasoning, system prompts and the tool schema are all invisible from here, so the number is only ever used to suggest compaction, never to claim a limit was reached. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Recorder clipping changes storage, not the text already sent to the model. */
export function storedTextTokens(value: StoredText): number {
  const chars = value.truncated && Number.isSafeInteger(value.chars) && value.chars >= 0
    ? value.chars : value.text.length;
  return Math.ceil(chars / 4);
}

/** Local estimation policy for one MCP return, independent of recorder/transport limits. */
export const MAX_TOOL_RESULT_TOKENS = 10_000;

/** Token weight of recorded context; previews, assets and HTML are not extra context. */
export function eventTokens(event: SessionEvent): number {
  switch (event.kind) {
    case 'user_message':
      return Math.max(
        storedTextTokens(event.message),
        Number.isFinite(event.wireTokenEstimate) ? Math.max(0, Math.floor(event.wireTokenEstimate!)) : 0
      );
    case 'assistant_message':
    case 'chat_error':
    case 'note':
      return storedTextTokens(event.message);
    case 'progress':
      // Live progress/reasoning captions are useful audit evidence but are not stable conversation context, and often restate work that later appears in the final assistant message. Counting every transient caption made the advisory meter roughly double what users saw in the actual conversation on tool-heavy turns.
      return 0;
    case 'agent_message':
      // Real context, unlike a progress caption: a brokered message is appended to a tool result the model actually reads, so it occupies the conversation the same way a tool result does. Leaving it at zero made the meter under-report exactly the runs most likely to need compacting — the multi-agent ones.
      return storedTextTokens(event.message);
    case 'tool_call':
      if (event.call.nested === true) return 0;
      return (
        storedTextTokens(event.call.args) +
        Math.min(MAX_TOOL_RESULT_TOKENS, storedTextTokens(event.call.result)) +
        estimateTokens(event.call.summary.title)
      );
    case 'handoff':
      return 0;
    default:
      return 0;
  }
}

/** Collapses every stored snapshot of one page-observed item back into one event. The recorder writes a `progress` or `page_tool` event again whenever the thing it is watching has changed on screen. That is the honest thing to store — an append-only log cannot rewrite a line it has already written — but it is not what anything should *display*: one caption that grew four times is one caption, not four, and one activity row whose label was rewritten as it finished is one step, not two. Rendering the snapshots as siblings is exactly the duplicated-and-reordered transcript this fold exists to undo. The surviving event keeps the *first* snapshot's position (seq, time, turn, agent) and the *last* snapshot's text. Position first, because the thing happened when it first appeared — placing it at the newest snapshot would drag it below tool calls it actually preceded, which is the other half of the same bug. Snapshots with no identity are left exactly as they are: nothing about them says they belong together. Identity is namespaced by kind. A `progressId` and a `messageId` are minted by different code paths and are not required to be disjoint; folding them into one keyspace would let a caption swallow an activity row that happened to be named the same thing. */
export function foldProgress(events: readonly SessionEvent[]): SessionEvent[] {
  const anchor = new Map<string, number>();
  const out: Array<SessionEvent | null> = [...events];
  for (let index = 0; index < out.length; index++) {
    const event = out[index];
    if (!event) continue;
    let key: string | null = null;
    if (event.kind === 'progress' && event.progressId) key = `progress\u0000${event.progressId}`;
    else if (event.kind === 'tool_call') key = `tool_call\u0000${event.call.callId}`;
    else if (event.kind === 'page_tool' && event.messageId) key = `page_tool\u0000${event.messageId}`;
    if (!key) continue;
    const at = anchor.get(key);
    if (at === undefined) {
      anchor.set(key, index);
      continue;
    }
    const held = out[at];
    if (held && held.kind === 'progress' && event.kind === 'progress') {
      out[at] = { ...held, message: event.message };
    } else if (held && held.kind === 'page_tool' && event.kind === 'page_tool') {
      out[at] = { ...held, label: event.label };
    } else if (held && held.kind === 'tool_call' && event.kind === 'tool_call') {
      out[at] = event.seq >= held.seq ? { ...event, origin: held.origin ?? held.seq, time: held.time } : held;
    }
    out[index] = null;
  }
  // A page-local stopped verdict is not provider cancellation confirmation. Preserve the recorded request instead of manufacturing a stronger receipt.
  return out.filter((event): event is SessionEvent => event !== null);
}

export interface TokenPressure {
  estimated: number;
  advisory: number;
  limit: number;
  level: 'ok' | 'large' | 'huge';
}

export function tokenPressure(estimated: number, advisory: number, limit: number): TokenPressure {
  return {
    estimated,
    advisory,
    limit,
    level: estimated >= limit ? 'huge' : estimated >= advisory ? 'large' : 'ok'
  };
}

