import { isApiConversationId } from '../../../contracts/chat-protocol.js';
import { CHAT_SILENCE_MS } from '../../../contracts/session.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { providerForConversationId } from '../../../contracts/web-providers.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { activeUntil, sessionActivityExpiresAt } from './session-activity.js';
import type { ActivityGrant } from './session-activity.js';
import { webProviderFlightTurnId } from '../providers/browser-chat.js';
import { apiChatFlightTurnId } from '../providers/api-chat.js';
import { runningToolCalls, runningToolProgress, inFlightToolCalls } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { liveConversations } from '../sessions/history/recorder.js';
import type { InputActivity } from '../sessions/input/input.js';

const UNKNOWN_CALL_HOLD_MS = 3 * 60_000;
const PRO_SILENCE_MS = 10 * 60_000;
const DELIBERATE_SILENCE_MS = 20 * 60_000;

interface Runtime {
  awaitingReturn: Set<string>;
  stopRequestedFor: (conversationId: string) => boolean;
  armSilenceSweep: () => void;
  considerAutomaticCompaction: (
    conversationId: string,
    sessionId: string,
  ) => Promise<void>;
}

// Owns browser activity grants and their bounded local-tool hold policy.
export function createBridgeActivityPolicy(runtime: Runtime) {
  const unknownCallHold = new WeakMap<ActivityGrant, number>();

  function grantActivity(
    conversationId: string,
    sessionId: string,
    at = Date.now(),
    window = CHAT_SILENCE_MS,
    turn?: Pick<ActivityGrant, 'turnId' | 'model' | 'mcpBacked' | 'deliberate'>,
  ): void {
    // A semantic turn start arms the silence deadline; later evidence pushes it forward. Browser and API executors own their turn lifecycle outside this silence policy.
    if (
      providerForConversationId(conversationId) ||
      isApiConversationId(conversationId)
    )
      return;
    if (!sessionId) return;
    const previous = activeUntil.get(conversationId);
    const ownership =
      turn ??
      (previous?.sessionId === sessionId
        ? previous
        : { turnId: null, model: 'unknown' as const });
    if (
      isChatBlocked(conversationId) ||
      (ownership.model === 'pro' &&
        runtime.stopRequestedFor(conversationId) &&
        !ownership.mcpBacked)
    )
      return;
    const evidenceAt =
      previous?.sessionId === sessionId && previous.turnId === ownership.turnId
        ? Math.max(previous.evidenceAt, at)
        : at;
    const mcpBacked =
      ownership.mcpBacked ||
      (previous?.sessionId === sessionId &&
        previous.turnId === ownership.turnId &&
        previous.mcpBacked);
    // Same-turn renewal preserves the deliberate-thinking fact until the owner changes.
    const deliberate =
      ownership.deliberate ||
      (previous?.sessionId === sessionId &&
        previous.turnId === ownership.turnId &&
        previous.deliberate);
    activeUntil.set(conversationId, {
      sessionId,
      evidenceAt,
      until:
        evidenceAt +
        (ownership.model === 'pro'
          ? PRO_SILENCE_MS
          : deliberate
            ? DELIBERATE_SILENCE_MS
            : window),
      turnId: ownership.turnId,
      model: ownership.model,
      ...(mcpBacked ? { mcpBacked: true } : {}),
      ...(deliberate ? { deliberate: true as const } : {}),
    });
    runtime.awaitingReturn.delete(conversationId);
    runtime.armSilenceSweep();
    void runtime.considerAutomaticCompaction(conversationId, sessionId);
  }

  function silenceHeldByCalls(
    conversationId: string,
    grant: ActivityGrant | undefined,
    now = Date.now(),
    measure = false,
  ): 'own' | 'unknown' | null {
    // The first silent sweep starts the bounded hold for calls with unknown ownership.
    if (runningToolProgress(conversationId)) return 'own';
    if (runningToolCalls(conversationId) === 0) return null;
    if (!grant) return 'unknown';
    if (measure && !unknownCallHold.has(grant))
      unknownCallHold.set(grant, now);
    const since = unknownCallHold.get(grant);
    return since === undefined || now - since < UNKNOWN_CALL_HOLD_MS
      ? 'unknown'
      : null;
  }

  function recoveryHeldByCalls(conversationId: string): boolean {
    if (inFlightToolCalls(conversationId) === 0) return false;
    if (runningToolProgress(conversationId)) return true;
    const grant = activeUntil.get(conversationId);
    const since = grant ? unknownCallHold.get(grant) : undefined;
    return since === undefined || Date.now() - since < UNKNOWN_CALL_HOLD_MS;
  }

  function silenceWindowMs(
    grant: Pick<ActivityGrant, 'model' | 'thinkingFailed' | 'deliberate'>,
  ): number {
    // Failed thinking shortens the Pro window but does not count as new model work.
    if (grant.model === 'pro')
      return grant.thinkingFailed ? 5 * 60_000 : PRO_SILENCE_MS;
    return grant.deliberate && !grant.thinkingFailed
      ? DELIBERATE_SILENCE_MS
      : CHAT_SILENCE_MS;
  }

  function sessionInputActivity(summary: SessionSummary): InputActivity {
    const id = summary.conversationId;
    if (!id || summary.browserRecoveryDismissedAt !== undefined)
      return { possible: false, exact: false };
    if (providerForConversationId(id) || isApiConversationId(id)) {
      const turnId =
        webProviderFlightTurnId(summary.id) ?? apiChatFlightTurnId(summary.id);
      return { possible: !!turnId, exact: !!turnId, ...(turnId ? { turnId } : {}) };
    }
    const grant = activeUntil.get(id);
    const expiry = sessionActivityExpiresAt(summary);
    const mcpWindow =
      grant?.sessionId === summary.id &&
      grant.mcpBacked &&
      !grant.thinkingFailed &&
      (summary.activeTurnId || summary.lastTurnOutcome !== 'stopped') &&
      (!summary.activeTurnId || summary.activeTurnId === grant.turnId) &&
      grant.until > Date.now();
    const exact =
      !!mcpWindow ||
      runningToolProgress(id) !== null ||
      liveConversations().some(
        (row) =>
          row.sessionId === summary.id &&
          row.conversationId === id &&
          !!row.activeTurnId,
      );
    return {
      exact,
      model:
        grant?.sessionId === summary.id &&
        (grant.turnId === summary.activeTurnId || mcpWindow)
          ? grant.model
          : 'unknown',
      ...(exact && (summary.activeTurnId || (mcpWindow && grant?.turnId))
        ? { turnId: summary.activeTurnId || grant!.turnId! }
        : {}),
      possible:
        exact ||
        !!silenceHeldByCalls(
          id,
          grant?.sessionId === summary.id ? grant : undefined,
        ) ||
        (expiry !== undefined && expiry !== null && expiry > Date.now()),
    };
  }

  return {
    grantActivity,
    silenceHeldByCalls,
    recoveryHeldByCalls,
    silenceWindowMs,
    sessionInputActivity,
    unknownCallHold,
    UNKNOWN_CALL_HOLD_MS,
    PRO_SILENCE_MS,
    DELIBERATE_SILENCE_MS,
  };
}
