import { recoveryBusyMs } from '../../../contracts/recovery.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { continuationForSession } from '../sessions/continuity/continuation.js';
import { acceptGoalReplyNow, goalPendingReplyFor, withdrawSilenceGoalReplyNow } from '../automation/goal.js';
import { getSession, readRecentEvents, turnHasMcpCall } from '../sessions/history/store.js';
import { fileRecoveryInput, fileSilenceInput, inputBeforeGoal } from '../sessions/input/input.js';
import { activeUntil } from './session-activity.js';
import type { ActivityGrant } from './session-activity.js';
import type { Repair } from './bridge-recovery-types.js';

interface Runtime {
  repairsInFlight: Map<string, Repair>;
  lastBrowserRecoveryAt: Map<string, number>;
  observationWritesInFlight: number;
  PRO_SILENCE_MS: number;
  silenceWindowMs(grant: Pick<ActivityGrant, 'model' | 'thinkingFailed' | 'deliberate'>): number;
  stopRequestedFor(conversationId: string): boolean;
  silenceHeldByCalls(conversationId: string, grant: ActivityGrant | undefined, now?: number): 'own' | 'unknown' | null;
  recoveryInputAllowed(sessionId: string, conversationId: string): boolean;
  goalActiveFor(conversationId: string): boolean;
  goalWorkerChat(conversationId: string): boolean;
}

export function createBridgeSilenceTickets(runtime: Runtime) {
  const { repairsInFlight, lastBrowserRecoveryAt, silenceWindowMs, stopRequestedFor, silenceHeldByCalls,
    recoveryInputAllowed, goalActiveFor, goalWorkerChat } = runtime;

  async function fileSilenceInputTicket(conversationId: string, now: number, listenUntil?: number): Promise<boolean> {
    const grant = activeUntil.get(conversationId);
    const repair = repairsInFlight.get(conversationId);
    if (!grant?.turnId || now - grant.evidenceAt < silenceWindowMs(grant) ||
        repair?.reason !== 'silence' || repair.state !== 'done' || repair.sessionId !== grant.sessionId ||
        !await turnHasMcpCall(grant.sessionId, conversationId, grant.turnId)) return false;
    const current = () => activeUntil.get(conversationId) === grant && repairsInFlight.get(conversationId) === repair &&
      !stopRequestedFor(conversationId) && !isChatBlocked(conversationId) &&
      !continuationForSession(grant.sessionId) && !silenceHeldByCalls(conversationId, grant) &&
      (runtime.observationWritesInFlight === 0 || (grant.thinkingFailed === true && repair.progress?.turnId === grant.turnId));
    if (await fileSilenceInput(grant.sessionId, conversationId, grant.turnId, current,
      grant.thinkingFailed || grant.model !== 'pro' ? grant.until : listenUntil)) return true;
    return recoveryInputAllowed(grant.sessionId, conversationId) &&
      fileRecoveryInput(grant.sessionId, conversationId, grant.turnId, grant.model === 'pro', current,
        (lastBrowserRecoveryAt.get(conversationId) ?? now) + recoveryBusyMs(grant.model === 'pro'), repair.progressId);
  }

  async function fileSilenceTickets(spent: readonly string[], now: number): Promise<void> {
    for (const conversationId of spent) {
      if (await fileSilenceInputTicket(conversationId, now)) continue;
      if (goalActiveFor(conversationId) || goalWorkerChat(conversationId) || isChatBlocked(conversationId)) continue;
      const held = repairsInFlight.get(conversationId);
      if (held?.reason !== 'silence' || held.state !== 'done') continue;
      const grant = activeUntil.get(conversationId);
      const session = await getSession(held.sessionId);
      if (!session || session.conversationId !== conversationId) continue;
      if (await inputBeforeGoal(session.id, grant?.turnId ?? undefined)) continue;
      const [start] = await readRecentEvents(session.id, 1, { kinds: ['turn_start'] });
      if (!grant?.turnId || start?.turnId !== grant.turnId || goalActiveFor(conversationId)) continue;
      if (activeUntil.get(conversationId) !== grant ||
          (grant.model === 'pro' && !grant.thinkingFailed && now - grant.evidenceAt < runtime.PRO_SILENCE_MS)) continue;
      if (goalPendingReplyFor(conversationId) || silenceHeldByCalls(conversationId, grant, now)) continue;
      if (continuationForSession(session.id)) continue;
      const [boundary] = await readRecentEvents(session.id, 1);
      if (!boundary) continue;
      const turnId = `g-silence-${held.token}`;
      try {
        await acceptGoalReplyNow({
          conversationId,
          sessionId: session.id,
          silenceSourceTurnId: grant.turnId,
          silencePro: grant.model === 'pro',
          ...(grant.thinkingFailed || grant.model !== 'pro' ? { listenUntil: grant.until } : {}),
          replyId: `silence:${held.token}`,
          turnId,
          eventSeq: boundary.seq,
          blocked: false,
          handledOnly: true,
          current: () => activeUntil.get(conversationId) === grant && repairsInFlight.get(conversationId) === held &&
            !silenceHeldByCalls(conversationId, grant) && !stopRequestedFor(conversationId) && !goalActiveFor(conversationId)
        });
        if (activeUntil.get(conversationId) !== grant || silenceHeldByCalls(conversationId, grant)) {
          const pending = goalPendingReplyFor(conversationId);
          if (pending?.turnId === turnId) await withdrawSilenceGoalReplyNow(conversationId, pending.replyId);
        }
        logInfo(`bridge: ${conversationId} stayed silent after its reload — retaining the handled source for explicit activation`);
      } catch (err) {
        logWarn(`bridge: could not file the Goal ticket for ${conversationId} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { fileSilenceInputTicket, fileSilenceTickets };
}
