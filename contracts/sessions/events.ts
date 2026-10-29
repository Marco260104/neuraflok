import type { ReasoningEffort } from './agents.js';

export type EventSource = 'extension' | 'mcp' | 'app';

/** How long the native Active badge keeps showing a chat as working after its last activity. Deliberately longer than the recovery window below, and this is the whole point of them being two constants rather than one. They answer different questions. Recovery asks "has this chat been quiet long enough that its page needs putting back together?", and two minutes is the answer that was measured. The badge answers "is this chat still the one doing something?", which stays true across the reload that the first question triggers — a page being reloaded on the app's own instruction is a chat mid-repair, not an idle one. Sharing the two-minute duration made the badge go dark first and the reload arrive afterwards: the label expired exactly on the boundary while the browser action still had the sweep and the extension's alarm ahead of it. A user watching that sees a chat go idle and then, half a minute later, reload itself for no visible reason. One minute of headroom covers both hops. */
export const CHAT_ACTIVE_MS = 3 * 60_000;

/** The inactivity window after which exact-chat browser recovery reloads an open turn once. */
export const CHAT_SILENCE_MS = 2 * 60_000;

/** How a provider turn ended. Deliberately more than "done" and "failed". Guessing "output limit reached" for every unexplained stop is exactly the fake precision this project avoids, so an unexplained stop stays `interrupted` or `unknown` unless the provider actually said why. */
export type TurnOutcome =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'stalled'
  | 'unknown';

export const TURN_OUTCOME_LABELS: Record<TurnOutcome, string> = {
  completed: 'completed',
  failed: 'failed with a visible error',
  stopped: 'stopped by the user',
  interrupted: 'interrupted before it finished',
  stalled: 'stalled — no visible progress',
  unknown: 'ended for an unknown reason'
};

/** Text stored in an event, with an explicit note when it was cut. The inline copy is bounded so the JSONL stays readable and one huge command output cannot push a line past the reader's limit. Nothing is actually lost by that: when the text is cut, the full redacted original is written beside the log as an asset and named here, so recovery reads the whole thing. `truncated` therefore means "not all of it is in this line", never "the rest is gone". */
export interface StoredText {
  text: string;
  /** True when the original was longer than the per-event cap. */
  truncated: boolean;
  /** Length of the original, so a summary can say what it lost. */
  chars: number;
  /** Asset holding the complete redacted text, present only when truncated. */
  assetId?: string;
  /** Digest of the complete text, for events whose identity has to survive being cut. Written for messages, which are the events a reloaded page reports again and which must therefore be recognisable as ones already stored. `text` alone cannot do that once it has been capped, and a length plus a head cannot tell two answers apart that begin the same way — the exact case where providers reuse turn IDs. */
  digest?: string;
}

/** A screenshot or other binary kept beside the log rather than inside it. */
export interface AssetRef {
  id: string;
  mimeType: string;
  bytes: number;
  /** Present only for images. */
  width?: number;
  height?: number;
}

/** Recording-asset storage is global; cleanup never changes the configured 2 GiB ceiling. */
export interface ImageStorageInfo {
  /** All bytes charged to the global session-asset quota, including preserved non-image assets. */
  usedBytes: number;
  limitBytes: number;
}

export interface ImageStorageClearResult extends ImageStorageInfo {
  /** Physical image bytes removed by this explicit user operation. */
  freedBytes: number;
  removedFiles: number;
}

export type ImageStorageClearMode = 'oldest-gib' | 'all';

/** Compact human-readable presentation of one tool call. */
export interface ActivitySummary {
  /** Short verb phrase: "Edited backend/infrastructure/tool-gateway/protocol/server.ts". */
  title: string;
  /** Optional qualifier: "lines 200–420", "30 matches". */
  detail?: string;
  /** Optional right-aligned metric: "+18 −4", "✓ 4.8s", "✕ exit 1". */
  metric?: string;
  tone: 'neutral' | 'good' | 'bad' | 'warn';
  /** Family the entry belongs to, for icons and filtering. */
  kind:
    | 'edit'
    | 'create'
    | 'delete'
    | 'move'
    | 'read'
    | 'search'
    | 'browse'
    | 'run'
    | 'process'
    | 'screen'
    | 'input'
    | 'clipboard'
    | 'session'
    | 'agent'
    | 'other';
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** True when the counts come from a bounded heuristic rather than a full diff. */
  approximate: boolean;
  /** Immutable before/after text from this exact tool call, stored beside its session log. */
  reviewAssetId?: string;
  /** Why no review was kept for this change, so the UI can say so instead of offering nothing. */
  reviewUnavailable?: 'too-large' | 'not-kept';
}

/** Historical edit evidence, independent of the current Git working tree. */
export interface ToolEditReview {
  callId: string;
  changeIndex: number;
  path: string;
  added: number;
  removed: number;
  baseText: string;
  currentText: string;
}

/** Only `tool_internal_error` is a connector defect. */
export type ToolOutcome = 'ok' | 'process_exit_nonzero' | 'tool_rejected' | 'tool_execution_error' | 'tool_internal_error';

/** How confident the recorder is that this call belongs to the session it landed in. Four grades, strongest first. `agent` is caller identity. `turn` is per-call evidence out of the page's own message model, or a connector block it drew. `generation` is the one provider conversation that was demonstrably mid-turn when the call arrived. `inferred` means nothing identified the caller — those calls are stored in the unattributed stream rather than guessed into somebody's history. The extension refuses to rewrite the provider's UI for an inferred call. */
export type CallAttribution =
  | 'request_id'
  | 'unattributed'
  | 'superseded'
  | 'turn'
  | 'agent'
  | 'generation'
  | 'inferred';

/** What each grade of attribution actually rests on, in the words shown to the user. Deliberately not interchangeable. `agent` is caller identity: a key only that agent holds, bound to a chat the app itself opened. `turn` is the page having shown a connector block — good evidence about which conversation made *a* connector call, but the collapsed row does not name the connector, so it is a match rather than an identity. `generation` is weaker again and is stated as what it is. The connector belongs to a provider account rather than to a browser, so a chat being mid-turn here does not prove this call came from here rather than from the same account on a phone. It is used because the alternative measured worse in practice by a wide margin: requiring per-call page evidence sent roughly half of one session's own work into `Unattributed activity`, and a record that is missing half the work is not more truthful than one that says how it placed each call. `inferred` is on the records in the unattributed stream, which is where everything else goes rather than being guessed into somebody's history. */
export const ATTRIBUTION_LABELS: Record<CallAttribution, string> = {
  request_id: 'exact request id',
  unattributed: 'request id not resolved',
  superseded: 'retired conversation',
  agent: 'agent key',
  turn: 'tool block on the page',
  generation: 'the only chat generating',
  inferred: 'not placed in a chat'
};

export interface ToolCallRecord {
  /** Internal code-mode invocation: retained for audit, never a separate model exchange. */
  nested?: boolean;
  /** Child lifetime, independent of the initial tool response and output delivery. */
  process?: { sessionId: string; completedAt?: number; exitCode?: number | null; durationMs?: number; benignExit?: boolean };
  /** Recorded model evidence, when known; absence is not the current picker selection. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  callId: string;
  tool: string;
  attribution: CallAttribution;
  /** Normalized inbound HTTP x-request-id, retained for forensic correlation. */
  requestId: string | null;
  /** Conversation proven by that request id, or null when ownership was unresolved. */
  conversationId: string | null;
  /** Deterministic placement outcome for current, unresolved, or deliberately retired callers. */
  attributionMethod: 'request_id' | 'unattributed' | 'superseded';
  /** Exact arguments as JSON. Cut inline past the cap, with the whole text in an asset. */
  args: StoredText;
  result: StoredText;
  outcome: ToolOutcome;
  durationMs: number;
  summary: ActivitySummary;
  /** Files this call demonstrably changed, with line counts where computable. */
  changes?: FileChange[];
  assets?: AssetRef[];
  /** Image assets explicitly removed from local recording storage; same-call replay cannot restore them. */
  retiredImageAssetIds?: string[];
  /** This call was the caller's last word: a worker's successful finish report. Recorded so the session itself, not only the in-memory swarm, knows the worker stopped working here. */
  endsActivity?: true;
}

export type MessageState = 'streaming' | 'final';

/** A tool call still running for a chat, as its live caption names it. */
export interface RunningToolActivity {
  /** Present-tense summary built from the call's own arguments, e.g. "Running git status". */
  title: string;
  /** The kind its finished row will have, so the live row wears the same icon. */
  kind: ActivitySummary['kind'];
  since: number;
}

/** A persisted launch acknowledgement never proves that its child is still alive. */
export function toolCallSummary(call: Pick<ToolCallRecord, 'tool' | 'summary'>): ActivitySummary {
  return call.tool === 'exec_command' && call.summary.metric === 'running'
    ? { ...call.summary, metric: 'started' } : call.summary;
}

/** Rendering, identity and process-status revisions are cursors, not new work. */
export function workSequence(event: SessionEvent): number {
  if (event.kind === 'user_message') return event.contentSeq ?? event.origin ?? event.seq;
  if (event.kind === 'assistant_message') return event.contentSeq ?? event.finalContentSeq ?? event.origin ?? event.seq;
  if (event.kind === 'page_tool') return event.contentSeq ?? event.origin ?? event.seq;
  return event.kind === 'tool_call' ? event.origin ?? event.seq : event.seq;
}

/** Reads current outcomes and only self-proving legacy `error` rows; ambiguous legacy errors abstain. */
export function normalizedToolOutcome(
  call: Pick<ToolCallRecord, 'tool' | 'summary'> & { outcome: unknown }
): ToolOutcome | null {
  if (
    call.outcome === 'ok' ||
    call.outcome === 'process_exit_nonzero' ||
    call.outcome === 'tool_rejected' ||
    call.outcome === 'tool_execution_error' ||
    call.outcome === 'tool_internal_error'
  ) {
    return call.outcome;
  }
  if (call.outcome === 'rejected') return 'tool_rejected';
  if (
    call.outcome === 'error' &&
    (call.tool === 'exec_command' || call.tool === 'write_stdin') &&
    /^✕ exit -?\d+$/.test(call.summary.metric ?? '')
  ) {
    return 'process_exit_nonzero';
  }
  return null;
}

interface BaseEvent {
  /** Selection verified for this exact delivered native message, never enqueue intent. */
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** 1-based, strictly increasing within a session. Ordering never relies on time. */
  seq: number;
  time: number;
  /** Provider timestamp for transcript presentation, independent of local activity. */
  authoredAt?: number;
  /** Read projection: owning start outside this page, or null for an unowned row. */
  turnOrigin?: number | null;
  source: EventSource;
  /** Multi-agent attribution. Absent when no swarm is running. */
  agent?: string;
  /** Internal provider warmup activity, never content authored in the chat. */
  internalWarmup?: true;
  /** the provider's own turn ID when the extension could read it. */
  turnId?: string;
}

export type SessionEvent =
  | (BaseEvent & { kind: 'session_start'; conversationId: string | null; title: string })
  | (BaseEvent & {
      kind: 'user_message';
      message: StoredText;
      messageId?: string;
      /** Exact app outbox identity, attached after a tool handout or proven native delivery. */
      inputId?: string;
      /** Tool handout remains unconfirmed until a later exact invocation proves receipt. */
      inputDelivery?: 'offered' | 'confirmed';
      /** Original app-authored text, excluding transport-only control instructions. */
      authoredText?: string;
      /** Estimated token weight of the complete native payload actually sent to the provider. */
      wireTokenEstimate?: number;
      /** Native badge on this exact user message. Missing means unobserved; null means absent. */
      reaction?: string | null;
      attachments?: import('../input.js').InputAttachment[];
      assets?: AssetRef[];
      /** Image assets explicitly removed from local recording storage; same-message replay cannot restore them. */
      retiredImageAssetIds?: string[];
      /** First sequence assigned to this stable website message; revisions keep this anchor. */
      origin?: number;
      /** Store-owned authored-content revision; metadata and rehydration preserve it. */
      contentSeq?: number;
    })
  | (BaseEvent & {
      kind: 'assistant_message';
      message: StoredText;
      /** Stable provider message identity used by the local canonical store. */
      messageId?: string;
      /** Exact local input that requested this reply, when the app generated it. */
      inputId?: string;
      /** Public provider object UUID. Evidence for identity drift; not a canonical key or turn owner. */
      providerMessageId?: string;
      /** Provider-reported model for this reply; model usage attribution remains separate. */
      resolvedModel?: string;
      state?: MessageState;
      /** Compatibility mirror for older consumers; equivalent to state === 'final'. */
      final: boolean;
      /** This exact stable reply was proven terminal and may enter Goal policy. */
      goalEligible?: boolean;
      /** Store-owned sequence of the latest final text/state change; rendering/metadata cannot advance it. */
      finalContentSeq?: number;
      /** Local acceptance time of final content; provider time can predate its last tools. */
      finalObservedAt?: number;
      /** First sequence assigned to this logical message; later revisions keep this anchor. */
      origin?: number;
      /** Store-owned text/state revision, including interim progress before the final. */
      contentSeq?: number;
    })
  | (BaseEvent & {
      /** provider-native generated media, independent of assistant prose and local MCP calls. */
      kind: 'native_image';
      /** Exact provider message UUID that owns this output. */
      messageId: string;
      /** Stable non-secret id from the typed sediment image pointer. */
      providerAssetId: string;
      providerRole: 'tool' | 'assistant';
      providerChannel?: 'final';
      /** Exact typed provider lifecycle for this image payload; it is not a turn boundary. */
      providerStatus?: 'in_progress' | 'finished_successfully';
      /** Provider-declared source geometry, used only to reserve truthful layout space. */
      width?: number;
      height?: number;
      /** Locally retained preview geometry and content-addressed bytes, when capture succeeded. */
      previewWidth?: number;
      previewHeight?: number;
      previewStatus: 'pending' | 'available' | 'unavailable';
      previewError?: 'not_loaded' | 'ambiguous' | 'tainted' | 'oversized' | 'invalid' | 'quota' | 'removed';
      asset?: AssetRef;
      /** First sequence assigned to this exact provider-message/asset tuple. */
      origin?: number;
    })
  /** One visible provider commentary item, as it stood when this snapshot was taken. `progressId` is the identity of the *logical* item — one caption block the page keeps growing — not of the snapshot. the provider re-lays-out, reparents, shrinks and redraws that block many times inside a turn, and treating each redraw as a new event is what put the same sentence on screen a dozen times, split across duplicate rows. So a later snapshot of the same item supersedes the earlier one instead of following it: readers keep the newest text at the *earliest* record's position, which is both where the commentary belongs chronologically and the only way one caption stays one row. `origin` names the seq of that earliest record, so a reader working from a cursor can still place a supersession whose anchor it has already consumed. Both are optional: an event written before this model existed, or by a page whose commentary had no readable identity, is still a plain standalone caption. */
  | (BaseEvent & { kind: 'progress'; message: StoredText; progressId?: string; origin?: number; finishControl?: { state: 'released' | 'notified' | 'decision'; conversationId: string; revision?: string; inputRevision?: string; workSeq?: number } })
  /** Visible provider-native tool activity that never passed through this MCP server. `messageId` is the provider's own thought/message identity for the activity. The rendered row may be replaced entirely and its label may change from "Inspecting" to "Inspected"; neither affects identity. `origin` names the seq of the first record of that site object, for readers working from a cursor that has already consumed it. */
  | (BaseEvent & { kind: 'page_tool'; messageId: string; label: string; origin?: number; contentSeq?: number })
  /** `detail` names an app-authored reopening: the page reported this turn ended, and a tool call under the same server turn then proved it had not. Absent on the page's own starts. */
  | (BaseEvent & { kind: 'turn_start'; detail?: string })
  | (BaseEvent & { kind: 'turn_end'; outcome: TurnOutcome; detail?: string; reason?: 'thinking_failed'; providerMessageId?: string })
  | (BaseEvent & { kind: 'chat_error'; message: StoredText; inputId?: string; recoverable?: boolean; blocking?: boolean; reason?: 'thinking_failed' | 'stream_gone' })
  | (BaseEvent & { kind: 'tool_call'; call: ToolCallRecord; origin?: number })
  /** An app-authored line. `continuation` names the Compact & Resume it is about, so the timeline can fold the note into that compaction's one row instead of showing it loose. */
  | (BaseEvent & { kind: 'note'; message: StoredText; continuation?: string })
  /** A message routed between agents. Recorded twice and deliberately so: once in the sender's session when the broker accepts it, once in the recipient's when the recipient acknowledges it. Without the second one a worker's report would exist only in the worker's own history and the volatile queue, so compacting the prime — the whole point of Compact & Resume while workers keep running — would silently omit everything the workers had told it. `messageId` is stable across both, so the pair can be matched and re-offers of the same message never produce a second record. */
  | (BaseEvent & {
      kind: 'agent_message';
      messageId: string;
      from: string;
      to: string;
      /** Prime-family reply address for a cross-family message. */
      fromRunId?: string;
      message: StoredText;
      delivery: 'sent' | 'delivered';
    })
  | (BaseEvent & {
      kind: 'handoff';
      handoffId: string;
      chars: number;
      /** What triggered it: manual compaction, resume, or an automatic suggestion. */
      reason: string;
    });

export type SessionEventKind = SessionEvent['kind'];

export { CONTINUATION_MARKER, continuationMarkerOf } from './continuation-marker.js';

/** Undo one layer of ASCII-punctuation escaping in page readback only. Callers try exact text first; authored Send instructions and ordinary user-message receipts remain unchanged. */
export function unescapeMarkdown(value: string): string {
  // Browser composers escape newlines, ASCII punctuation, and leading indentation on readback.
  return value.replace(/\\\r?\n/g, '\n').replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/(^|\n)&#x20;/g, '$1 ');
}

/** An event before the store assigns its sequence number. Written as a distributive conditional because a plain Omit over a union keeps only the keys every member shares, which would silently reduce every event to its base fields and let a caller append a tool_call with no call in it. */
export type NewSessionEvent = SessionEvent extends infer Event
  ? Event extends SessionEvent
    ? Omit<Event, 'seq'>
    : never
  : never;

/** How a chat came to exist, when this app is the one that opened it. Recorded when the extension acknowledges that it typed the bootstrap into a fresh tab, which is the first and only moment at which the app can connect the command it queued to the conversation that command became. */
