import type { SessionSummary } from '../../../../contracts/session.js';
import { refreshUserTitle } from './title.js';
import type { CanonicalEvent } from './session-canonical-messages.js';

type Checkpoint = {
  summary: SessionSummary;
  historySeq: number | null;
  canonicalProjectionCurrent: boolean;
  tokenEstimateCurrent: boolean;
  outcomeCountersMissing: boolean;
  activityBoundaryMissing: boolean;
};

export interface DurableSessionSnapshot {
  summary: SessionSummary;
  messages: Map<string, CanonicalEvent>;
  historySeq: number;
  reconciled: boolean;
}

type Runtime = {
  assertSessionId(id: string): void;
  readCanonicalMessages(id: string, onAliasCollapsed: () => void): Promise<Map<string, CanonicalEvent>>;
  lastSeqOnDisk(id: string): Promise<number>;
  readMetaCheckpoint(id: string, historySeq: number): Promise<Checkpoint | null>;
  writeSummary(summary: SessionSummary, historySeq: number): Promise<void>;
  rebuildSummaryFromHistory(
    id: string,
    messages: Map<string, CanonicalEvent>,
    checkpoint: SessionSummary | null,
    historySeq: number,
    preserveAttachmentTurn?: boolean,
    migrateTokenEstimate?: boolean
  ): Promise<SessionSummary>;
};

export function createSessionDurableSnapshotReader(runtime: Runtime) {
  const reconciling = new Map<string, Promise<DurableSessionSnapshot | null>>();

  async function readDurableSnapshot(id: string): Promise<DurableSessionSnapshot | null> {
    runtime.assertSessionId(id);
    const existing = reconciling.get(id);
    if (existing) return existing;
    const work = (async () => {
      let aliasesCollapsed = false;
      const messages = await runtime.readCanonicalMessages(id, () => { aliasesCollapsed = true; });
      let messageSeq = 0;
      for (const event of messages.values()) messageSeq = Math.max(messageSeq, event.seq);
      const journalSeq = await runtime.lastSeqOnDisk(id);
      const historySeq = Math.max(journalSeq, messageSeq);
      const checkpoint = await runtime.readMetaCheckpoint(id, historySeq);
      const titleRepaired = checkpoint ? refreshUserTitle(checkpoint.summary, messages.values()) : false;

      // A pre-taxonomy checkpoint can have a current watermark but stale outcome classification.
      if (
        checkpoint?.historySeq === historySeq &&
        checkpoint.tokenEstimateCurrent &&
        (!aliasesCollapsed || checkpoint.canonicalProjectionCurrent) &&
        !checkpoint.outcomeCountersMissing &&
        !checkpoint.activityBoundaryMissing &&
        checkpoint.summary.timelineTurns !== undefined &&
        checkpoint.summary.requestTurns !== undefined &&
        checkpoint.summary.nativeQuestion !== undefined &&
        checkpoint.summary.finishTurn !== undefined
      ) {
        // A successful no-op migration is still complete; stamp it to avoid replaying unchanged history on every launch.
        const migrated = !checkpoint.canonicalProjectionCurrent || titleRepaired;
        if (migrated) await runtime.writeSummary(checkpoint.summary, historySeq);
        return { summary: checkpoint.summary, messages, historySeq, reconciled: migrated };
      }
      if (checkpoint && historySeq === 0) {
        // Nothing needs replay; stamp the empty legacy projection in place.
        const summary = {
          ...checkpoint.summary,
          ...(checkpoint.outcomeCountersMissing ? { errors: 0 } : {}),
          timelineTurns: {},
          nativeQuestion: null,
          requestTurns: {},
          lastToolCallAt: null,
          lastAssistantFinalAt: null,
          lastTurnEndAt: null,
          lastFinishReportAt: null,
          finishTurn: null
        };
        await runtime.writeSummary(summary, 0);
        return { summary, messages, historySeq: 0, reconciled: true };
      }
      if (!checkpoint && historySeq === 0) return null;

      const summary = await runtime.rebuildSummaryFromHistory(
        id,
        messages,
        checkpoint?.summary ?? null,
        historySeq,
        checkpoint?.historySeq === historySeq,
        !!checkpoint && !checkpoint.tokenEstimateCurrent
      );
      return { summary, messages, historySeq, reconciled: true };
    })();
    reconciling.set(id, work);
    try {
      return await work;
    } finally {
      if (reconciling.get(id) === work) reconciling.delete(id);
    }
  }

  function reset(): void {
    reconciling.clear();
  }

  return { readDurableSnapshot, reset };
}
