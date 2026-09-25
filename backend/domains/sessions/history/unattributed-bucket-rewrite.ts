import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SessionEvent, SessionSummary } from '../../../../contracts/session.js';
import { logError } from '../../../infrastructure/settings/logger.js';
import { applyToSummary } from './session-summary-projection.js';
import type { OpenSession } from './store.js';

type ToolCallEvent = Extract<SessionEvent, { kind: 'tool_call' }>;

type Runtime = {
  assertSessionId(id: string): void;
  ensureOpen(id: string): Promise<OpenSession>;
  sessionDir(id: string): string;
  maxEventTail: number;
  writeSummary(summary: SessionSummary, historySeq: number): Promise<void>;
  deleteCurrentSession(id: string, entry: OpenSession): void;
  invalidateAssetUsage(id: string): void;
  publishAttachmentRemoval(id: string): void;
};

export function createUnattributedBucketRewrite(runtime: Runtime) {
  async function rewriteUnattributedToolCalls(
    sessionId: string,
    calls: readonly ToolCallEvent[],
    scannedThroughSeq: number,
    deleteEmpty = false
  ): Promise<{ retained: number; deleted: boolean }> {
    runtime.assertSessionId(sessionId);
    const entry = await runtime.ensureOpen(sessionId);
    const rewrite = entry.queue.then(async () => {
      if (entry.summary.conversationId !== null || entry.summary.title !== 'Unattributed activity') {
        throw new Error(`Session ${sessionId} is not an Unattributed activity bucket`);
      }

      // The repair snapshot can become stale while assets are copied. Read the serialized journal and retain every tool call appended after its high-water mark; later appends wait behind this queue operation.
      const concurrentCalls: ToolCallEvent[] = [];
      try {
        const raw = await fs.readFile(path.join(runtime.sessionDir(sessionId), 'events.jsonl'), 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as SessionEvent;
            if (event.kind === 'tool_call' && event.seq > scannedThroughSeq) concurrentCalls.push(event);
          } catch {
            // Ignore malformed legacy rows already excluded by the deterministic repair snapshot.
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const start: SessionEvent = {
        seq: 1,
        time: entry.summary.startedAt,
        source: 'app',
        kind: 'session_start',
        conversationId: null,
        title: entry.summary.title
      };
      const retainedCalls = [...calls, ...concurrentCalls].sort((left, right) => left.seq - right.seq);
      // A live call may still hold this bucket id while preparing assets outside the queue. Only the recorder can prove the bucket is inactive; keep the empty check, concurrent-row capture, and deletion in this serialized operation.
      if (deleteEmpty && retainedCalls.length === 0 && entry.queue === settled) {
        if (entry.metaTimer) clearTimeout(entry.metaTimer);
        await fs.rm(runtime.sessionDir(sessionId), { recursive: true, force: true });
        runtime.deleteCurrentSession(sessionId, entry);
        runtime.invalidateAssetUsage(sessionId);
        runtime.publishAttachmentRemoval(sessionId);
        return { retained: 0, deleted: true };
      }
      const kept: SessionEvent[] = [start, ...retainedCalls.map((event, index) => ({ ...event, seq: index + 2 }))];
      const target = path.join(runtime.sessionDir(sessionId), 'events.jsonl');
      const tmp = `${target}.repair-${process.pid}-${Date.now()}.tmp`;
      await fs.writeFile(tmp, kept.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
      await fs.rename(tmp, target);

      const staged: SessionSummary = {
        ...entry.summary,
        updatedAt: entry.summary.startedAt,
        events: 0,
        requestTurns: {},
        userMessages: 0,
        toolCalls: 0,
        lastToolCallAt: null,
        lastToolActivity: null,
        lastAssistantFinalAt: null,
        lastTurnEndAt: null,
        lastFinishReportAt: null,
        processExitNonzero: 0,
        toolRejected: 0,
        toolInternalErrors: 0,
        errors: 0,
        estimatedTokens: 0,
        contextTokens: 0,
        lastHandoffId: null,
        lastHandoffAt: null,
        lastCommittedResumeHandoffId: null,
        lastTurnOutcome: null,
        agents: []
      };
      for (const event of kept) applyToSummary(staged, event);
      const rewrittenHistorySeq = kept.at(-1)?.seq ?? 0;
      await runtime.writeSummary(staged, rewrittenHistorySeq);

      Object.assign(entry.summary, staged);
      entry.nextSeq = kept.length + 1;
      entry.historySeq = rewrittenHistorySeq;
      entry.tail = kept.slice(-runtime.maxEventTail);
      entry.tailFrom = entry.tail[0]?.seq ?? entry.nextSeq;
      entry.activityHydrated = true;
      entry.metaDirty = false;
      return { retained: retainedCalls.length, deleted: false };
    });
    const settled = rewrite.then(
      () => undefined,
      (err: Error) => logError(`session unattributed repair failed: ${err.message}`)
    );
    entry.queue = settled;
    return rewrite;
  }

  return { rewriteUnattributedToolCalls };
}
