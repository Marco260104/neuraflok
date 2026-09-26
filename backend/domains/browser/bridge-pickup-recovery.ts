import type { bridgeRecoveryControlRuntime } from './bridge.js';
import type { Repair } from './bridge-recovery-types.js';
import { BROWSER_PICKUP_BACKOFF_MS, BROWSER_PICKUP_MAX_ATTEMPTS } from '../../../contracts/recovery.js';
import type { ContinuationView } from '../sessions/continuity/continuation.js';
import { abortContinuationSourceBeforeSendNow, continuationForSession, pendingContinuations, sendUnattempted } from '../sessions/continuity/continuation.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { pendingGoalReplies, goalPendingReplyFor, loopAfterTurnFor, loopReplyHasAuthority, astraFinishOnly, goalReplySourceTurn, syncGoalPickupRecoveryNow, recordGoalPickupAttemptNow, goalDraftBusy, goalDraftNeedsIntervention } from '../automation/goal.js';
import { automaticCompactionAllowed, conversationWasSuperseded, getSession, readRecentEvents } from '../sessions/history/store.js';
import { recordNote } from '../sessions/history/recorder.js';
import { pendingQueuedPickups, syncQueuedPickupRecoveryNow, recordQueuedPickupAttemptNow } from '../sessions/input/input.js';
import { waitingForSubAgents } from '../automation/agents.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';

type Runtime = typeof bridgeRecoveryControlRuntime;
type CompactionPhase = 'asking' | 'writing' | 'opening';
type QueueBrowserRecovery = (
  conversationId: string,
  sessionId: string,
  episode: string,
  reason: Repair['reason'],
  endedTurns?: number,
  now?: number,
  assistantSource?: Repair['assistantSource']
) => boolean;
type OwedPickup = {
  conversationId: string;
  sessionId: string;
  replyId: string;
  acceptedAt: number;
  listenUntil: number;
  pro: boolean;
  queued: boolean;
  inputId?: string;
  goalReplyId?: string;
  pickupAttempts: number;
  pickupNextAt?: number;
  pickupStoppedAt?: number;
};

interface Dependencies {
  runtime: Runtime;
  repairsInFlight: Map<string, Repair>;
  pagelessChats: Set<string>;
  goalInputPriority(conversationId: string, sessionId: string, turnId?: string): Promise<'queued' | 'consumed' | null>;
  suppressProSilence(conversationId: string): Promise<boolean>;
  workerRecoveryAllowed(conversationId: string): boolean;
  queueBrowserRecovery: QueueBrowserRecovery;
  deliver(): Promise<void>;
}

interface PickupWatch {
  replyId: string;
  dueAt: number;
  attempts: number;
  expiresAt: number;
  stoppedAt?: number;
}

interface CompactionWatch {
  token: string;
  phase: CompactionPhase;
  nextAt: number;
  attempts: number;
  backoffs?: number;
  told?: boolean;
}

const PICKUP_WATCH_LIFETIME_MS = 12 * 60 * 60_000;
const COMPACTION_PICKUPS: Record<CompactionPhase, { every: number; attempts: number }> = {
  asking: { every: 2 * 60_000, attempts: 5 },
  writing: { every: 5 * 60_000, attempts: 3 },
  opening: { every: 15 * 60_000, attempts: 3 }
};
const AUTOMATIC_ASKING_RETRY_PAUSE_MS = 10 * 60_000;
const AUTOMATIC_ASKING_RETRY_BURSTS = 2;

export function createBridgePickupRecovery({
  runtime,
  repairsInFlight,
  pagelessChats,
  goalInputPriority,
  suppressProSilence,
  workerRecoveryAllowed,
  queueBrowserRecovery,
  deliver
}: Dependencies) {
  const PICKUP_BACKOFF_MS = BROWSER_PICKUP_BACKOFF_MS;
  const pickupWatch = new Map<string, PickupWatch>();
  const compactionWatch = new Map<string, CompactionWatch>();

  function compactionPhaseOf(entry: ContinuationView): CompactionPhase {
    if (entry.state !== 'awaiting-summary') return 'opening';
    return sendUnattempted(entry.sourceSend) ? 'asking' : 'writing';
  }

  function expediteCompactionPickup(conversationId: string): boolean {
    const entry = pendingContinuations().find((candidate) => candidate.from === conversationId);
    if (!entry || runtime.compactionWatchFloor === null) return false;
    const phase = compactionPhaseOf(entry);
    const watch = compactionWatch.get(conversationId);
    if (watch && watch.token === entry.token && watch.phase === phase) {
      if (watch.attempts >= COMPACTION_PICKUPS[phase].attempts) return false;
      watch.nextAt = 0;
      return true;
    }
    compactionWatch.set(conversationId, { token: entry.token, phase, attempts: 0, nextAt: 0 });
    return true;
  }

  function forgetGoalWatch(conversationId: string): void {
    if (repairsInFlight.get(conversationId)?.reason === 'goal') repairsInFlight.delete(conversationId);
  }

  function notePickupActivity(conversationId: string): void {
    const watch = pickupWatch.get(conversationId);
    if (!watch || watch.stoppedAt) return;
    const gap = PICKUP_BACKOFF_MS[Math.min(watch.attempts, PICKUP_BACKOFF_MS.length - 1)]!;
    watch.dueAt = Date.now() + gap;
  }

  async function owedPickups(now: number): Promise<Map<string, OwedPickup>> {
    const owed = new Map<string, OwedPickup>();
    for (const reply of pendingGoalReplies(now)) {
      const pending = goalPendingReplyFor(reply.conversationId);
      if (!pending) continue;
      if (!runtime.goalActiveFor(reply.conversationId) || goalDraftNeedsIntervention(reply.conversationId) || !await loopReplyHasAuthority(reply.sessionId, reply.conversationId, pending.turnId) ||
          await goalInputPriority(reply.conversationId, reply.sessionId, pending.turnId) ||
          await astraFinishOnly(reply.sessionId, reply.conversationId) || await suppressProSilence(reply.conversationId)) continue;
      const source = await goalReplySourceTurn(reply.sessionId, pending.silenceSourceTurnId ?? pending.turnId);
      if (!source) continue;
      const [latestQuestion] = await readRecentEvents(reply.sessionId, 1, { kinds: ['user_message', 'turn_start'] });
      const questionPosition = latestQuestion?.kind === 'user_message' ? latestQuestion.origin ?? latestQuestion.seq : latestQuestion?.seq ?? 0;
      if (latestQuestion && ((pending.eventSeq > 0 && questionPosition > pending.eventSeq) ||
          (latestQuestion.kind === 'turn_start' && latestQuestion.turnId !== source))) continue;
      const current = goalPendingReplyFor(reply.conversationId);
      if (current?.replyId !== pending.replyId || current.acceptedAt !== pending.acceptedAt) continue;
      owed.set(reply.conversationId, { ...reply, replyId: source, goalReplyId: pending.replyId,
        pickupAttempts: pending.pickupAttempts ?? 0, pickupNextAt: pending.pickupNextAt, pickupStoppedAt: pending.pickupStoppedAt,
        listenUntil: pending.listenUntil ?? 0, pro: loopAfterTurnFor(reply.conversationId), queued: false });
    }
    for (const input of await pendingQueuedPickups()) {
      const prior = owed.get(input.conversationId);
      const goalPending = goalPendingReplyFor(input.conversationId);
      const goalSource = goalPending
        ? await goalReplySourceTurn(input.sessionId, goalPending.silenceSourceTurnId ?? goalPending.turnId) : undefined;
      const sameGoalSource = goalPending && goalSource === input.sourceTurnId ? goalPending : null;
      const priorAttempts = Math.max(prior?.pickupAttempts ?? 0, sameGoalSource?.pickupAttempts ?? 0);
      const attempts = Math.max(input.pickupAttempts, priorAttempts);
      const newestBudget = input.pickupAttempts >= priorAttempts ? input
        : sameGoalSource?.pickupAttempts === priorAttempts ? sameGoalSource : prior;
      owed.set(input.conversationId, { ...input, replyId: input.sourceTurnId, inputId: input.inputId, queued: true,
        acceptedAt: Math.min(input.acceptedAt, prior?.acceptedAt ?? sameGoalSource?.acceptedAt ?? input.acceptedAt),
        pickupAttempts: attempts, pickupNextAt: newestBudget?.pickupNextAt,
        pickupStoppedAt: input.pickupStoppedAt ?? sameGoalSource?.pickupStoppedAt ?? prior?.pickupStoppedAt,
        goalReplyId: sameGoalSource?.replyId ?? prior?.goalReplyId });
    }
    for (const [id, pickup] of owed) {
      const session = await getSession(pickup.sessionId);
      if (now - pickup.acceptedAt >= PICKUP_WATCH_LIFETIME_MS || session?.conversationId !== id ||
          session.browserRecoveryDismissedAt !== undefined) owed.delete(id);
    }
    for (const id of owed.keys()) if (waitingForSubAgents(id)) owed.delete(id);
    return owed;
  }

  async function inspectOwedPickups(now: number): Promise<boolean> {
    const floor = runtime.pickupWatchFloor;
    if (floor === null) return false;
    const owed = await owedPickups(now);
    if (runtime.pickupWatchFloor !== floor) return false;
    for (const [conversationId, watch] of pickupWatch) {
      if (now >= watch.expiresAt) pickupWatch.delete(conversationId);
      if (now < watch.expiresAt && owed.get(conversationId)?.replyId === watch.replyId) continue;
      const repair = repairsInFlight.get(conversationId);
      if (repair?.reason === 'goal' && (now >= watch.expiresAt || repair.state !== 'handed' || owed.has(conversationId))) repairsInFlight.delete(conversationId);
    }
    let queued = false;
    for (const reply of owed.values()) {
      const session = await getSession(reply.sessionId);
      if (session?.conversationId !== reply.conversationId || isChatBlocked(reply.conversationId) ||
          runtime.stopRequestedFor(reply.conversationId) || await conversationWasSuperseded(reply.conversationId) ||
          continuationForSession(reply.sessionId)) continue;
      if (runtime.pickupWatchFloor !== floor) return queued;
      const sharedState = { attempts: reply.pickupAttempts, ...(reply.pickupNextAt ? { nextAt: reply.pickupNextAt } : {}),
        ...(reply.pickupStoppedAt ? { stoppedAt: reply.pickupStoppedAt } : {}) };
      if (reply.queued && reply.inputId && (sharedState.attempts > 0 || sharedState.nextAt || sharedState.stoppedAt)) {
        const synchronized = await syncQueuedPickupRecoveryNow(reply.inputId, reply.replyId, sharedState);
        if (synchronized) Object.assign(reply, { pickupAttempts: synchronized.attempts,
          pickupNextAt: synchronized.nextAt, pickupStoppedAt: synchronized.stoppedAt });
      }
      if (reply.goalReplyId && (sharedState.attempts > 0 || sharedState.nextAt || sharedState.stoppedAt))
        await syncGoalPickupRecoveryNow(reply.conversationId, reply.goalReplyId, sharedState);
      let watch = pickupWatch.get(reply.conversationId);
      if (!watch || watch.replyId !== reply.replyId) {
        const attempts = Math.min(BROWSER_PICKUP_MAX_ATTEMPTS, reply.pickupAttempts);
        watch = { replyId: reply.replyId, attempts,
          expiresAt: reply.acceptedAt + PICKUP_WATCH_LIFETIME_MS,
          dueAt: reply.pickupNextAt ?? Math.max(reply.acceptedAt, floor) + PICKUP_BACKOFF_MS[0],
          ...(reply.pickupStoppedAt || attempts >= BROWSER_PICKUP_MAX_ATTEMPTS
            ? { stoppedAt: reply.pickupStoppedAt ?? reply.acceptedAt } : {}) };
        pickupWatch.set(reply.conversationId, watch);
      }
      if (watch.stoppedAt || watch.attempts >= BROWSER_PICKUP_MAX_ATTEMPTS) continue;
      if (now < watch.dueAt || now < reply.listenUntil) continue;
      if (!reply.queued && goalDraftBusy(reply.conversationId)) {
        notePickupActivity(reply.conversationId);
        continue;
      }
      const held = repairsInFlight.get(reply.conversationId);
      if (held?.state === 'done' && held.reason === 'goal') repairsInFlight.delete(reply.conversationId);
      else if (held && held.state !== 'done') continue;
      if (!workerRecoveryAllowed(reply.conversationId) || pagelessChats.has(reply.conversationId)) continue;
      const nextAttempts = watch.attempts + 1;
      const nextAt = nextAttempts < BROWSER_PICKUP_MAX_ATTEMPTS
        ? now + PICKUP_BACKOFF_MS[nextAttempts]! : undefined;
      const reserved = reply.queued && reply.inputId
        ? await recordQueuedPickupAttemptNow(reply.inputId, reply.replyId, now, nextAt, sharedState)
        : !reply.queued && reply.goalReplyId
          ? await recordGoalPickupAttemptNow(reply.conversationId, reply.goalReplyId, now, nextAt)
          : null;
      if (!reserved) continue;
      watch.attempts = reserved.attempts;
      watch.dueAt = reserved.nextAt ?? reserved.stoppedAt ?? now;
      watch.stoppedAt = reserved.stoppedAt;
      if (reply.goalReplyId && reply.queued) await syncGoalPickupRecoveryNow(reply.conversationId, reply.goalReplyId, reserved);
      if (!queueBrowserRecovery(reply.conversationId, reply.sessionId,
        `goal:${reply.replyId}:${watch.attempts}`, 'goal', 0, now)) continue;
      queued = true;
      logInfo(`bridge: next automation/input step uncollected in ${reply.conversationId} — reload ${watch.attempts}`);
      if (watch.stoppedAt) logWarn(`bridge: browser pickup recovery stopped after ${watch.attempts} reloads; the original obligation remains queued in ${reply.conversationId}`);
    }
    return queued;
  }

  async function inspectOwedCompactions(now: number): Promise<boolean> {
    if (runtime.compactionWatchFloor === null) return false;
    const owed = new Map(pendingContinuations().map((entry) => [entry.from, entry]));
    for (const [conversationId, watch] of compactionWatch) {
      if (owed.get(conversationId)?.token === watch.token) continue;
      compactionWatch.delete(conversationId);
      if (repairsInFlight.get(conversationId)?.reason === 'compaction') repairsInFlight.delete(conversationId);
    }

    let queued = false;
    for (const entry of owed.values()) {
      const session = await getSession(entry.sessionId);
      if (session?.conversationId !== entry.from || session.browserRecoveryDismissedAt !== undefined) continue;
      if (entry.automatic && !automaticCompactionAllowed(await getSession(entry.sessionId))) {
        await runtime.cancelAutomaticResumesNow(entry.sessionId);
        continue;
      }
      const phase = compactionPhaseOf(entry);
      let watch = compactionWatch.get(entry.from);
      if (!watch || watch.token !== entry.token || watch.phase !== phase) {
        const since = Math.max(runtime.compactionWatchFloor!, phase === 'asking' ? entry.openedAt : phase === 'writing' ? (entry.askedAt ?? now) : now);
        watch = { token: entry.token, phase, attempts: 0, nextAt: since + COMPACTION_PICKUPS[phase].every };
        compactionWatch.set(entry.from, watch);
      }
      const schedule = COMPACTION_PICKUPS[phase];
      if (now < watch.nextAt) continue;
      if (watch.attempts >= schedule.attempts) {
        if (phase === 'writing' && !watch.told) {
          watch.told = true;
          logWarn(`bridge: compaction ticket ${entry.token.slice(0, 8)} for ${entry.from} is still without its brief after ${schedule.attempts} pickups`);
          void recordNote(
            entry.sessionId,
            `Compact & Resume is still waiting for this chat's handoff: ${schedule.attempts} reloads did not collect it. ` +
              'The request was already sent, so it is not sent again. Open the chat to let it finish, or cancel compaction to return to it.'
          ).catch(() => undefined);
        }
        if (phase !== 'asking') continue;
        if (entry.automatic && (watch.backoffs ?? 0) < AUTOMATIC_ASKING_RETRY_BURSTS) {
          watch.attempts = 0;
          watch.backoffs = (watch.backoffs ?? 0) + 1;
          watch.nextAt = now + AUTOMATIC_ASKING_RETRY_PAUSE_MS;
          logInfo(
            `bridge: compaction ticket ${entry.token.slice(0, 8)} still has no source Send after ${schedule.attempts} pickups — retaining automatic ticket and backing off`
          );
          continue;
        }
        compactionWatch.delete(entry.from);
        if (repairsInFlight.get(entry.from)?.reason === 'compaction') repairsInFlight.delete(entry.from);
        try {
          if (!await abortContinuationSourceBeforeSendNow(entry.token, 'handoff_never_sent')) continue;
          logWarn(
            `bridge: compaction ticket ${entry.token.slice(0, 8)} for ${entry.from} was never sent after ${schedule.attempts} pickups — giving up`
          );
          runtime.changed();
        } catch (err) {
          logWarn(`bridge: could not abandon compaction ticket ${entry.token.slice(0, 8)} — ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }

      let acted = false;
      if (phase === 'asking' || phase === 'writing') {
        const held = repairsInFlight.get(entry.from);
        if (held?.state === 'done' && held.reason === 'compaction') repairsInFlight.delete(entry.from);
        else if (held && held.state !== 'done') continue;
        acted = queueBrowserRecovery(
          entry.from,
          entry.sessionId,
          `compaction:${entry.token}:${phase}:${watch.attempts}`,
          'compaction',
          0,
          now
        );
      } else if (
        sendUnattempted(entry.destinationSend) &&
        !runtime.commands.some((command) => command.spec.type === 'resume' && command.spec.token === entry.token)
      ) {
        runtime.queueResumeCommand(entry.sessionId, entry.token);
        void deliver();
        acted = true;
      }
      if (!acted) continue;

      watch.attempts += 1;
      watch.nextAt = now + schedule.every;
      queued = true;
      logInfo(
        `bridge: compaction ticket ${entry.token.slice(0, 8)} ${phase} pickup ${watch.attempts} of ${schedule.attempts}`
      );
    }
    return queued;
  }

  return {
    compactionPhaseOf,
    expediteCompactionPickup,
    forgetGoalWatch,
    notePickupActivity,
    owedPickups,
    inspectOwedPickups,
    inspectOwedCompactions,
    PICKUP_BACKOFF_MS,
    pickupWatch,
    PICKUP_WATCH_LIFETIME_MS,
    COMPACTION_PICKUPS,
    compactionWatch,
    AUTOMATIC_ASKING_RETRY_PAUSE_MS,
    AUTOMATIC_ASKING_RETRY_BURSTS
  };
}

