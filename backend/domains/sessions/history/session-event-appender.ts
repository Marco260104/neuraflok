import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AssetRef, NewSessionEvent, SessionEvent } from '../../../../contracts/session.js';
import type { OpenSession } from './store.js';
import { applyToSummary } from './session-summary-projection.js';

type Runtime = {
  ensureOpen(sessionId: string): Promise<OpenSession>;
  sessionDirectory(sessionId: string): string;
  deniedAssetIds(sessionId: string, assets: readonly AssetRef[] | undefined): string[];
  admittedAssets(sessionId: string, assets: readonly AssetRef[] | undefined): AssetRef[] | undefined;
  mergedRetiredAssetIds(...groups: Array<readonly string[] | undefined>): string[] | undefined;
  sealTornTail(sessionId: string): Promise<void>;
  lastSeqOnDisk(sessionId: string): Promise<number>;
  scheduleMeta(entry: OpenSession): void;
  maxEventTail: number;
  maxLineBytes: number;
  warn(message: string): void;
  error(message: string): void;
};

export function createSessionEventAppender(runtime: Runtime) {
  function appendEvent(sessionId: string, event: NewSessionEvent): Promise<SessionEvent> {
    return runtime.ensureOpen(sessionId).then((entry) => {
      // Persist the sequenced journal row before mutating the live projection.
      const write = entry.queue.then(async () => {
        let admitted = event;
        if (event.kind === 'tool_call') {
          const denied = runtime.deniedAssetIds(sessionId, event.call.assets);
          admitted = { ...event, call: {
            ...event.call,
            assets: runtime.admittedAssets(sessionId, event.call.assets),
            ...(denied.length ? { retiredImageAssetIds: runtime.mergedRetiredAssetIds(event.call.retiredImageAssetIds, denied) } : {})
          } };
        } else if (event.kind === 'user_message') {
          const denied = runtime.deniedAssetIds(sessionId, event.assets);
          admitted = {
            ...event,
            assets: runtime.admittedAssets(sessionId, event.assets),
            ...(denied.length ? { retiredImageAssetIds: runtime.mergedRetiredAssetIds(event.retiredImageAssetIds, denied) } : {})
          };
        }
        const full = { ...admitted, seq: entry.nextSeq } as SessionEvent;
        const line = `${JSON.stringify(full)}\n`;
        if (Buffer.byteLength(line, 'utf8') > runtime.maxLineBytes) {
          throw new Error('Session event is too large to store');
        }
        try {
          await fs.appendFile(path.join(runtime.sessionDirectory(sessionId), 'events.jsonl'), line, 'utf8');
        } catch (error) {
          // Windows/filesystem errors may be uncertain commits; reconcile the durable tail before admitting another queued writer.
          await runtime.sealTornTail(sessionId);
          // Preserve the append error when reconciliation cannot read the tail; zero cannot lower the current sequence.
          const durableSeq = await runtime.lastSeqOnDisk(sessionId).catch(() => 0);
          if (durableSeq < full.seq) {
            entry.nextSeq = Math.max(entry.nextSeq, durableSeq + 1);
            throw error;
          }
          runtime.warn(`session ${sessionId}: append reported an error after sequence ${full.seq} was already durable`);
        }
        entry.nextSeq += 1;
        entry.tail.push(full);
        if (entry.tail.length > runtime.maxEventTail) {
          const removed = entry.tail.splice(0, entry.tail.length - runtime.maxEventTail);
          entry.tailFrom = removed[removed.length - 1]!.seq + 1;
        }
        applyToSummary(entry.summary, full);
        entry.historySeq = full.seq;
        runtime.scheduleMeta(entry);
        return full;
      });
      entry.queue = write.then(
        () => undefined,
        (err: Error) => {
          runtime.error(`session append failed: ${err.message}`);
        }
      );
      return write;
    });
  }

  return { appendEvent };
}
