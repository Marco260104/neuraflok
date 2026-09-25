import { randomBytes } from 'node:crypto';
import { isApiConversationId } from '../../../contracts/chat-protocol.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { logWarn } from '../../infrastructure/settings/logger.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { continuationForSession, supersededSourceConversations } from '../sessions/continuity/continuation.js';
import { getSession } from '../sessions/history/store.js';
import { wakeBrowserUrl } from './browser-startup.js';
import { wakeBrowserWork } from './browser-wake.js';
import { activeUntil } from './session-activity.js';
import type { Repair } from './bridge-recovery-types.js';

interface PickupWatch {
  replyId: string;
  expiresAt: number;
}

interface OwedPickup {
  sessionId: string;
  replyId: string;
}

interface Runtime {
  BROWSER_RECOVERY_COOLDOWN_MS: number;
  bridgeLifecycleEpoch(): number;
  bridgeShutdownRequested(): boolean;
  chatUrl(conversationId: string): string;
  stopRequestedFor(conversationId: string): boolean;
  repairsInFlight: Map<string, Repair>;
  turnRepairSpent: Map<string, { sessionId: string; turnKey: string; token: string; at: number }>;
  lastAttributedCallAt: Map<string, number>;
  lastBrowserRecoveryAt: Map<string, number>;
  activeUntil: typeof activeUntil;
  turnScopedRepairs: ReadonlySet<Repair['reason']>;
  pagelessChats: Set<string>;
  getPickupWatch(conversationId: string): PickupWatch | undefined;
  owedPickups(now: number): Promise<{ get(conversationId: string): OwedPickup | undefined }>;
  workerRecoveryAllowed(conversationId: string): boolean;
  assistantRecoveryCancelledFor(conversationId: string, sessionId: string, turnKey: string): boolean;
  departureAllowsRepairFor(session: SessionSummary, reason: Repair['reason'], episode: string): boolean;
}

// Owns repair eligibility, replacement, and the single authorized browser wake.
export function createBridgeRepairQueue(runtime: Runtime) {
  const { BROWSER_RECOVERY_COOLDOWN_MS, repairsInFlight, turnRepairSpent, lastAttributedCallAt,
    lastBrowserRecoveryAt, turnScopedRepairs, pagelessChats, getPickupWatch, owedPickups,
    workerRecoveryAllowed, assistantRecoveryCancelledFor, departureAllowsRepairFor } = runtime;

  function queueBrowserRecovery(
    conversationId: string,
    sessionId: string,
    episode: string,
    reason: Repair['reason'],
    endedTurns = 0,
    now = Date.now(),
    assistantSource?: Repair['assistantSource']
  ): boolean {
    // API conversations use their own executor and never queue browser recovery.
    if (isApiConversationId(conversationId)) return false;
    // Explicit stops, blocked chats, and retired workers disable automatic recovery.
    if (!sessionId || !workerRecoveryAllowed(conversationId) || isChatBlocked(conversationId) || runtime.stopRequestedFor(conversationId)) return false;
    // An answered chat has no page to recover until browser activity returns.
    if (pagelessChats.has(conversationId)) return false;
    if (reason === 'assistant-error') {
      // Only one interrupted-response reload is allowed for the same unfinished user turn.
      const spent = turnRepairSpent.get(conversationId);
      if (!assistantSource) return false;
      if (assistantRecoveryCancelledFor(conversationId, sessionId, assistantSource.key)) return false;
      const progressed = spent !== undefined && !assistantSource.completed &&
        (lastAttributedCallAt.get(conversationId) ?? 0) > spent.at;
      if (spent?.sessionId === sessionId && assistantSource.key === spent.turnKey && !progressed) return false;
      if (spent) turnRepairSpent.delete(conversationId);
      // New attributed work makes a completed repair eligible again.
      if (progressed && repairsInFlight.get(conversationId)?.state === 'done') repairsInFlight.delete(conversationId);
    }
    const held = repairsInFlight.get(conversationId);
    // A repeated episode must not enqueue a duplicate repair.
    if (held?.episode === episode) return false;
    // Silence, missing-tab, and compaction events may take over eligible stale repairs.
    const supersedes =
      ((reason === 'silence' || reason === 'no-tab') && turnScopedRepairs.has(held?.reason as Repair['reason'])) ||
      (reason === 'compaction' && held?.reason !== 'compaction' && !held?.claimed);
    if (held && held.state !== 'done' && !supersedes) return false;
    // Owned schedules use their own deadlines and bypass the shared retry cooldown.
    const notBefore =
      reason === 'silence' || reason === 'goal' || reason === 'compaction' || reason === 'no-tab' || reason === 'unattributed'
        ? now
        : Math.max(now, (lastBrowserRecoveryAt.get(conversationId) ?? 0) + BROWSER_RECOVERY_COOLDOWN_MS);
    const repair: Repair = {
      ...(reason === 'silence' ? { silenceGrant: runtime.activeUntil.get(conversationId) } : {}),
      ...(assistantSource ? { assistantSource } : {}),
      sessionId,
      endedTurns,
      state: 'queued',
      episode,
      reason,
      notBefore,
      token: '',
      progressId: `browser-repair:${conversationId}:${randomBytes(9).toString('base64url')}`
    };
    repairsInFlight.set(conversationId, repair);
    // Wake status subscribers after storing the repair so authorization sees current state.
    wakeBrowserWork();
    // Goal and compaction repairs can start one browser when browser-only mode is disabled.
    if ((reason === 'goal' || reason === 'compaction') && getConfig().ui.browserOnly !== true) {
      const pickup = getPickupWatch(conversationId);
      const ticket = continuationForSession(sessionId);
      const lifecycle = runtime.bridgeLifecycleEpoch();
      void getSession(sessionId).then(session => {
        if (session?.conversationId !== conversationId || !departureAllowsRepairFor(session, reason, episode)) return;
        const current = () => runtime.bridgeLifecycleEpoch() === lifecycle && !runtime.bridgeShutdownRequested() &&
          getConfig().ui.browserOnly !== true &&
          repairsInFlight.get(conversationId) === repair && repair.state === 'queued' &&
          !isChatBlocked(conversationId) && !runtime.stopRequestedFor(conversationId) &&
          !supersededSourceConversations().includes(conversationId);
        return wakeBrowserUrl(runtime.chatUrl(conversationId), true, getConfig().ui.backgroundChats === true, {
          current: () => {
            if (!current()) return false;
            if (reason === 'compaction') return !!ticket && ticket.from === conversationId &&
              continuationForSession(sessionId)?.token === ticket.token && continuationForSession(sessionId)?.state === 'awaiting-summary';
            // Recheck durable pickup ownership at both startup fences, even when Goal is off.
            return owedPickups(Date.now()).then(owed => current() && !!pickup &&
              getPickupWatch(conversationId) === pickup && !continuationForSession(sessionId) &&
              owed.get(conversationId)?.sessionId === sessionId && owed.get(conversationId)?.replyId === pickup.replyId);
          }
        });
      }).catch((error: Error) => logWarn(`bridge: could not start browser for ${reason} recovery: ${error.message}`));
    }
    return true;
  }

  return { queueBrowserRecovery };
}
