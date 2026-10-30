import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionSummary } from '../../../../contracts/session.js';
import { isApiProviderSettings } from '../../../../contracts/settings.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';
import { legacyContextTitle, legacyLabelPending } from './title.js';

// These keys version the summary projection stored beside session history.
export const META_HISTORY_SEQ = '__historySeq';
export const META_CANONICAL_PROJECTION = '__canonicalProjection';
export const META_TOKEN_ESTIMATE = '__tokenEstimate';

export type PersistedSummary = SessionSummary & {
  [META_HISTORY_SEQ]?: number;
  [META_CANONICAL_PROJECTION]?: number;
  [META_TOKEN_ESTIMATE]?: number;
};

interface MetaCheckpoint {
  summary: SessionSummary;
  historySeq: number | null;
  canonicalProjectionCurrent: boolean;
  tokenEstimateCurrent: boolean;
  outcomeCountersMissing: boolean;
  activityBoundaryMissing: boolean;
}

interface Runtime {
  assertSessionId(sessionId: string): void;
  hasLiveSession(sessionId: string): boolean;
  readAuthoritativeSummary(sessionId: string): Promise<SessionSummary | null>;
  readDurableSnapshot(sessionId: string): Promise<{ summary: SessionSummary } | null>;
  rootPath(): string;
  sessionDirectory(sessionId: string): string;
}

export function createSessionMetadata(runtime: Runtime) {
  const {
    assertSessionId,
    hasLiveSession,
    readAuthoritativeSummary: readAuthoritativeSummaryOf,
    readDurableSnapshot: readDurableSnapshotOf,
    rootPath,
    sessionDirectory
  } = runtime;

function normalizeSummary(id: string, raw: string): MetaCheckpoint | null {
  try {
    const parsed = JSON.parse(raw) as PersistedSummary;
    if (parsed?.id !== id) return null;
    const historySeq =
      Number.isSafeInteger(parsed[META_HISTORY_SEQ]) && (parsed[META_HISTORY_SEQ] as number) >= 0
        ? (parsed[META_HISTORY_SEQ] as number)
        : null;
    const { [META_HISTORY_SEQ]: _historySeq, [META_CANONICAL_PROJECTION]: canonicalProjection, [META_TOKEN_ESTIMATE]: tokenEstimate, ...publicFields } = parsed;
    const publicSummary = publicFields as SessionSummary;
    if (publicSummary.retiredChatAt !== undefined) {
      const retired = publicSummary.retiredChatAt;
      publicSummary.retiredChatAt = retired && typeof retired === 'object' && !Array.isArray(retired)
        ? Object.fromEntries(Object.entries(retired).filter(([chat, at]) =>
          Array.isArray(publicSummary.chatIds) && publicSummary.chatIds.includes(chat) &&
          chat !== publicSummary.conversationId && typeof at === 'number' && Number.isFinite(at) && at >= 0))
        : {};
    }
    if (publicSummary.titleSource !== undefined && !['fallback', 'provider', 'manual'].includes(publicSummary.titleSource)) delete publicSummary.titleSource;
    const auto = publicSummary.autoTitle;
    if (auto !== undefined && (publicSummary.titleSource !== 'manual' || !auto || typeof auto !== 'object' ||
        typeof auto.title !== 'string' || !['fallback', 'provider'].includes(auto.source))) delete publicSummary.autoTitle;
    const selected = publicSummary.selectedModel;
    if (selected !== undefined && (!selected || typeof selected !== 'object' ||
        typeof selected.conversationId !== 'string' || typeof selected.model !== 'string' ||
        !/^[a-zA-Z0-9 ._~:/@-]{1,160}$/.test(selected.model) || !Number.isFinite(selected.observedAt))) {
      delete publicSummary.selectedModel;
    } else if (selected?.apiProvider !== undefined && !isApiProviderSettings(selected.apiProvider)) {
      delete selected.apiProvider;
    }
    const lastToolActivity = publicSummary.lastToolActivity;
    if (lastToolActivity !== undefined && lastToolActivity !== null && (
      typeof lastToolActivity !== 'object' ||
      typeof lastToolActivity.title !== 'string' ||
      lastToolActivity.title.length === 0 ||
      lastToolActivity.title.length > 200 ||
      !/^(?:edit|create|delete|move|read|search|browse|run|process|screen|input|clipboard|session|agent|other)$/.test(lastToolActivity.kind)
    )) delete publicSummary.lastToolActivity;
    const assignment = publicSummary.workerAssignment;
    if (assignment !== undefined && (!assignment || typeof assignment.conversationId !== 'string' ||
        typeof assignment.agentId !== 'string' || typeof assignment.label !== 'string' || assignment.label.length > 60 ||
        typeof assignment.task !== 'string' || assignment.task.length > 8200 || !Number.isFinite(assignment.recordedAt))) {
      delete publicSummary.workerAssignment;
    }
    const finish = publicSummary.finishTurn;
    if (finish !== undefined && finish !== null && (!finish || typeof finish !== 'object' ||
        typeof finish.turnId !== 'string' || !Number.isFinite(finish.startedAt) ||
        typeof finish.notified !== 'boolean' || typeof finish.released !== 'boolean' ||
        !Number.isSafeInteger(finish.workSeq) || finish.workSeq < 0 || !Number.isSafeInteger(finish.decisionSeq) || finish.decisionSeq < 0 ||
        !(finish.decisionInputRevision === null || (typeof finish.decisionInputRevision === 'string' && /^[a-f0-9]{64}$/.test(finish.decisionInputRevision))) ||
        !(finish.conversationId === null || typeof finish.conversationId === 'string') ||
        !(finish.decisionRevision === null || /^[a-f0-9]{64}$/.test(finish.decisionRevision)))) delete publicSummary.finishTurn;

    // A meta.json written before agents, app-opened chats or the session lineage existed has no such field. A session recorded before the lineage was a single chat by definition, and everything it holds was in that chat's context, so both defaults are the truth rather than a placeholder.
    const outcomeCountersMissing =
      typeof publicSummary.processExitNonzero !== 'number' ||
      typeof publicSummary.toolRejected !== 'number' ||
      typeof publicSummary.toolInternalErrors !== 'number';
    const activityBoundaryMissing = !Object.prototype.hasOwnProperty.call(publicSummary, 'lastAssistantFinalAt');
    return {
      historySeq,
      canonicalProjectionCurrent: canonicalProjection === 1,
      tokenEstimateCurrent: tokenEstimate === 1,
      outcomeCountersMissing,
      activityBoundaryMissing,
      summary: {
        ...publicSummary,
        // Keep in-place increments numeric until the forced rebuild supplies the real values.
        processExitNonzero: publicSummary.processExitNonzero ?? 0,
        toolRejected: publicSummary.toolRejected ?? 0,
        toolInternalErrors: publicSummary.toolInternalErrors ?? 0,
        // A two-minute display clock is not worth replaying every legacy session during the attachment-catalog scan. The next real tool call sets the exact value immediately.
        lastToolCallAt:
          typeof publicSummary.lastToolCallAt === 'number' && Number.isFinite(publicSummary.lastToolCallAt)
            ? publicSummary.lastToolCallAt
            : null,
        lastToolActivity: publicSummary.lastToolActivity ?? null,
        lastAssistantFinalAt:
          typeof publicSummary.lastAssistantFinalAt === 'number' && Number.isFinite(publicSummary.lastAssistantFinalAt)
            ? publicSummary.lastAssistantFinalAt
            : null,
        lastTurnEndAt:
          typeof publicSummary.lastTurnEndAt === 'number' && Number.isFinite(publicSummary.lastTurnEndAt)
            ? publicSummary.lastTurnEndAt
            : null,
        lastFinishReportAt:
          typeof publicSummary.lastFinishReportAt === 'number' && Number.isFinite(publicSummary.lastFinishReportAt)
            ? publicSummary.lastFinishReportAt
            : null,
        agents: Array.isArray(publicSummary.agents) ? publicSummary.agents : [],
        origin: publicSummary.origin ?? null,
        chatIds: Array.isArray(publicSummary.chatIds)
          ? publicSummary.chatIds
          : publicSummary.conversationId
            ? [publicSummary.conversationId]
            : [],
        contextTokens:
          typeof publicSummary.contextTokens === 'number' ? publicSummary.contextTokens : publicSummary.estimatedTokens,
        // Older summaries predate successful-resume provenance. Missing means unknown, never "use lastHandoffId": capture publication happens before the continuation rebind.
        lastCommittedResumeHandoffId:
          typeof publicSummary.lastCommittedResumeHandoffId === 'string' &&
          /^[0-9a-z-]{8,64}$/i.test(publicSummary.lastCommittedResumeHandoffId)
            ? publicSummary.lastCommittedResumeHandoffId
            : null
      }
    };
  } catch {
    return null;
  }
}

// Reads one metadata file, separating the three answers a caller has to tell apart. `absent` is a session that never wrote this file. `damaged` is bytes that are there and are not a projection of this session — truncated by an unclean shutdown, or belonging to another id after a folder was copied. `unreadable` is the filesystem refusing right now, which says nothing at all about the content and must never be answered as if the file were empty.
async function readMetaFile(
  id: string,
  file: string
): Promise<{ checkpoint: MetaCheckpoint } | { checkpoint: null; state: 'absent' | 'damaged'; }
  | { checkpoint: null; state: 'unreadable'; error: NodeJS.ErrnoException }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    // Same reasoning as the journal above: there is no projection under a file.
    if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR') return { checkpoint: null, state: 'absent' };
    return { checkpoint: null, state: 'unreadable', error: failure };
  }
  const checkpoint = normalizeSummary(id, raw);
  return checkpoint ? { checkpoint } : { checkpoint: null, state: 'damaged' };
}

// The durable projection of one session, or a truthful refusal. Returning null here means "this session has no metadata on disk", and every caller acts on that: the catalog drops the row, `getSession()` reports no such session, `ensureOpen()` declares the session unrecoverable. A read that merely *failed* cannot support any of those conclusions, and a burst of them supports them least of all — the catalog sweep reads 64 folders at once, so one lock storm or one exhausted file-descriptor table used to erase whole pages of somebody's history from the app while the files sat intact on disk. Report what actually happened: absent and damaged answer null, unreadable throws.
async function readMetaCheckpoint(id: string, historySeq = 0): Promise<MetaCheckpoint | null> {
  // `historySeq` only decides whether an absence is worth a word. A caller that has not counted the history passes nothing: damaged metadata is still reported, an empty folder still is not.
  const dir = sessionDirectory(id);
  const primary = await readMetaFile(id, path.join(dir, 'meta.json'));
  if (primary.checkpoint) return primary.checkpoint;

  // A damaged or absent primary is exactly what the backup exists for, and a primary that could not be read is worth a second opinion too: if the checkpoint answers, the session opens instead of failing over a file nobody needed.
  const backup = await readMetaFile(id, path.join(dir, 'meta.backup.json'));
  if (backup.checkpoint) {
    logWarn(`session ${id}: meta.json ${primary.state}; using the last validated checkpoint`);
    return backup.checkpoint;
  }

  const failure = primary.checkpoint === null && primary.state === 'unreadable' ? primary.error
    : backup.checkpoint === null && backup.state === 'unreadable' ? backup.error
      : null;
  if (failure) {
    throw new Error(`Session ${id} metadata could not be read (${failure.code ?? failure.message})`);
  }
  // A folder with no metadata and no history is not a session refusing to be empty — it is an empty folder, and saying otherwise is how this line reached two bug reports about data that was never at risk. Measured from a reporter's log on 2026-09-25: the same pair of warnings every few minutes for hours, both files simply absent, nothing lost and nothing to do. Metadata gone while history remains is the case worth a word, and the rebuild below says so.
  if (historySeq > 0 || primary.state !== 'absent' || backup.state !== 'absent') {
    logWarn(
      `session ${id}: meta.json ${primary.state}, meta.backup.json ${backup.state}; ` +
        'refusing to treat it as an empty session'
    );
  }
  return null;
}

async function readMeta(id: string): Promise<SessionSummary | null> {
  return (await readMetaCheckpoint(id))?.summary ?? null;
}

// A cold sidebar needs metadata, not every retained message body. A validated modern checkpoint can prove that its projection follows all history writes: the journal and legacy map are files, while canonical shards are replaced by rename, which changes their directory's timestamp. Read the checkpoint timestamp BEFORE its contents so a concurrent atomic metadata replacement can only make this test conservative. Equal clocks, old schemas, unreadable metadata and any newer history keep the existing full recovery path. No guessed summary is allowed to suppress crash reconciliation.
async function readCatalogSummary(id: string): Promise<SessionSummary | null> {
  const dir = sessionDirectory(id);
  try {
    const metadata = await fs.stat(path.join(dir, 'meta.json'));
    const checkpoint = normalizeSummary(id, await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    if (checkpoint && checkpoint.historySeq !== null && checkpoint.canonicalProjectionCurrent && checkpoint.tokenEstimateCurrent &&
        !checkpoint.outcomeCountersMissing && !checkpoint.activityBoundaryMissing && checkpoint.summary.finishTurn !== undefined && !legacyContextTitle(checkpoint.summary) &&
        // Old Plan helpers and project page titles are repaired by the full read below, once.
        !legacyLabelPending(checkpoint.summary)) {
      const mutations = await Promise.all(['events.jsonl', 'messages.json', 'messages'].map(async name => {
        try { return (await fs.stat(path.join(dir, name))).mtimeMs; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
      }));
      if (metadata.mtimeMs > 0 && mutations.every(at => at < metadata.mtimeMs)) return checkpoint.summary;
    }
  } catch { /* Existing full reconstruction owns missing/corrupt/uncertain checkpoints. */ }
  return (await readDurableSnapshotOf(id))?.summary ?? null;
}

// Filesystem time of the newest durable mutation belonging to a session. Session event timestamps describe when an action happened, not when it finally reached disk. A five-minute MCP call therefore appends today with a `startedAt` from five minutes ago. Stale/orphan cleanup must not look only at that semantic clock and immediately retire work that was just written. The max mtime of the three mutable session projections is the durable inactivity clock it needs.
async function sessionDurableModifiedAt(id: string): Promise<number | null> {
  assertSessionId(id);
  let newest = 0;
  for (const name of ['events.jsonl', 'messages.json', 'messages', 'meta.json']) {
    try {
      const stat = await fs.stat(path.join(sessionDirectory(id), name));
      newest = Math.max(newest, stat.mtimeMs);
    } catch {
      // A session can legitimately predate messages.json or have no structured events yet.
    }
  }
  return newest > 0 ? newest : null;
}

async function getSession(id: string): Promise<SessionSummary | null> {
  assertSessionId(id);
  const summary = await readAuthoritativeSummaryOf(id);
  return summary ? { ...summary } : null;
}

/** Positive absence for retiring an exact delivered receipt, never corrupt metadata. */
async function sessionDirectoryMissing(id: string): Promise<boolean> {
  assertSessionId(id);
  const dir = sessionDirectory(id);
  if (hasLiveSession(id)) return false;
  try {
    await fs.lstat(dir);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  // An unavailable history root is not evidence that the user removed this session.
  try {
    return (await fs.stat(rootPath())).isDirectory() && !hasLiveSession(id);
  } catch { return false; }
}


  return { getSession, readCatalogSummary, readMeta, readMetaCheckpoint, sessionDirectoryMissing, sessionDurableModifiedAt };
}
