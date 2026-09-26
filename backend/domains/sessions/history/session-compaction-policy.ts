import { isProModel } from '../../../../contracts/model-capabilities.js';
import type { SessionSummary } from '../../../../contracts/session.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import type { OpenSession } from './store.js';

type Runtime = {
  ensureOpen(id: string): Promise<OpenSession>;
  enqueueSessionOperation<T>(entry: OpenSession, label: string, operation: () => Promise<T>): Promise<T>;
  writeSummary(summary: SessionSummary, historySeq: number): Promise<void>;
  publishAttachmentSummary(summary: SessionSummary): void;
};

export function createSessionCompactionPolicy(runtime: Runtime) {
  // Automatic compaction uses a level rather than a threshold crossing so interrupted turns cannot erase the trigger and completed work is not handed off after it is done. Live work remains a browser fact checked at the call site, while the durable continuation transaction owns any handoff attempt.
  function automaticCompactionAllowed(summary?: SessionSummary | null): boolean {
    const config = getConfig();
    const selected = summary?.selectedModel;
    // The selected model owns this exemption; Infinite Astra with Sol still compacts.
    return config.compaction.auto &&
      !(selected?.conversationId === summary?.conversationId && isProModel(selected?.model, selected?.reasoningEffort));
  }

  // A stored refusal blocks the refused turn, but active work without a page turn may qualify again after its earlier ticket was abandoned.
  function autoCompactionReady(
    summary: SessionSummary | null | undefined,
    working = false
  ): boolean {
    if (!summary) return false;
    const refusal = summary.autoCompactionRefusal;
    // Further evidence from a running refused turn cannot buy another ticket behind the draft that rejected the first.
    if (refusal?.conversationId === summary.conversationId &&
        (summary.activeTurnId ? summary.activeTurnId === refusal.turnId : !working)) return false;
    const config = getConfig().compaction;
    return automaticCompactionAllowed(summary) && config.autoTokens > 0 && summary.contextTokens >= config.autoTokens;
  }

  // Persist eligibility before retiring the ticket so a restart cannot refile the refused turn.
  async function refuseAutomaticCompactionNow(id: string, conversationId: string, turnId: string | null): Promise<void> {
    const entry = await runtime.ensureOpen(id);
    await runtime.enqueueSessionOperation(entry, 'automatic compaction refusal', async () => {
      if (entry.summary.conversationId !== conversationId ||
          (entry.summary.activeTurnId && entry.summary.activeTurnId !== turnId)) return;
      const staged = { ...entry.summary, autoCompactionRefusal: { conversationId, turnId } };
      await runtime.writeSummary(staged, entry.historySeq);
      entry.summary = staged;
      runtime.publishAttachmentSummary(staged);
    });
  }

  return { automaticCompactionAllowed, autoCompactionReady, refuseAutomaticCompactionNow };
}
