/** Turn display order follows durable boundaries and event evidence while preserving append-order cursors and stable identities. */

/** The minimum an entry needs to be placed. Both consumers' shapes satisfy it structurally. */
export interface Chronological {
  seq: number;
  /** First position of a mutable canonical item; seq may be its newer revision cursor. */
  origin?: number;
  /** When the item logically happened: `startedAt` for a call, first appearance for prose. */
  time: number;
  /** Provider creation time is presentation metadata, never an execution clock. */
  authoredAt?: number;
  /** Recorded owning start, supplied before pagination; null means no proven group. */
  turnOrigin?: number | null;
  messageId?: string;
  inputId?: string;
  kind: string;
  source?: string;
  agent?: string;
  call?: { requestId?: string | null; conversationId?: string | null; attribution?: string };
  turnId?: string | null;
  /** Provider final marker for the message that ended a turn. See `closing()`. */
  final?: boolean;
  state?: string;
}

export type TimelineTurns = Record<string, {
  origin: number; time: number; endTime?: number; endOrigin?: number;
  questionId?: string;
  /** Another document observed the same exact request while this response was open. */
  responseTurnId?: string;
}>;

export interface TurnIdentity {
  timelineTurns?: TimelineTurns;
  requestTurns?: RequestTurns;
  /** Latest native question, excluding instructions handed out inside tool results. */
  nativeQuestion?: { messageId: string; origin: number } | null;
}

/** Derived from exact, already turn-owned MCP records. Null retains contradictory proof. */
export type RequestTurns = Record<string, { turnId: string; conversationId: string; origin: number } | null>;

/** Undefined is unobserved; null is conflicting. Neither grants a turn or a conversation. */
