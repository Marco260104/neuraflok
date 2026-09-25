import { getConfig } from '../../infrastructure/settings/config.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { continuationForSession, openContinuationNow } from '../sessions/continuity/continuation.js';
import {
  autoCompactionReady,
  automaticCompactionAllowed,
  conversationWasSuperseded,
  getSession
} from '../sessions/history/store.js';
import { activeUntil } from './session-activity.js';

type Runtime = {
  goalFencedChat: (conversationId: string) => boolean;
  stopRequestedFor: (conversationId: string) => boolean;
  liveTurnIsCurrent: (conversationId: string, now: number) => boolean;
  failedCompactionTurnCurrent: (conversationId: string, sessionId: string, turnId: string) => Promise<boolean>;
  rememberToken: (sessionId: string, token: string) => void;
  changed: () => void;
};

// Owns automatic compaction admission and its per-conversation filing lock.
export function createBridgeAutomaticCompaction(runtime: Runtime) {
  const compactionFilings = new Set<string>();

  async function considerAutomaticCompaction(conversationId: string, sessionId: string, failedTurn?: string): Promise<void> {
    if (!getConfig().compaction.auto || compactionFilings.has(conversationId)) return;
    if (runtime.goalFencedChat(conversationId) || continuationForSession(sessionId) || runtime.stopRequestedFor(conversationId)) return;
    // Recheck call-backed activity after awaits so stale evidence cannot authorize compaction.
    const hasCurrentWork = (): boolean => {
      const grant = activeUntil.get(conversationId);
      const now = Date.now();
      return runtime.liveTurnIsCurrent(conversationId, now) || Boolean(grant?.sessionId === sessionId && grant.mcpBacked &&
        !grant.thinkingFailed && grant.evidenceAt <= now && grant.until > now);
    };
    if (!failedTurn && !hasCurrentWork()) return;
    compactionFilings.add(conversationId);
    try {
      const summary = await getSession(sessionId).catch(() => null);
      if (!summary || summary.conversationId !== conversationId || summary.endedAt !== null || summary.browserRecoveryDismissedAt !== undefined || !autoCompactionReady(summary, hasCurrentWork())) return;
      if (await conversationWasSuperseded(conversationId)) return;
      if (failedTurn && !await runtime.failedCompactionTurnCurrent(conversationId, sessionId, failedTurn)) return;
      // Re-read after the awaits: the turn may have ended, or a page may have filed by hand.
      const current = await getSession(sessionId);
      if (!current || current.conversationId !== conversationId || current.endedAt !== null || current.browserRecoveryDismissedAt !== undefined || !autoCompactionReady(current, hasCurrentWork())) return;
      if (failedTurn && !await runtime.failedCompactionTurnCurrent(conversationId, sessionId, failedTurn)) return;
      if ((!failedTurn && !hasCurrentWork()) || continuationForSession(sessionId) || runtime.goalFencedChat(conversationId) ||
          runtime.stopRequestedFor(conversationId) || !getConfig().compaction.auto || !automaticCompactionAllowed(current)) return;
      const opened = await openContinuationNow(sessionId, conversationId, true);
      runtime.rememberToken(sessionId, opened.token);
      runtime.changed();
      logInfo(
        `bridge: ${conversationId} ${failedTurn ? 'lost its current turn' : 'is working'} at ${current.contextTokens} context tokens — filed auto-compaction ticket ${opened.token.slice(0, 8)}`
      );
    } catch (err) {
      logWarn(`bridge: could not file the auto-compaction ticket for ${conversationId} — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      compactionFilings.delete(conversationId);
    }
  }

  return { considerAutomaticCompaction, compactionFilings };
}
