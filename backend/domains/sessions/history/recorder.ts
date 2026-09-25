// The MCP server records exact tool calls while provider pages supply transcript, lifecycle, and request-ID evidence for session attribution.

import { createObservationRecorder } from './recorder-observations.js';
import type { LiveConversation } from './recorder-observations.js';
export type { ChatObservation, PageCallEvidence } from './recorder-observations.js';
import { createRecorderToolWriter, type RecorderCallAttributionListener } from './recorder-tool-writer.js';
import type { ToolCallInput, ToolCallTarget } from './recorder-tool-call-types.js';
export type { ToolCallInput, ToolContentPart } from './recorder-tool-call-types.js';
import type {
  SessionChange,
  SessionEvent,
  SessionSummary,
  StoredText,
  ToolCallRecord,
  TurnOutcome
} from '../../../../contracts/session.js';
import { estimateTokens } from '../../../../contracts/session.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { createAttributionRepair } from './attribution-repair.js';
import { createRecorderRequestEvidence, evidenceWindow, REQUEST_ID_GRACE_MS } from './recorder-request-evidence.js';
import { createRecorderAppEvents } from './recorder-app-events.js';
import { createRecorderSessionLifecycle } from './recorder-session-lifecycle.js';
import { createRecorderTurnRecovery } from './recorder-turn-recovery.js';
import { createRecorderCallAdmission } from './recorder-call-admission.js';
import {
  MAX_MESSAGE_CHARS,
  appendEvent,
  endSession,
  findSessionByConversation,
  getSession,
  readEvents,
  writeOverflowText,
} from './store.js';
import { awaitRequestCorrelation, requestCorrelation } from './correlation.js';

const conversations = new Map<string, LiveConversation>();
const turnRecovery = createRecorderTurnRecovery(conversations);
const { reopenThinkingFailure, reopenFalselyEndedTurn } = turnRecovery;

const listeners = new Set<(change: SessionChange) => void>();
let notifyTimer: NodeJS.Timeout | null = null;
/** Every local session written during the current burst; one push names all of them. */
const changedSessions = new Set<string>();

export function onSessionChange(listener: (change: SessionChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publishes the exact sessions whose durable projection this recorder just wrote. */
export function notifyChanged(...sessionIds: string[]): void {
  for (const id of sessionIds) changedSessions.add(id);
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    const change: SessionChange = { sessionIds: [...changedSessions] };
    changedSessions.clear();
    for (const listener of listeners) listener(change);
  }, 400);
  notifyTimer.unref?.();
}

export function recordingEnabled(): boolean {
  return getConfig().sessions.record;
}

const sessionLifecycle = createRecorderSessionLifecycle({ conversations, recordingEnabled, notifyChanged });
export const {
  sessionForConversation,
  restoreRecordedConversation,
  noteChatOrigin,
  ensureUnattributedSession,
  promoteConversationTitle
} = sessionLifecycle;

const attributionRepair = createAttributionRepair({
  recordingEnabled,
  activeSessionId: sessionLifecycle.activeSessionId,
  setActiveSessionId: sessionLifecycle.setActiveSessionId,
  unattributedSessionId: sessionLifecycle.unattributedSessionId,
  setUnattributedSessionId: sessionLifecycle.setUnattributedSessionId,
  notifyChanged
});

const requestEvidence = createRecorderRequestEvidence({ repair: attributionRepair.repair });
export { evidenceWindow, REQUEST_ID_GRACE_MS };
export const { freshCallOrigin, awaitFreshCallOrigin, queueDeterministicAttributionRepair } = requestEvidence;

export const repairDeterministicAttribution = attributionRepair.repair;

// Sessions section.

/** The session the UI opens by default: whatever was written to most recently. */
export function activeSessionId(): string | null {
  return sessionLifecycle.activeSessionId();
}

// Describes the live recorded session owned by one provider conversation.
export function sessionIdForConversation(conversationId: string | null): string | null {
  if (!conversationId) return null;
  return conversations.get(conversationId)?.sessionId ?? null;
}

// `activeTurnId` is the generation id of the turn this conversation currently has open, or null. It exists so a reloaded content script can adopt the turn it is standing in the middle of instead of minting a second one. The extension's turn ids are `g-<run>-<epoch>-<n>`, where `<run>` is a namespace random per *document*. That is what makes them unique, and it is also why a reload cannot reconstruct one: the old document's namespace died with it. So the new document sees a stop button, believes it is watching a turn nobody has reported, and opens another — splitting one assistant run across two local lifecycle generations. This app holds the durable half of that lifecycle identity, so this is where it has to come from.
export function liveConversations(): Array<{
  conversationId: string;
  sessionId: string;
  generating: boolean;
  activeTurnId: string | null;
  /** When the active turn was opened (its durable turn_start time); null while none is. */
  activeTurnStartedAt: number | null;
  // How many turns of this chat have finished. Only ever goes up, for the life of the entry. `knownTurnEnds` is the recorder's idempotency set for turn ends, so its size is already an exact count of them - including the ends recovered from a final assistant message after a page reload. It answers the one question a turn id cannot: whether the turn that was live a moment ago is the turn that is live now. A reload mints a fresh local id for a generation that never ended, so id inequality means "or the page came back", while this counter moves only when a turn is actually over.
  endedTurns: number;
  /** Newest durable turn verdict; null when this chat has never reported an end. */
  lastTurnOutcome: TurnOutcome | null;
}> {
  return [...conversations.values()].map((entry) => ({
    conversationId: entry.conversationId,
    sessionId: entry.sessionId,
    generating: entry.turnStartedAt !== null,
    activeTurnId: entry.turnStartedAt !== null ? entry.turnId : null,
    activeTurnStartedAt: entry.turnStartedAt,
    endedTurns: entry.knownTurnEnds.size,
    lastTurnOutcome: entry.lastTurnOutcome
  }));
}

const noteCallEvidence = requestEvidence.noteCallEvidence;

// Helpers section.

// Stores text for one event: bounded inline, complete in an asset when it overflows. `truncated` means "not all of it is on this line", never "the rest is gone" — the whole redacted original goes next to the log and its id travels in the event, so the exact arguments of an edit or the exact output of a build stay recoverable. The one case where material really is lost is text beyond even the overflow limit, and then the inline note says exactly that instead of implying a complete record.
async function storeText(
  sessionId: string,
  text: string,
  cap: number
): Promise<StoredText> {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (value.length <= cap) return { text: value, truncated: false, chars: value.length };
  const assetId = await writeOverflowText(sessionId, value);
  const note = assetId
    ? `\n…[${value.length - cap} more characters stored in full as ${assetId}]`
    : `\n…[${value.length - cap} more characters were too large to store and are lost]`;
  return {
    text: `${value.slice(0, cap)}${note}`,
    truncated: true,
    chars: value.length,
    ...(assetId ? { assetId } : {})
  };
}

// Tool calls section.


const pendingRecordings = new Set<Promise<unknown>>();

// Waits for admitted tool calls and request-evidence repairs before shutdown; producers close before this barrier.
export async function flushRecorder(): Promise<void> {
  while (pendingRecordings.size) await Promise.all([...pendingRecordings]);
  await requestEvidence.flush();
}

/** Set by the agent broker so a worker's calls land in that worker's own session. */
let agentConversationLookup: (agent: string) => string | null = () => null;
let agentBinder: (agent: string, conversationId: string) => void = () => undefined;

export function setAgentConversationLookup(lookup: (agent: string) => string | null): void {
  agentConversationLookup = lookup;
}

// Set by the bridge. Called once per filed call with the verdict this module just reached: the conversation the request-id join proved, or null for a call that finished the grace with no page evidence at all. Both are already durable when it runs. One hook rather than two, because the two facts are one fact — which chats' reporting works and which activity nobody claimed — and splitting them invites a second attribution clock somewhere else. Nothing here decides what a verdict is worth; the bridge owns that.
let attributionListener: RecorderCallAttributionListener | null = null;

export function setCallAttributionListener(
  listen: RecorderCallAttributionListener | null
): void {
  attributionListener = listen;
}

/** Set by the agent broker, for the deferred prime binding in recordToolCall. */
export function setAgentBinder(bind: (agent: string, conversationId: string) => void): void {
  agentBinder = bind;
}

function bindAgentConversation(agent: string, conversationId: string): void {
  try {
    agentBinder(agent, conversationId);
  } catch (err) {
    logWarn(`could not bind ${agent} to its conversation: ${(err as Error).message}`);
  }
}

function agentConversation(agent: string): string | null {
  try {
    return agentConversationLookup(agent);
  } catch {
    return null;
  }
}

// The session an event is physically written to. Anything that could not be tied to a conversation goes to the unattributed stream. The previous behaviour — fall back to whichever session was written to last — was the dangerous one: with two workers generating at once it appended one agent's calls into the other's raw history, and nothing downstream could tell that had happened.
async function targetSession(target: ToolCallTarget): Promise<string | null> {
  if (target.attribution === 'superseded') return ensureUnattributedSession();
  if (target.conversationId) {
    if (target.sessionId) {
      const exact = await getSession(target.sessionId);
      if (exact && exact.chatIds.includes(target.conversationId)) return exact.id;
      logWarn(
        `request attribution session ${target.sessionId} for conversation ${target.conversationId} is unavailable; refusing to downgrade to a newer conversation epoch`
      );
      return null;
    }
    const live = conversations.get(target.conversationId);
    if (live) return live.sessionId;
    // Request-id ownership is allowed to outlive the browser tab and a Compact & Resume rebind. Append to that durable session without calling sessionForConversation(), whose semantics correctly mean "the page reopened" and would clear endedAt. Historical chat lineage is safe here only because target.conversationId came from exact request proof.
    const durable = await findSessionByConversation(target.conversationId, { includeHistorical: true });
    if (durable) return durable.id;
    // First ever evidence for this exact conversation can still be an MCP call. There is no existing session to resurrect, so creating one through the ordinary path is correct.
    return sessionForConversation(target.conversationId);
  }
  return ensureUnattributedSession();
}

const observationRecorder = createObservationRecorder({
  conversations,
  recordingEnabled,
  sessionForConversation,
  storeText,
  noteCallEvidence,
  notifyChanged,
  promoteConversationTitle,
  reopenThinkingFailure
});

export const recordRequestEvidence = observationRecorder.recordRequestEvidence;
export const recordChatObservations = observationRecorder.recordChatObservations;
const serializeObservations = observationRecorder.serializeObservations;
const appEvents = createRecorderAppEvents({
  recordingEnabled,
  appendEvent,
  storeText,
  notifyChanged,
  readEvents,
  findSessionByConversation,
  agentConversation,
  sessionForConversation,
  ensureUnattributedSession,
  logWarn,
  maxMessageChars: MAX_MESSAGE_CHARS
});

const toolWriter = createRecorderToolWriter({
  recordingEnabled,
  conversations,
  targetSession,
  storeText,
  serializeObservations,
  reopenFalselyEndedTurn,
  notifyChanged,
  trackPending: work => {
    pendingRecordings.add(work);
    void work.then(() => pendingRecordings.delete(work));
  },
  attributionListener: () => attributionListener
});

const callAdmission = createRecorderCallAdmission({
  conversations,
  recordingEnabled,
  requestCorrelation,
  awaitRequestCorrelation,
  requestIdGraceMs: REQUEST_ID_GRACE_MS,
  bindAgentConversation,
  targetSession,
  fileToolCall: (input, target) => toolWriter.fileToolCall(input, target),
  pendingRecordings
});

export function recordToolCall(input: ToolCallInput): Promise<ToolCallRecord | null> {
  return callAdmission.recordToolCall(input);
}

export function recordNote(sessionId: string, text: string, continuation?: string): Promise<void> {
  return appEvents.recordNote(sessionId, text, continuation);
}

export function recordProgress(
  sessionId: string,
  progressId: string,
  text: string,
  anchor?: { seq: number; time: number },
  turnId?: string | null,
  finishControl?: { state: 'released' | 'notified' | 'decision'; conversationId: string; revision?: string; inputRevision?: string; workSeq?: number }
): Promise<{ seq: number; time: number } | null> {
  return appEvents.recordProgress(sessionId, progressId, text, anchor, turnId, finishControl);
}

export function recordAgentMessage(
  message: Parameters<typeof appEvents.recordAgentMessage>[0],
  delivery: 'sent' | 'delivered',
  ownerConversationId: string | null = null
): Promise<void> {
  return appEvents.recordAgentMessage(message, delivery, ownerConversationId);
}

export function recordHandoff(sessionId: string, handoffId: string, chars: number, reason: string): Promise<void> {
  return appEvents.recordHandoff(sessionId, handoffId, chars, reason);
}

export function ensureHandoffRecorded(sessionId: string, handoffId: string, chars: number, reason: string): Promise<boolean> {
  return appEvents.ensureHandoffRecorded(sessionId, handoffId, chars, reason);
}

// Called when a conversation page goes away. Browser lifetime owns the *binding* — which tab speaks for this conversation — and nothing else. `pagehide` cannot tell a reload from a navigation from a real close, and in every one of those cases provider keeps the server generation running while no page is watching it. So a detach is not evidence about the turn, not even weak evidence: synthesising a `turn_end` here closed the exact turn the recovery path was supposed to reopen, and a closed turn can never be resolved by later real evidence. The open turn stays open; the detach is recorded as a note, which the timeline shows without ending anything, and recordChatObservations writes the real terminal when the chat comes back.
export async function closeConversation(conversationId: string, dismissBrowserRecovery = false): Promise<void> {
  const live = conversations.get(conversationId);
  if (!live) {
    const known = dismissBrowserRecovery ? await findSessionByConversation(conversationId) : null;
    if (known) await endSession(known.id, true, conversationId);
    return;
  }
  if (live.turnStartedAt !== null) {
    await appendEvent(live.sessionId, {
      time: Date.now(),
      source: 'extension',
      kind: 'note',
      ...(live.turnId ? { turnId: live.turnId } : {}),
      message: await storeText(
        live.sessionId,
        'the provider page detached while this turn was still open; the turn stays open until real evidence ends it',
        4000
      )
    }).catch(() => undefined);
  }
  conversations.delete(conversationId);
  await endSession(live.sessionId, dismissBrowserRecovery, conversationId);
  notifyChanged(live.sessionId);
}

// Rebinds a session to its replacement provider conversation without carrying page-scoped turn state.
export function rebindConversation(sessionId: string, fromConversationId: string, toConversationId: string): void {
  const previous = conversations.get(fromConversationId);
  if (previous?.sessionId === sessionId) conversations.delete(fromConversationId);
  conversations.set(toConversationId, {
    conversationId: toConversationId,
    sessionId,
    turnStartedAt: null,
    turnId: null,
    openTurns: new Set<string>(),
    knownTurnStarts: new Set<string>(),
    knownTurnEnds: new Set<string>(),
    lastTurnOutcome: null,
    lastTurnStartedAt: null,
    turnRequestIds: new Set<string>(),
    endedTurn: null,
    pageTools: new Map()
  });
  sessionLifecycle.setActiveSessionId(sessionId);
  notifyChanged(sessionId);
}

// Removes every conversation binding before the session is deleted.
export function forgetSession(sessionId: string): string[] {
  const affected: string[] = [];
  for (const [conversationId, entry] of conversations) {
    if (entry.sessionId !== sessionId) continue;
    conversations.delete(conversationId);
    affected.push(conversationId);
  }
  if (sessionLifecycle.unattributedSessionId() === sessionId) sessionLifecycle.setUnattributedSessionId(null);
  if (sessionLifecycle.activeSessionId() === sessionId) sessionLifecycle.setActiveSessionId(null);
  if (affected.length > 0) {
    logInfo(`session ${sessionId} deleted while live; ${affected.length} conversation(s) will start a new session`);
  }
  return affected;
}

/** Rough token estimate for a session, from the text actually stored. */
export async function sessionTokens(sessionId: string): Promise<number> {
  const summary = await getSession(sessionId);
  return summary?.estimatedTokens ?? 0;
}

export function estimate(text: string): number {
  return estimateTokens(text);
}

/** Test seam. */
export function resetRecorderForTests(): void {
  requestEvidence.reset();
  conversations.clear();
  observationRecorder.resetForTests();
  sessionLifecycle.reset();
  callAdmission.reset();
  pendingRecordings.clear();
  attributionRepair.reset();
  agentConversationLookup = () => null;
  agentBinder = () => undefined;
  // The attribution listener is deliberately not cleared here: it belongs to the bridge's start/stop lifecycle, and a recorder reset between tests must not silently unwire it.
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
    changedSessions.clear();
  }
}

export type { SessionSummary, SessionEvent };
