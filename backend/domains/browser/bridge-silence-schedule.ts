import { isDeliberateEffort, isProModel } from '../../../contracts/model-capabilities.js';
import { CHAT_SILENCE_MS } from '../../../contracts/session.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { getSession } from '../sessions/history/store.js';
import { activeUntil, activityDeadline } from './session-activity.js';
import type { ActivityGrant } from './session-activity.js';

interface Runtime {
  state: { silenceTimer: NodeJS.Timeout | null };
  grantActivity(conversationId: string, sessionId: string, at?: number, window?: number,
    turn?: Pick<ActivityGrant, 'turnId' | 'model' | 'mcpBacked' | 'deliberate'>): void;
  runStaleSwarmSweep(): Promise<unknown>;
  inspectSilentChats(now: number): Promise<{ spent: string[] }>;
  silenceSourceCurrent(conversationId: string, grant: ActivityGrant): Promise<boolean>;
}

export function createBridgeSilenceSchedule(runtime: Runtime) {
  function armSilenceSweep(now = Date.now()): void {
    let earliest = Number.POSITIVE_INFINITY;
    for (const grant of activeUntil.values()) {
      if (grant.until > now) earliest = Math.min(earliest, grant.until);
      const visibleUntil = activityDeadline(grant);
      if (!grant.thinkingFailed && visibleUntil > now) earliest = Math.min(earliest, visibleUntil);
    }
    if (!Number.isFinite(earliest)) {
      if (runtime.state.silenceTimer) clearTimeout(runtime.state.silenceTimer);
      runtime.state.silenceTimer = null;
      return;
    }
    if (runtime.state.silenceTimer) clearTimeout(runtime.state.silenceTimer);
    runtime.state.silenceTimer = setTimeout(() => {
      runtime.state.silenceTimer = null;
      void runtime.inspectSilentChats(Date.now()).then(pass => {
        if (pass.spent.length > 0)
          void runtime.runStaleSwarmSweep().catch(err => logWarn(`stale swarm sweep failed: ${err.message}`));
        armSilenceSweep();
      }).catch(err => logWarn(`silence sweep failed: ${err.message}`));
    }, Math.max(1, earliest - now + 1));
    runtime.state.silenceTimer.unref?.();
  }

  function armResumedChat(sessionId: string, conversationId: string): void {
    runtime.grantActivity(conversationId, sessionId);
    logInfo(`bridge: resumed chat ${conversationId} armed — expecting its first attributed call`);
  }

  async function restoreReturnedPageActivity(conversationId: string, sessionId: string): Promise<void> {
    const session = await getSession(sessionId);
    if (session?.conversationId !== conversationId || session.browserRecoveryDismissedAt !== undefined ||
        !session.activeTurnId || session.lastToolCallAt === null || activeUntil.has(conversationId)) return;
    const selected = session.selectedModel;
    const grant: ActivityGrant = {
      sessionId,
      turnId: session.activeTurnId,
      evidenceAt: session.lastToolCallAt,
      until: session.lastToolCallAt,
      model: selected?.conversationId === conversationId
        ? isProModel(selected.model, selected.reasoningEffort) ? 'pro' : 'other'
        : 'unknown',
      ...(selected?.conversationId === conversationId && isDeliberateEffort(selected.reasoningEffort)
        ? { deliberate: true as const }
        : {}),
      mcpBacked: true
    };
    if (!await runtime.silenceSourceCurrent(conversationId, grant) || activeUntil.has(conversationId)) return;
    runtime.grantActivity(conversationId, sessionId, Math.min(Date.now(), grant.evidenceAt), CHAT_SILENCE_MS, grant);
  }

  function endActivity(conversationId: string): void {
    activeUntil.delete(conversationId);
    armSilenceSweep();
  }

  function forgetActivity(conversationId: string): void {
    activeUntil.delete(conversationId);
    armSilenceSweep();
  }

  return { armSilenceSweep, armResumedChat, restoreReturnedPageActivity, endActivity, forgetActivity };
}
