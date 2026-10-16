import { randomBytes } from 'node:crypto';
import type { bridgeRecoveryControlRuntime } from './bridge.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { noticeChatStopped } from '../../infrastructure/desktop-shell/stuck-notice.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { goalDraftBusy } from '../automation/goal.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { continuationForSession } from '../sessions/continuity/continuation.js';
import { recordNote } from '../sessions/history/recorder.js';
import { conversationWasSuperseded, getSession } from '../sessions/history/store.js';
import { activeUntil } from './session-activity.js';
import type { Repair } from './bridge-recovery-types.js';

type Runtime = Pick<typeof bridgeRecoveryControlRuntime, 'chatHeldElsewhere' | 'pickupWatchFloor' | 'stopRequestedFor'>;

interface OwedPickup {
  replyId: string;
  sessionId: string;
  listenUntil: number;
  queued: boolean;
}

interface PickupWatch {
  replyId: string;
  expiresAt: number;
}

interface Dependencies {
  runtime: Runtime;
  repairsInFlight: Map<string, Repair>;
  pickupWatch: { get(conversationId: string): PickupWatch | undefined };
  owedPickups(now: number): Promise<{ get(conversationId: string): OwedPickup | undefined }>;
  clearTurnRepairSpent(conversationId: string): void;
  pagelessChats: Set<string>;
  unclaimedRepairTold: Set<string>;
  unclaimedRepairOffers: number;
  retireSpentRepairs(): void;
  departureAllowsRepairFor(session: SessionSummary, reason: Repair['reason'], episode: string): boolean;
  endActivity(conversationId: string): void;
  attributionRepairAllowed(repair: Repair, session: SessionSummary | null): Promise<boolean>;
  assistantRepairCurrent(conversationId: string, repair: Repair): Promise<boolean>;
  silenceRepairCurrent(conversationId: string, repair: Repair): Promise<boolean>;
  compactionRepairCurrent(conversationId: string, repair: Repair): boolean;
  repairNeedsClaim(repair: Repair): boolean;
  compactionWatchDelete(conversationId: string): void;
  armSilenceSweep(): void;
  forgetGoalWatch(conversationId: string): void;
  logInfo(message: string): void;
  repairPurpose(repair: Repair): { to: string; during: string };
  updateRepairProgress(conversationId: string, repair: Repair, text: string): Promise<void>;
}

export function createBridgePendingRepairs({
  runtime,
  repairsInFlight,
  pickupWatch,
  owedPickups,
  clearTurnRepairSpent,
  pagelessChats,
  unclaimedRepairTold,
  unclaimedRepairOffers,
  retireSpentRepairs,
  departureAllowsRepairFor,
  endActivity,
  attributionRepairAllowed,
  assistantRepairCurrent,
  silenceRepairCurrent,
  compactionRepairCurrent,
  repairNeedsClaim,
  compactionWatchDelete,
  armSilenceSweep,
  forgetGoalWatch,
  logInfo: reportInfo,
  repairPurpose,
  updateRepairProgress
}: Dependencies) {
  async function takePendingRepairs(
    now = Date.now(),
    browser: string | null = null
  ): Promise<Array<{ conversationId: string; token: string; reason: Repair['reason']; focus: boolean }>> {
    retireSpentRepairs();
    const pickupFloor = runtime.pickupWatchFloor;
    const owed = await owedPickups(now);
    // Keep a handed Goal pickup token while its reply is temporarily hidden.
    for (const [conversationId, repair] of repairsInFlight) {
      if (repair.reason !== 'goal') continue;
      const pickup = owed.get(conversationId);
      const watch = pickupWatch.get(conversationId);
      if (repair.state === 'handed' && watch && now < watch.expiresAt && (!pickup || pickup.replyId === watch.replyId)) continue;
      if (!pickup || pickup.replyId !== watch?.replyId || runtime.pickupWatchFloor === null ||
          now < pickup.listenUntil || continuationForSession(pickup.sessionId) || (!pickup.queued && goalDraftBusy(conversationId)))
        repairsInFlight.delete(conversationId);
    }
    // Recheck block, supersession, stop, and current-turn authority before dispatch.
    for (const [conversationId, repair] of [...repairsInFlight]) {
      const session = await getSession(repair.sessionId);
      const superseded = await conversationWasSuperseded(conversationId);
      if (!isChatBlocked(conversationId) && !superseded && session?.conversationId === conversationId &&
          !(repair.reason !== 'compaction' && !session.activeTurnId && session.lastTurnOutcome === 'stopped') &&
          !runtime.stopRequestedFor(conversationId, session.activeTurnId)) {
        if (!departureAllowsRepairFor(session, repair.reason, repair.episode)) {
          endActivity(conversationId);
          if (repairsInFlight.get(conversationId) === repair && repair.state !== 'done') repairsInFlight.delete(conversationId);
          continue;
        }
        if ((!await attributionRepairAllowed(repair, session) || !await assistantRepairCurrent(conversationId, repair) ||
            !await silenceRepairCurrent(conversationId, repair) || !compactionRepairCurrent(conversationId, repair)) &&
            repairsInFlight.get(conversationId) === repair) repairsInFlight.delete(conversationId);
        continue;
      }
      repairsInFlight.delete(conversationId);
      if (session?.conversationId !== conversationId || superseded) clearTurnRepairSpent(conversationId);
      const grant = activeUntil.get(conversationId);
      if (grant?.sessionId === repair.sessionId) activeUntil.delete(conversationId);
      forgetGoalWatch(conversationId);
      compactionWatchDelete(conversationId);
      armSilenceSweep();
      logInfo(
        `bridge: ${conversationId} has no current browser-recovery authority — dropping its queued repair`
      );
    }
    // Move ordinary retries to the queue tail so one missing acknowledgement cannot starve other chats.
    for (const [conversationId, repair] of [...repairsInFlight]) {
      if (repair.state !== 'handed' || repair.reason === 'goal' || repairNeedsClaim(repair)) continue;
      repair.state = 'queued';
      repairsInFlight.delete(conversationId);
      repairsInFlight.set(conversationId, repair);
    }
    const ready: Array<{
      conversationId: string;
      token: string;
      reason: Repair['reason'];
      focus: boolean;
      requiresClaim?: boolean;
    }> = [];
    for (const [conversationId, repair] of repairsInFlight) {
      if (runtime.chatHeldElsewhere(conversationId, browser)) continue;
      const unclaimed = repair.reason !== 'unattributed' && repairNeedsClaim(repair) && repair.state === 'handed' && !repair.claimed;
      if (repair.state !== 'queued' && !unclaimed) continue;
      if (now < repair.notBefore) continue;
      if (unclaimed) {
        repair.offers = (repair.offers ?? 1) + 1;
        if (repair.offers > unclaimedRepairOffers) {
          // Stop offering when no page claims the repair and retain that verdict until a page returns.
          repairsInFlight.delete(conversationId);
          pagelessChats.add(conversationId);
          const key = `${repair.sessionId}:${repair.episode}`;
          if (!unclaimedRepairTold.has(key)) {
            unclaimedRepairTold.add(key);
            if (unclaimedRepairTold.size > 500) {
              for (const old of [...unclaimedRepairTold].slice(0, 100)) unclaimedRepairTold.delete(old);
            }
            void recordNote(
              repair.sessionId,
              `Stopped trying to recover this chat: ${repair.offers - 1} attempts were offered to the browser and ` +
                'none was picked up, so this chat has no page to reload. Open its tab again and recovery resumes.'
            ).catch(() => undefined);
            noticeChatStopped(
              'Recovery stopped',
              'The browser did not pick up this chat\'s repair, so the app stopped retrying. Open its tab again and recovery resumes.',
              repair.sessionId
            );
            logWarn(
              `bridge: ${conversationId} never claimed ${repair.offers - 1} ${repair.reason} repair offer(s) — no page; not offering again`
            );
          }
          continue;
        }
      } else {
        repair.state = 'handed';
        repair.token = randomBytes(9).toString('base64url');
        if (!repair.awaitingStream) await updateRepairProgress(conversationId, repair, `Trying to reload chat to ${repairPurpose(repair).to}…`);
      }
      if (repair.reason === 'goal') {
        const current = (await owedPickups(Date.now())).get(conversationId);
        if (runtime.pickupWatchFloor !== pickupFloor || !current || current.replyId !== pickupWatch.get(conversationId)?.replyId || Date.now() < current.listenUntil ||
            continuationForSession(current.sessionId) || (!current.queued && goalDraftBusy(conversationId))) {
          if (repairsInFlight.get(conversationId) === repair) repairsInFlight.delete(conversationId);
          continue;
        }
      }
      const currentSession = repair.attribution ? await getSession(repair.sessionId) : null;
      const allowed = await attributionRepairAllowed(repair, currentSession) && await assistantRepairCurrent(conversationId, repair) &&
        await silenceRepairCurrent(conversationId, repair) && compactionRepairCurrent(conversationId, repair);
      if (allowed && repairsInFlight.get(conversationId) === repair && !isChatBlocked(conversationId) &&
          !runtime.stopRequestedFor(conversationId)) {
        ready.push({ conversationId, token: repair.token, reason: repair.reason, focus: repair.reason === 'compaction',
          ...(repairNeedsClaim(repair) ? { requiresClaim: true } : {}) });
      }
    }
    if (ready.length) reportInfo(`bridge: handing the browser ${ready.length} repair(s): ` +
      ready.map(row => `${row.conversationId.slice(0, 8)}:${row.reason}`).join(', '));
    return ready;
  }

  return { takePendingRepairs };
}
