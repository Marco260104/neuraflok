import type { StoredText, TurnOutcome } from '../../../../contracts/session.js';

export interface LiveConversation {
  conversationId: string;
  sessionId: string;
  /** Durable local turn lifecycle only. Never used as MCP ownership evidence. */
  turnStartedAt: number | null;
  turnId: string | null;
  // Only locally opened turns remain eligible for reload recovery.
  openTurns: Set<string>;
  /** Durable starts and ends not superseded by an app-authored reopen; browser replay stays idempotent. */
  knownTurnStarts: Set<string>;
  knownTurnEnds: Set<string>;
  /** Newest durable turn verdict, used only to interpret post-reload final/call evidence. */
  lastTurnOutcome: TurnOutcome | null;
  /** Start of that turn, so its final may predate a later detach/end while old finals cannot. */
  lastTurnStartedAt: number | null;
  /** provider request ids — one per server turn — that called tools while the open turn ran. */
  turnRequestIds: Set<string>;
  // Preserve exact request ids so later calls can prove and reopen a premature page end.
  endedTurn: { turnId: string; startedAt: number | null; endedAt: number; requestIds: Set<string> } | null;
  /** Visible provider-native activity rows, updated by the page's stable row identity. */
  pageTools: Map<string, ProgressRecord>;
}

export interface ProgressRecord {
  /** Seq of the first record written for this item — where every reader positions it. */
  seq: number;
  /** And the time it was first seen, for the same reason. */
  time: number;
  /** Most recent observation of this logical item, used only to validate a re-parent alias. */
  updatedAt: number;
  text: string;
  /** The turn it belongs to, so a re-stamp is only ever matched within its own turn. */
  turnId?: string;
  /** Semantic work stamp; zero is a historical native row first seen on reload. */
  contentSeq?: number;
}

export interface ChatObservation {
  kind:
    | 'model_selection'
    | 'conversation_title'
    | 'user_message'
    | 'assistant_message'
    | 'native_image'
    | 'page_tool'
    | 'turn_start'
    | 'turn_end'
    | 'chat_error'
    | 'tool_evidence';
  time: number;
  /** Current native selection evidence, not a historical message or requested worker model. */
  model?: string;
  reasoningEffort?: import('../../../../contracts/session.js').ReasoningEffort;
  /** True when `time` is provider's own authored create_time, not local observation time. */
  authoredTime?: boolean;
  /** Provider time retained for display without changing local recovery clocks. */
  authoredAt?: number;
  /** True only for the newest DOM user row that this document proved was just sent. */
  authoredNow?: boolean;
  /** True only when the current page generation owns this assistant revision now. */
  activeNow?: boolean;
  text?: string;
  /** Exact native user-message attachment metadata; no remote URL or image bytes. */
  attachments?: import('../../../../contracts/input.js').InputAttachment[];
  reaction?: string | null;
  messageId?: string;
  /** Exact local outbox identity for an app-generated assistant acknowledgement or setup failure. */
  inputId?: string;
  /** App-owned provider preparation; never expose its transient turns in the chat UI. */
  internalWarmup?: true;
  /** Raw public provider message UUID, retained as evidence, never used to guess ownership. */
  providerMessageId?: string;
  /** Server-reported model of an assistant reply; see SessionEvent.resolvedModel. */
  resolvedModel?: string;
  /** Exact non-secret provider asset id for a native generated image. */
  providerAssetId?: string;
  providerRole?: 'tool' | 'assistant';
  providerChannel?: 'final';
  providerStatus?: 'in_progress' | 'finished_successfully';
  width?: number;
  height?: number;
  previewWidth?: number;
  previewHeight?: number;
  previewStatus?: 'pending' | 'available' | 'unavailable';
  previewError?: 'not_loaded' | 'ambiguous' | 'tainted' | 'oversized' | 'invalid' | 'quota';
  previewDataUrl?: string;
  turnId?: string;
  final?: boolean;
  state?: 'streaming' | 'final';
  /** Internal React conversation id used only to cross-check the URL conversation id. */
  fiberConversationId?: string;
  outcome?: TurnOutcome;
  /** Thinking failed closes input; stream_gone only files a recoverable transport episode. */
  reason?: 'thinking_failed' | 'stream_gone';
  detail?: string;
  /** Browser terminal proof; app-owned Goal policy is applied only after this is durable. */
  goalEligible?: boolean;
  /** chat_error only: explicit recovery authority from a transport failure or app watchdog. */
  recoverable?: boolean;
  /** chat_error only: the DOM classifier identified a provider access limit, in any language. */
  blocking?: boolean;
  /** tool_evidence only: the connector requests this turn's message model holds. */
  calls?: PageCallEvidence[];
}

export interface PageCallEvidence {
  /** provider's message id for the request, which is what makes this idempotent. */
  messageId: string;
  tool: string;
  /** Position within the turn, recorded only for diagnostics/presentation. */
  order: number;
  /** Whether the page has seen a result come back yet. Recorded for diagnosis only. */
  answered: boolean;
  // The provider request id proves ownership; observation time is not a reliable order signal.
  requestId?: string | null;
  createTime?: number | null;
}

export interface ObservationActivity {
  meaningful: boolean;
  working: boolean;
  terminal: boolean;
  at?: number;
  startedAt?: number;
  endedTurnId?: string;
}

export interface ObservationRuntime {
  conversations: Map<string, LiveConversation>;
  recordingEnabled(): boolean;
  sessionForConversation(conversationId: string | null, title?: string): Promise<string | null>;
  storeText(sessionId: string, text: string, cap: number): Promise<StoredText>;
  noteCallEvidence(conversationId: string, sessionId: string, fiberConversationId: string | null | undefined, calls: readonly PageCallEvidence[], at: number): boolean;
  notifyChanged(...sessionIds: string[]): void;
  promoteConversationTitle(sessionId: string, title?: string, conversationId?: string): Promise<void>;
  reopenThinkingFailure(sessionId: string, live: LiveConversation | undefined, at: number, owner?: string): Promise<string | null>;
}

