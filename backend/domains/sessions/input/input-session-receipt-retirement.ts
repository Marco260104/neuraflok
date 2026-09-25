import type * as SessionHistory from '../history/store.js';
import type { InputEntry } from './input-schema.js';

type Runtime = {
  sessionDirectoryMissing: typeof SessionHistory.sessionDirectoryMissing;
  needsHistory: (row: InputEntry) => boolean;
  pendingStages: (row: InputEntry) => boolean;
  commit: (next: InputEntry[]) => Promise<void>;
};

export function createInputSessionReceiptRetirement(runtime: Runtime) {
  async function retireRemovedSessionReceipts(current: InputEntry[], pendingOnly = false): Promise<InputEntry[]> {
    const missing = new Map<string, boolean>();
    const removed = new Set<string>();
    for (const row of current) {
      const sessionId = row.sessionId ?? row.deliveredSessionId;
      if (!sessionId || row.purpose === 'decision' || !['sent', 'cancelled'].includes(row.state) ||
          !row.messageId || !Number.isFinite(row.deliveredAt) ||
          (pendingOnly && !runtime.needsHistory(row) && !runtime.pendingStages(row))) continue;
      if (!missing.has(sessionId)) missing.set(sessionId, await runtime.sessionDirectoryMissing(sessionId));
      if (missing.get(sessionId)) removed.add(row.id);
    }
    // A combined delivery keeps both originals until both can be retired together.
    for (const row of current) {
      if (row.companionInputId && removed.has(row.id) !== removed.has(row.companionInputId)) {
        removed.delete(row.id); removed.delete(row.companionInputId);
      }
    }
    if (!removed.size) return current;
    const next = current.filter(row => !removed.has(row.id));
    await runtime.commit(next);
    return next;
  }

  return { retireRemovedSessionReceipts };
}
