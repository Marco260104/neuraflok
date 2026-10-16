// Durable session storage owns recorded messages, tool results, and handoffs; diagnostics remain redacted and memory-only.
import path from 'node:path';
import type { NewSessionEvent, SessionEvent, SessionOrigin, SessionSummary } from '../../../../contracts/session.js';
import { logError, logWarn } from '../../../infrastructure/settings/logger.js';
import { createSessionAssets } from './session-assets.js';
import { createSessionMessageWrites } from './session-message-writes.js';
import { createSessionEventReader, type ReadOptions } from './session-event-reader.js';
import { createSessionEventQueries } from './session-event-queries.js';
import { createSessionMetadata } from './session-metadata.js';
import { createSessionStoreLiveState, type OpenSession } from './session-store-live.js';
import { initializeSessionPaths, sessionDir, sessionPaths } from './session-store-paths.js';
import { createSessionDocuments } from './session-documents.js';
import { createSessionHistoryRebuilder } from './session-history-rebuild.js';
import { createSessionCanonicalMessages } from './session-canonical-messages.js';
import { createSessionJournalRecovery } from './session-journal-recovery.js';
import type { MessageEvent, NewNativeImageEvent } from './session-canonical-messages.js';
export type { CanonicalEvent, MessageEvent, NativeImageEvent, NewMessageEvent, NewNativeImageEvent } from './session-canonical-messages.js';
export type { OpenSession } from './session-store-live.js';
export type { ReadOptions } from './session-event-reader.js';
export { sessionSearchIndexPath, sessionWebProviderThreadPath, sessionApiThreadPath, sessionsRoot } from './session-store-paths.js';
import { createSessionCatalog } from './session-catalog.js';
import { createSessionLifecycle } from './session-lifecycle.js';
import { createSessionProcessCalls } from './session-process-calls.js';
import { createSessionCompactionPolicy } from './session-compaction-policy.js';
import { createSessionEventAppender } from './session-event-appender.js';
import { createSessionDurableSnapshotReader, type DurableSessionSnapshot } from './session-durable-snapshot.js';
import { createUnattributedBucketRewrite } from './unattributed-bucket-rewrite.js';
import { createSessionSummaryWriter } from './session-summary-writer.js';
export { MAX_ASSET_BYTES, MAX_SESSION_ASSET_BYTES, MAX_GLOBAL_ASSET_BYTES, MAX_OVERFLOW_ASSET_CHARS } from './session-assets.js';
export type { SessionListCursor, SessionPage } from './session-catalog.js';

// Caps on how much of a value is written *inline*, into the JSONL line itself. These are not caps on what is kept. Anything longer is written whole, redacted, as a `.txt` asset beside the log and referenced by `StoredText.assetId`, so the exact arguments of an edit and the exact output of a command stay recoverable however large they were — which is the entire premise of calling this history the source of truth. What the caps buy is a log whose lines a reader can still parse and a summary pass can still skim. A Compact & Resume handoff becomes the next chat's opening user message. This is a wire / storage safety bound, not a token budget; keep it comfortably above the model's 30k-token handoff ceiling so the recorder does not immediately turn the carried brief into an inline stub plus asset reference. Truly runaway messages still spill to assets through storeText().
export const MAX_USER_MESSAGE_CHARS = 256_000;
export const MAX_MESSAGE_CHARS = 12_000;
export const MAX_TOOL_ARGS_CHARS = 8_000;
export const MAX_TOOL_RESULT_CHARS = 8_000;

/** A single line that cannot be parsed back is dropped; this bounds the damage. */
const MAX_LINE_BYTES = 512 * 1024;

const { assertReady, assertSessionId } = sessionPaths;

export function initSessionStore(userDataDir: string): void {
  initializeSessionPaths(userDataDir);
  sessionAssets.reset();
  sessionCatalog.reset();
}


const MAX_EVENT_TAIL = 4096;
let durableSnapshotReader: ReturnType<typeof createSessionDurableSnapshotReader> | null = null;
let sessionLiveState: ReturnType<typeof createSessionStoreLiveState> | null = null;
function liveState(): ReturnType<typeof createSessionStoreLiveState> {
  if (!sessionLiveState) throw new Error('Session live state is not initialized');
  return sessionLiveState;
}
const sessionMetadata = createSessionMetadata({
  assertSessionId,
  hasLiveSession: id => sessionLiveState?.hasLiveSession(id) ?? false,
  readAuthoritativeSummary,
  readDurableSnapshot,
  rootPath: sessionPaths.getRoot,
  sessionDirectory: sessionDir
});
const { readCatalogSummary, readMeta, readMetaCheckpoint } = sessionMetadata;
export const { getSession, sessionDirectoryMissing, sessionDurableModifiedAt } = sessionMetadata;
/** Internal checkpoint field persisted beside the public summary projection. */
function messageKey(event: SessionEvent | Omit<MessageEvent, 'seq'> | NewNativeImageEvent): string | null {
  if (event.kind === 'tool_call') return event.call?.callId ? `tool_call\u0000${event.call.callId}` : null;
  if (event.kind === 'native_image') return event.messageId && event.providerAssetId
    ? `native_image\u0000${event.messageId}\u0000${event.providerAssetId}` : null;
  return (event.kind === 'user_message' || event.kind === 'assistant_message') && event.messageId
    ? `${event.kind}\u0000${event.messageId}` : null;
}

const { readCanonicalMessages, writeCanonicalMessage } = createSessionCanonicalMessages({ sessionDir, messageKey });
const { lastSeqOnDisk, sealTornTail } = createSessionJournalRecovery({ sessionDir, maxLineBytes: MAX_LINE_BYTES });

// Allow a staged summary to reach disk before compaction publishes it in memory.
const writeSummary = createSessionSummaryWriter({ sessionDirectory: sessionDir });

const rebuildSummaryFromHistory = createSessionHistoryRebuilder({
  sessionDirectory: sessionDir,
  maxLineBytes: MAX_LINE_BYTES,
  messageKey,
  writeSummary
});

durableSnapshotReader = createSessionDurableSnapshotReader({
  assertSessionId,
  readCanonicalMessages,
  lastSeqOnDisk,
  readMetaCheckpoint,
  writeSummary,
  rebuildSummaryFromHistory
});

function readDurableSnapshot(id: string): Promise<DurableSessionSnapshot | null> {
  if (!durableSnapshotReader) throw new Error('Session snapshot reader is not initialized');
  return durableSnapshotReader.readDurableSnapshot(id);
}

async function writeMeta(entry: OpenSession): Promise<void> {
  return liveState().writeMeta(entry);
}

function enqueueSessionOperation<T>(entry: OpenSession, label: string, operation: () => Promise<T>): Promise<T> {
  return liveState().enqueueSessionOperation(entry, label, operation);
}

// Serializes an external durable policy mutation against session ownership changes. `rebindSession()` uses the same per-session queue. Callers that need to validate the current provider conversation and then await a different durable store (for example trusted-chats) must keep that validation and write in one fence, otherwise Compact & Resume can commit A -> B between them and turn stale intent for A into authority inherited by B. The summary is read-only by contract; mutate session state only through store primitives.
export async function withSessionMutationFence<T>(
  id: string,
  operation: (summary: Readonly<SessionSummary>) => Promise<T>
): Promise<T> {
  const entry = await ensureOpen(id);
  return enqueueSessionOperation(entry, 'external policy fence', () => operation(entry.summary));
}

// The summary is rewritten on a short delay rather than on every event. A long agent session appends thousands of events; rewriting the summary for each one would turn an append-only log into a write-amplified one for no benefit.
function scheduleMeta(entry: OpenSession): void {
  liveState().scheduleMeta(entry);
}

/** Flushes any pending summary write. Called before the app quits and before reads. */
export async function flushSessions(): Promise<void> {
  return liveState().flushSessions();
}

// Waits only for mutations that belong to one session, then makes its summary current on disk. A read of session A must not become a global write barrier for every other open session. Besides the avoidable latency, the old `flushSessions()` call meant polling one chat could force metadata churn for dozens of unrelated generating chats. The per-session queue already is the serialization boundary, so joining that target queue is both sufficient and stronger: it also waits for an in-flight reconstruction of this exact session before deciding whether there is anything live to flush.
async function flushSession(sessionId: string): Promise<void> {
  return liveState().flushSession(sessionId);
}


export async function createSession(options: {
  /** Reserved by an accepted opening outbox row; never supplied by model tools. */
  reservedId?: string;
  title?: string;
  titleSource?: SessionSummary['titleSource'];
  conversationId?: string | null;
  origin?: SessionOrigin | null;
}): Promise<SessionSummary> {
  return liveState().createSession(options);
}


async function readAuthoritativeSummary(id: string): Promise<SessionSummary | null> {
  const live = liveState().getOpenSession(id);
  if (live) return live.summary;
  const becomingLive = liveState().getOpeningSession(id);
  if (becomingLive) return (await becomingLive).summary;
  const snapshot = await readDurableSnapshot(id);
  if (!snapshot) return null;
  // If a process-lifetime catalog already exists, or one is concurrently being built and may already have passed this row, invalidate/update it after a recovery write. The catalog's own build calls readDurableSnapshot directly, so its normal stale-row repairs do not self-loop.
  if (snapshot.reconciled && isSessionCatalogActive()) {
    publishAttachmentSummary(snapshot.summary);
  }
  return snapshot.summary;
}

async function ensureOpen(id: string): Promise<OpenSession> {
  return liveState().ensureOpen(id);
}

// Whether this chat is over its automatic-compaction line. A level, and deliberately not the edge this used to be. The edge version armed on the below-to-above crossing and then waited for that turn to end cleanly, which had two consequences the design never wanted: a single interrupted turn destroyed the trigger forever (a counter that only grows never crosses the same line twice), and every compaction it did manage to fire landed *after* the model had finished answering — the one moment where a handoff is pointless, because the work it would carry across is already done. So this half of the rule is just "over the line". The other half — that the model is working *right now* — is a fact about the open browser connection rather than about the recording, so it is asked at the point of use, in bridge.ts. That is what keeps a stale 500k chat quiet when it is merely opened: it is over the line all day, and nothing is running in it. The existing continuation transaction is the durable authority once a stopped/settled chat asks for its handoff prompt; pre-barrier refusal owns no durable state and may be attempted by a later generation.
export function automaticCompactionAllowed(summary?: SessionSummary | null): boolean {
  return sessionCompactionPolicy.automaticCompactionAllowed(summary);
}

export function autoCompactionReady(summary: SessionSummary | null | undefined, working = false): boolean {
  return sessionCompactionPolicy.autoCompactionReady(summary, working);
}

export async function refuseAutomaticCompactionNow(id: string, conversationId: string, turnId: string | null): Promise<void> {
  return sessionCompactionPolicy.refuseAutomaticCompactionNow(id, conversationId, turnId);
}

const sessionEventAppender = createSessionEventAppender({
  ensureOpen,
  sessionDirectory: sessionDir,
  deniedAssetIds: (sessionId, assets) => deniedAssetIds(sessionId, assets),
  admittedAssets: (sessionId, assets) => admittedAssets(sessionId, assets),
  mergedRetiredAssetIds: (...groups) => mergedRetiredAssetIds(...groups),
  sealTornTail,
  lastSeqOnDisk,
  scheduleMeta,
  maxEventTail: MAX_EVENT_TAIL,
  maxLineBytes: MAX_LINE_BYTES,
  warn: logWarn,
  error: message => logError(message)
});
export function appendEvent(sessionId: string, event: NewSessionEvent): Promise<SessionEvent> {
  return sessionEventAppender.appendEvent(sessionId, event);
}

export async function recordProcessCall(sessionId: string, event: Omit<Extract<SessionEvent, { kind: 'tool_call' }>, 'seq'>): Promise<void> {
  return sessionProcessCalls.recordProcessCall(sessionId, event);
}

export async function completeProcessCall(sessionId: string, callId: string, completion: {
  completedAt: number; durationMs: number; exitCode: number | null; benignExit?: boolean;
}): Promise<void> {
  return sessionProcessCalls.completeProcessCall(sessionId, callId, completion);
}


const sessionEventReader = createSessionEventReader({
  assertSessionId,
  eventFile: id => path.join(sessionDir(id), 'events.jsonl'),
  flushSession,
  getOpenSession: id => liveState().getOpenSession(id) ?? null,
  maxEventTail: MAX_EVENT_TAIL,
  maxLineBytes: MAX_LINE_BYTES,
  messageKey,
  readCanonicalMessages,
  readDurableSummary: async id => (await readDurableSnapshot(id))?.summary ?? null,
  warn: logWarn
});
const { readRecentEventsFromDisk } = sessionEventReader;
export const readRecentEvents = sessionEventReader.readRecentEvents;

export function readEvents(sessionId: string, options: ReadOptions = {}): Promise<SessionEvent[]> {
  return sessionEventReader.readEvents(sessionId, options);
}

export async function rewriteUnattributedToolCalls(
  sessionId: string,
  calls: readonly Extract<SessionEvent, { kind: 'tool_call' }>[],
  scannedThroughSeq: number,
  deleteEmpty = false
): Promise<{ retained: number; deleted: boolean }> {
  return unattributedBucketRewrite.rewriteUnattributedToolCalls(sessionId, calls, scannedThroughSeq, deleteEmpty);
}

const sessionDocuments = createSessionDocuments({
  assertSessionId,
  ensureOpen,
  enqueueSessionOperation,
  sessionDirectory: sessionDir,
  waitForSessionQueue: async id => { await liveState().getOpenSession(id)?.queue; }
});
export const { readSessionPlan, updateSessionPlan } = sessionDocuments;

export async function pruneSessions(_retainDays: number): Promise<number> {
  return 0;
}

/** Test seam: forgets in-memory state without touching the files. */
export function resetSessionStoreForTests(): void {
  liveState().reset();
  durableSnapshotReader?.reset();
  sessionAssets.reset();
  sessionCatalog.reset();
}

/** Test seam: puts the store back to never having been told where to write. */
export function unsetSessionRootForTests(): void {
  sessionPaths.unset();
  sessionAssets.reset();
  sessionCatalog.reset();
}


// Supplies session paths and history mutations to the asset storage owner.
export const sessionAssetsRuntime = {
  get assertReady() { return assertReady; },
  get assertSessionId() { return assertSessionId; },
  get enqueueSessionOperation() { return enqueueSessionOperation; },
  get ensureOpen() { return ensureOpen; },
  getRoot: sessionPaths.getRoot,
  get messageKey() { return messageKey; },
  get readEvents() { return readEvents; },
  get scheduleMeta() { return scheduleMeta; },
  get sessionDir() { return sessionDir; },
  get writeCanonicalMessage() { return writeCanonicalMessage; }
};

const sessionAssets = createSessionAssets(sessionAssetsRuntime);
const { admittedAssets, deniedAssetIds, mergedRetiredAssetIds, retainedAssets, invalidateAssetUsage } = sessionAssets;

const sessionProcessCalls = createSessionProcessCalls({
  ensureOpen,
  enqueueSessionOperation,
  messageKey,
  admittedAssets: (sessionId, assets) => admittedAssets(sessionId, assets),
  deniedAssetIds: (sessionId, assets) => deniedAssetIds(sessionId, assets),
  mergedRetiredAssetIds: (...groups) => mergedRetiredAssetIds(...groups),
  writeCanonicalMessage,
  scheduleMeta
});

// Supplies canonical provider message writes with the durable session queue and asset policy.
export const sessionMessageWritesRuntime = {
  get admittedAssets() { return admittedAssets; },
  get deniedAssetIds() { return deniedAssetIds; },
  get ensureOpen() { return ensureOpen; },
  get messageKey() { return messageKey; },
  get mergedRetiredAssetIds() { return mergedRetiredAssetIds; },
  get retainedAssets() { return retainedAssets; },
  get scheduleMeta() { return scheduleMeta; },
  get writeCanonicalMessage() { return writeCanonicalMessage; }
};
const sessionMessageWrites = createSessionMessageWrites(sessionMessageWritesRuntime);
export const { upsertMessageEvent, upsertNativeImageEvent } = sessionMessageWrites;
export const { writeAsset, getImageStorage, clearImageStorage, readAsset, writeOverflowText, readOverflowText } = sessionAssets;

// Supplies bounded journal reads and session ownership checks to semantic query functions.
export const sessionEventQueriesRuntime = {
  assertSessionId,
  flushSession,
  readAuthoritativeSummary,
  readRecentEventsFromDisk,
  ensureOpen,
  enqueueSessionOperation,
  getOpenSession: (id: string) => liveState().getOpenSession(id) ?? null,
  isCurrentOpenSession: (id: string, entry: OpenSession) => liveState().isCurrentOpenSession(id, entry),
  getSession,
  readOverflowText,
  readAsset,
  maxEventTail: MAX_EVENT_TAIL,
  messageKey
};

const sessionEventQueries = createSessionEventQueries(sessionEventQueriesRuntime);
export const {
  readLatestUserMessage,
  readRecoveryBoundary,
  readCompletedFinal,
  readHandoffResponse,
  turnHasMcpCall,
  requestBelongsToActiveTurn,
  requestTurnOwnershipCutoff,
  turnEndedDurably,
  questionHasMcpCall,
  conversationHasMcpCallSince,
  readActivityEvents,
  readHydratedActivityCall,
  readToolEditReview
} = sessionEventQueries;

// Supplies durable metadata reads and the live session overlay to the summary catalog.
export const sessionCatalogRuntime = {
  assertReady,
  getRoot: sessionPaths.getRoot,
  openSummary: (id: string) => liveState().getOpenSession(id)?.summary ?? null,
  openSummaries: () => liveState().getOpenEntries().map(entry => entry.summary),
  readCatalogSummary,
  readMeta,
  getSession
};

const sessionCatalog = createSessionCatalog(sessionCatalogRuntime);
const {
  conversationAttachment,
  conversationWasSuperseded,
  findSessionByConversation,
  isActive: isSessionCatalogActive,
  publishAttachmentRemoval,
  publishAttachmentSummary,
  publishCachedSummary,
  publishClosedSummary,
  readEverySummary
} = sessionCatalog;
export { conversationAttachment, conversationWasSuperseded, findSessionByConversation };
export const { indexedSessions, listAllSessions, listSessionPage, listSessions, listUsageSessions } = sessionCatalog;

sessionLiveState = createSessionStoreLiveState({
  assertSessionId,
  sessionDirectory: sessionDir,
  getSession,
  clearMissingCurrentConversation: sessionCatalog.clearMissingCurrentConversation,
  readDurableSnapshot,
  sealTornTail,
  isSessionCatalogActive,
  publishAttachmentSummary,
  publishCachedSummary,
  writeSummary,
  error: message => logError(message)
});

const unattributedBucketRewrite = createUnattributedBucketRewrite({
  assertSessionId,
  ensureOpen,
  sessionDir,
  maxEventTail: MAX_EVENT_TAIL,
  writeSummary,
  deleteCurrentSession: (id, entry) => liveState().deleteOpenSession(id, entry),
  invalidateAssetUsage,
  publishAttachmentRemoval
});

const sessionCompactionPolicy = createSessionCompactionPolicy({
  ensureOpen,
  enqueueSessionOperation,
  writeSummary,
  publishAttachmentSummary
});

const sessionLifecycle = createSessionLifecycle({
  assertSessionId,
  ensureOpen,
  enqueueSessionOperation,
  writeMeta,
  writeSummary,
  sessionDirectory: sessionDir,
  getOpenSession: id => liveState().getOpenSession(id),
  deleteOpenSession: (id, expected) => liveState().deleteOpenSession(id, expected),
  getSession,
  findSessionByConversation,
  clearMissingCurrentConversation: sessionCatalog.clearMissingCurrentConversation,
  publishClosedSummary,
  publishAttachmentSummary,
  publishCachedSummary,
  publishAttachmentRemoval,
  invalidateAssetUsage,
  readEverySummary
});
export const {
  endSession,
  reopenSession,
  renameSession,
  clearSessionName,
  observeSessionModel,
  bindSessionProject,
  setSessionOrigin,
  recordWorkerAssignment,
  rebindSession,
  ensureCommittedResumeHandoff,
  saveHandoff,
  readHandoff,
  latestHandoff,
  deleteSession
} = sessionLifecycle;
