import { manualInput } from '../../../../contracts/input.js';
import type * as SessionHistory from '../history/store.js';
import type { InputEntry } from './input-schema.js';
import { neverAuthorized, terminal } from './input-admission.js';

type Runtime = {
  findSessionByConversation: typeof SessionHistory.findSessionByConversation;
  getSession: typeof SessionHistory.getSession;
  deleteSession: typeof SessionHistory.deleteSession;
  assignSessionProject: (sessionId: string, projectId: string) => Promise<void>;
  materializeOpening: (entry: InputEntry) => Promise<void>;
  changed: () => void;
};

export function createInputOpeningLifecycle(runtime: Runtime) {
  async function migrateLegacyOpeningOwners(current: InputEntry[]): Promise<boolean> {
    let changed = false;
    for (let index = 0; index < current.length; index++) {
      const row = current[index]!;
      const combined = !!row.companionInputId || current.some(root => root.companionInputId === row.id);
      const ordinaryOpening = !row.opening && row.sessionId === null && row.deliveredSessionId == null &&
        row.deliveredAt === undefined && !row.messageId && !row.historyAnchored && !row.historyRecorded &&
        manualInput(row) && ['queued', 'browser', 'failed', 'cancelled'].includes(row.state) && !combined;
      if (!ordinaryOpening) continue;

      if (row.conversationId) {
        const exact = await runtime.findSessionByConversation(row.conversationId, { requireUnique: true });
        const projectCompatible = exact && (!row.projectId || !exact.projectId || exact.projectId === row.projectId);
        const ordinaryOwner = projectCompatible && exact.origin?.kind !== 'worker' && exact.origin?.kind !== 'helper';
        if (exact && ordinaryOwner) {
          try {
            if (row.projectId && !exact.projectId) await runtime.assignSessionProject(exact.id, row.projectId);
            const migrated = { ...row, opening: true as const, requestedSessionId: null, sessionId: exact.id };
            await runtime.materializeOpening(migrated);
            current[index] = migrated;
            changed = true;
            continue;
          } catch {
            // Preserve the original row and recover it through an unbound reservation below.
          }
        }
      }

      const migrated = { ...row, opening: true as const, requestedSessionId: null, sessionId: row.id };
      try {
        // Materialize before publishing the migrated row so interrupted writes deterministically reuse the same reservation.
        await runtime.materializeOpening(migrated);
      } catch {
        // Keep a published partial session visible; otherwise leave the legacy row untouched for a safe retry.
        const partial = await runtime.getSession(row.id);
        if (!partial || partial.origin?.kind !== 'desktop' ||
            (partial.conversationId && partial.conversationId !== row.conversationId)) continue;
      }
      current[index] = migrated;
      changed = true;
    }
    return changed;
  }

  async function removeWithdrawnOpening(row: InputEntry, current: InputEntry[]): Promise<void> {
    if (!row.opening || !row.sessionId || row.state !== 'cancelled' ||
        !(row.cancelledByUser || row.error === 'Not sent: this delivery was cancelled before Send was authorized.') ||
        !neverAuthorized(row) || row.deliveredAt !== undefined || row.messageId || row.conversationId ||
        current.some(other => other.id !== row.id && other.sessionId === row.sessionId && !terminal(other))) return;
    const session = await runtime.getSession(row.sessionId);
    if (!session || session.origin?.kind !== 'desktop' || session.conversationId || session.chatIds?.length !== 0 || session.events !== 0) return;
    await runtime.deleteSession(session.id);
    try { runtime.changed(); } catch { /* deletion is already committed */ }
  }

  return { migrateLegacyOpeningOwners, removeWithdrawnOpening };
}
