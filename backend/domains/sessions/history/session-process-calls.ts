import type { AssetRef, SessionEvent } from '../../../../contracts/session.js';
import { eventTokens } from '../../../../contracts/session.js';
import { applyToSummary } from './session-summary-projection.js';
import type { CanonicalEvent, OpenSession } from './store.js';

type ProcessCall = Extract<SessionEvent, { kind: 'tool_call' }>;

type Runtime = {
  ensureOpen(sessionId: string): Promise<OpenSession>;
  enqueueSessionOperation<T>(entry: OpenSession, label: string, operation: () => Promise<T>): Promise<T>;
  messageKey(event: SessionEvent): string | null;
  admittedAssets(sessionId: string, assets: readonly AssetRef[] | undefined): AssetRef[] | undefined;
  deniedAssetIds(sessionId: string, assets: readonly AssetRef[] | undefined): string[];
  mergedRetiredAssetIds(...groups: Array<readonly string[] | undefined>): string[] | undefined;
  writeCanonicalMessage(id: string, key: string, event: CanonicalEvent): Promise<void>;
  scheduleMeta(entry: OpenSession): void;
};

export function createSessionProcessCalls(runtime: Runtime) {
  async function recordProcessCall(sessionId: string, event: Omit<ProcessCall, 'seq'>): Promise<void> {
    const entry = await runtime.ensureOpen(sessionId);
    await runtime.enqueueSessionOperation(entry, 'process call', async () => {
      const key = runtime.messageKey({ ...event, seq: 0 })!;
      if (entry.messages.has(key)) throw new Error('Process call identity already recorded');
      const denied = runtime.deniedAssetIds(sessionId, event.call.assets);
      const full = {
        ...event,
        call: {
          ...event.call,
          assets: runtime.admittedAssets(sessionId, event.call.assets),
          retiredImageAssetIds: runtime.mergedRetiredAssetIds(event.call.retiredImageAssetIds, denied)
        },
        seq: entry.nextSeq,
        origin: entry.nextSeq
      };
      await runtime.writeCanonicalMessage(sessionId, key, full);
      entry.messages.set(key, full);
      entry.nextSeq += 1;
      entry.historySeq = full.seq;
      applyToSummary(entry.summary, full);
      runtime.scheduleMeta(entry);
    });
  }

  // Process exit revises its launch; it is not a tool invocation, output receipt, or turn boundary.
  async function completeProcessCall(sessionId: string, callId: string, completion: {
    completedAt: number;
    durationMs: number;
    exitCode: number | null;
    benignExit?: boolean;
  }): Promise<void> {
    const entry = await runtime.ensureOpen(sessionId);
    await runtime.enqueueSessionOperation(entry, 'process completion', async () => {
      const key = `tool_call\u0000${callId}`;
      const previous = entry.messages.get(key);
      if (previous?.kind !== 'tool_call' || !previous.call.process || previous.call.process.completedAt !== undefined) return;
      const { exitCode } = completion;
      const failed = exitCode !== null && exitCode !== 0 && completion.benignExit !== true;
      const full: ProcessCall = {
        ...previous,
        seq: entry.nextSeq,
        call: {
          ...previous.call,
          process: { ...previous.call.process, ...completion },
          summary: {
            ...previous.call.summary,
            title: previous.call.summary.title.replace(/^Started /, failed ? 'Command failed ' : 'Completed '),
            metric: exitCode === null ? 'finished (exit unknown)' : failed ? `✕ exit ${exitCode}` : '✓ finished',
            tone: exitCode === null ? 'warn' : failed ? 'bad' : 'good'
          }
        }
      };
      await runtime.writeCanonicalMessage(sessionId, key, full);
      entry.messages.set(key, full);
      entry.nextSeq += 1;
      entry.historySeq = full.seq;
      const delta = eventTokens(full) - eventTokens(previous);
      entry.summary.estimatedTokens = Math.max(0, entry.summary.estimatedTokens + delta);
      if (full.call.conversationId === entry.summary.conversationId)
        entry.summary.contextTokens = Math.max(0, entry.summary.contextTokens + delta);
      runtime.scheduleMeta(entry);
    });
  }

  return { recordProcessCall, completeProcessCall };
}
