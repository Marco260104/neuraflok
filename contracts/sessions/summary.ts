import { workerOwnTask } from '../worker-brief.js';
import type { ApiProviderSettings } from '../types.js';
import type { ActivitySummary, TurnOutcome } from './events.js';
import type { ReasoningEffort } from './agents.js';

export interface SessionOrigin {
  kind: 'resume' | 'worker' | 'helper' | 'desktop';
  /** The session this chat continues. Null when the source session no longer exists. */
  fromSessionId: string | null;
  /** Agent id for a worker chat ("worker-1"). Null for a resume. */
  agentId: string | null;
  /** The worker's task, verbatim from `agents action=spawn`. Empty for a resume. */
  task: string;
}

/** Historical presentation projected from an accepted broker snapshot; grants no worker authority. */
export interface WorkerAssignmentSummary {
  conversationId: string;
  agentId: string;
  label: string;
  task: string;
  recordedAt: number;
}

const RESUMED_PREFIX = 'Resumed · ';

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The name to give a chat this app opened, in place of its bootstrap prompt. A resumed or worker chat opens with a long instruction this app typed itself, and the ordinary "name a session after the first thing the user said" rule turned that instruction into the session's name. The result was a list of near-identical rows reading `Continue the previous the provider ...` and `You are worker agent "worker-1"...` with nothing in them to say which run a row belonged to. The command that opened the chat already knows what the chat is for, so the name comes from there instead. */
export function originTitle(origin: SessionOrigin, source: string | null): string {
  if (origin.kind === 'desktop') return source || 'New chat';
  if (origin.kind === 'helper') return 'Task helper';
  if (origin.kind === 'worker') {
    const who = origin.agentId ?? 'worker';
    // Its own task: the run's shared context opens every worker's brief alike.
    const task = clip(workerOwnTask(origin.task), 60);
    return task ? `${who} · ${task}` : who;
  }
  // A resumed chat is itself resumable, and often is. Stacking the prefix each time would bury the part of the name that identifies the work.
  const from = clip((source ?? '').replace(new RegExp(`^(?:${RESUMED_PREFIX})+`), ''), 80);
  return from ? `${RESUMED_PREFIX}${from}` : 'Resumed session';
}

export interface SessionSummary {
  /** Rebuildable transcript boundaries; no message bodies or execution authority. */
  timelineTurns?: import('../chronology.js').TimelineTurns;
  /** Rebuildable request-to-turn proof from recorded MCP calls, never a caller permission. */
  requestTurns?: import('../chronology.js').RequestTurns;
  /** Rebuildable native question boundary; tool-result instructions never replace it. */
  nativeQuestion?: { messageId: string; origin: number } | null;
  /** Durable naming authority; absent only on legacy recordings. */
  titleSource?: 'fallback' | 'provider' | 'manual';
  /** Keep the latest provider title available when the user clears a manual title. */
  autoTitle?: { title: string; source: 'fallback' | 'provider' };
  /** Latest proven native picker selection; scoped to its frontend, never worker creation intent. */
  selectedModel?: {
    conversationId: string;
    model: string;
    observedAt: number;
    reasoningEffort?: ReasoningEffort;
    /** Present for local API chats so later settings changes cannot retarget their provider. */
    apiProvider?: ApiProviderSettings;
  };
  /** Explicit local project; durable across frontend conversation replacement. */
  projectId?: string;
  id: string;
  title: string;
  /** Provider conversation currently attached to this durable local session. */
  conversationId: string | null;
  /** Provider conversation IDs this session has used, in order. */
  chatIds: string[];
  /** Durable departure times from the same rebind commit. Used only to recover plans accepted before a historical frontend was replaced, never to infer caller identity. */
  retiredChatAt?: Record<string, number>;
  startedAt: number;
  updatedAt: number;
  /** Null while the session is still the active one. */
  endedAt: number | null;
  /** Explicit user departure suspends activity and automatic recovery until the exact page returns. */
  browserRecoveryDismissedAt?: number;
  events: number;
  userMessages: number;
  toolCalls: number;
  /** Start time of the newest exact attributed tool call, independent of later page noise. */
  lastToolCallAt: number | null;
  /** Compact projection of the newest recorded tool action. The full tool row remains in session history. This exists so overview surfaces can show useful worker activity without loading each worker transcript. */
  lastToolActivity?: Pick<ActivitySummary, 'kind' | 'title'> | null;
  workerAssignment?: WorkerAssignmentSummary;
  /** Observation time of the newest stable final assistant message. */
  lastAssistantFinalAt?: number | null;
  /** Time of the newest turn end, whatever ended it: the model finishing, the user pressing stop, or an error. The other end of "recent activity" beside `lastAssistantFinalAt`, which a stopped turn never sets — so a prime the user blocked and stopped stayed `active` for three minutes on the strength of the refused call before the stop (2026-09-02). Undefined on metadata written before this field existed. */
  lastTurnEndAt?: number | null;
  /** Runtime-only activity deadline from the bridge; null means no current activity grant. */
  activityExpiresAt?: number | null;
  /** Start time of the newest successful worker finish report in this session. A worker's finish is its final answer as far as this app is concerned, and it is durable here because the swarm that also knows it parks the moment its last worker stops: a list that read only the swarm showed a finished worker as `active` for three minutes and then as nothing at all. Undefined on metadata written before this field existed. */
  lastFinishReportAt?: number | null;
  processExitNonzero: number;
  toolRejected: number;
  /** Connector/tool implementation failures; the tool reliability numerator. */
  toolInternalErrors: number;
  /** Chat errors plus `toolInternalErrors`. */
  errors: number;
  /** Rough local estimate for the whole session — never a private provider counter. */
  estimatedTokens: number;
  /** The same estimate, but only for what the *currently attached* provider conversation is carrying. This is what the composer meter fills against and what automatic compaction fires on, and it is why one durable session surviving a compaction does not mean an ever-rising meter: the rebind into chat B resets this to zero while `estimatedTokens` keeps counting the session's whole life. Chat B genuinely starts with only the handoff in its context, so measuring it against the session's lifetime total would re-fire compaction immediately after every compaction. */
  contextTokens: number;
  /** Id of the newest stored handoff, or null when the session was never compacted. */
  lastHandoffId: string | null;
  lastHandoffAt: number | null;
  /** Handoff that positively became the opening user message of the currently attached resumed chat, or null when no successful Compact & Resume has been durably proven. Distinct from `lastHandoffId`: a handoff is published as soon as capture is durable, before the replacement-chat rebind commits. A later aborted compaction may therefore advance `lastHandoffId` without ever becoming the provider context. This field moves only with the same atomic metadata write that moves `conversationId` to the replacement chat. */
  lastCommittedResumeHandoffId?: string | null;
  /** Outcome of the most recent finished turn. */
  lastTurnOutcome: TurnOutcome | null;
  /** Durable open-turn projection. Undefined only on pre-1.8.8 metadata. */
  activeTurnId?: string | null;
  /** A pre-Send automatic handoff refusal lasts until a different turn or frontend. */
  autoCompactionRefusal?: { conversationId: string; turnId: string | null };
  /** Constant-size projection of app finish receipts for the most recently started turn. */
  finishTurn?: {
    turnId: string;
    conversationId: string | null;
    startedAt: number;
    notified: boolean;
    released: boolean;
    decisionRevision: string | null;
    workSeq: number;
    decisionSeq: number;
    decisionInputRevision: string | null;
    decisionAt?: number;
  } | null;
  /** Agents seen in this session, prime first. Empty when no swarm ran. */
  agents: string[];
  /** Set only for a chat this app opened itself. Null for one the user started. */
  origin: SessionOrigin | null;
}

/** Committed Compact & Resume predecessors for the conversation currently attached to this session, nearest first. This is pure projection of durable metadata: callers that need an authorization decision must first obtain the unique authoritative session summary. */
export function committedResumeAncestorsFromSummary(
  summary: Pick<SessionSummary, 'conversationId' | 'chatIds' | 'lastCommittedResumeHandoffId'>,
  conversationId: string
): string[] {
  if (!conversationId || summary.conversationId !== conversationId || !summary.lastCommittedResumeHandoffId) return [];
  const current = summary.chatIds.lastIndexOf(conversationId);
  if (current !== summary.chatIds.length - 1 || current < 1) return [];
  return summary.chatIds.slice(0, current).reverse();
}

/** What one `session:changed` push says about transcripts. A push without it refreshes only the session catalog and controls; the selected transcript is reread only for its owner. */
export interface SessionChange {
  /** Exact local sessions whose durable transcript projection changed in this burst. */
  sessionIds?: string[];
  /** A cross-session mutation without enumerable owners; every open transcript is stale. */
  allTranscripts?: true;
}

export interface HandoffProvenance {
  /** provider frontend that authored the brief. */
  sourceConversationId: string | null;
  /** One-based position of that frontend in the durable session lineage, when known. */
  sourceGeneration: number | null;
  /** Exact source turn pinned by the continuation transaction, when one existed. */
  sourceTurnId: string | null;
  /** Non-authority fingerprint of the continuation transaction. This is derived from the one-time continuation token. Provenance stores the fingerprint instead of the raw token because handoffs are readable through ordinary session IPC. */
  continuationId: string | null;
}

export interface Handoff {
  /** New writes are v1. Absent means a legacy handoff written before provenance existed. */
  version?: 1;
  id: string;
  sessionId: string;
  createdAt: number;
  /** The continuation brief itself. */
  text: string;
  /** How the raw session looked when this was made, for honest staleness reporting. */
  sourceEvents: number;
  sourceTokens: number;
  /** Set when the model stopped early or the pack dropped material. */
  notes: string[];
  /** Immutable source identity for new versioned handoffs. */
  provenance?: HandoffProvenance;
}

