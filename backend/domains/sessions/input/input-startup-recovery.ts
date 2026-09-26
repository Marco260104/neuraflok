import type * as SessionHistory from '../history/store.js';
import type * as SessionRecorder from '../history/recorder.js';
import type { InputEntry } from './input-schema.js';

type Runtime = {
  migrateLegacyOpeningOwners: (entries: InputEntry[]) => Promise<boolean>;
  terminal: (entry: InputEntry) => boolean;
  materializeOpening: (entry: InputEntry) => Promise<void>;
  commit: (entries: InputEntry[]) => Promise<void>;
  removeWithdrawnOpening: (entry: InputEntry, entries: InputEntry[]) => Promise<void>;
  retireRemovedSessionReceipts: (entries: InputEntry[]) => Promise<InputEntry[]>;
  listUsageSessions: typeof SessionHistory.listUsageSessions;
  noteChatOrigin: typeof SessionRecorder.noteChatOrigin;
  bindHelper: (conversationId: string, sourceSessionId: string | null) => Promise<void> | undefined;
  hasDecisionWaiter: (id: string) => boolean;
  invalidateLoadedState: () => void;
};

export function createInputStartupRecovery(runtime: Runtime) {
  async function recover(entries: InputEntry[]): Promise<InputEntry[]> {
    const legacyOpeningRepair = await runtime.migrateLegacyOpeningOwners(entries);
    let openingRepair = legacyOpeningRepair;
    for (const entry of entries) if (entry.opening && !runtime.terminal(entry)) {
      try {
        await runtime.materializeOpening(entry);
        if (entry.error?.startsWith('Local chat setup failed:')) { delete entry.error; openingRepair = true; }
      } catch (error) {
        entry.error = ('Local chat setup failed: ' + (error as Error).message).slice(0, 200);
        openingRepair = true;
      }
    }
    if (openingRepair) await runtime.commit(entries);
    for (const entry of entries) await runtime.removeWithdrawnOpening(entry, entries);
    try { entries = await runtime.retireRemovedSessionReceipts(entries); }
    catch (error) { runtime.invalidateLoadedState(); throw error; }

    const stamped = new Set<string>();
    const seen = new Set<string>();
    if (entries.some(row => row.conversationId && (row.purpose === 'decision' || (!row.sessionId && row.deliveredAt !== undefined)))) {
      for (const summary of await runtime.listUsageSessions()) {
        if (!summary.conversationId) continue;
        if (seen.has(summary.conversationId)) stamped.delete(summary.conversationId);
        else if (summary.origin) stamped.add(summary.conversationId);
        seen.add(summary.conversationId);
      }
    }
    for (const row of entries) {
      if (row.historyRecorded && row.deliveryText && row.deliveryText !== row.text) row.historyRecorded = false;
      if (!row.sessionId && row.purpose !== 'decision' && row.conversationId && row.deliveredAt !== undefined && !stamped.has(row.conversationId)) {
        await runtime.noteChatOrigin(row.conversationId, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
      }
      if (row.purpose === 'decision' && row.lifetime !== 'temporary-planner' && row.conversationId && !stamped.has(row.conversationId)) {
        await runtime.bindHelper(row.conversationId, row.decisionSourceSessionId ?? null);
      }
    }

    const recovered = entries.map((row): InputEntry => row.purpose === 'decision' && !runtime.terminal(row) && !runtime.hasDecisionWaiter(row.id)
      ? { ...row, state: 'cancelled' } : row);
    if (recovered.some((row, index) => row !== entries[index])) {
      try { await runtime.commit(recovered); }
      catch (error) { runtime.invalidateLoadedState(); throw error; }
    }
    return recovered;
  }

  return { recover };
}
