import { BROWSER_PICKUP_MAX_ATTEMPTS, recoveryBusyMs, type RecoveryCountdown } from '../../../contracts/recovery.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { UNATTRIBUTED_FINAL_WINDOW_MS } from './bridge-attribution-recovery.js';
import type { Repair, UnattributedCandidate, UnattributedIncident } from './bridge-recovery-types.js';
import { activeUntil } from './session-activity.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { continuationForSession, supersededSourceConversations } from '../sessions/continuity/continuation.js';
import { loopAfterTurnFor, goalPendingReplyFor, goalReplySourceTurn } from '../automation/goal.js';
import { runningToolCalls } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { getSession, readCompletedFinal, readRecentEvents, readRecoveryBoundary, turnHasMcpCall } from '../sessions/history/store.js';
import { hasQueuedAfterTurnInput, listInputs, pendingQueuedPickups } from '../sessions/input/input.js';

interface Runtime {
  repairsInFlight: ReadonlyMap<string, Repair>;
  pickupWatch: ReadonlyMap<string, { dueAt: number }>;
  unattributedIncidents: ReadonlyMap<string, UnattributedIncident>;
  lastBrowserRecoveryAt: ReadonlyMap<string, number>;
  browserPresent(): boolean;
  stopRequestedFor(conversationId: string): boolean;
  workerRecoveryAllowed(conversationId: string): boolean;
  departureAllowsRepair(session: SessionSummary): boolean;
  assistantRepairCurrent(conversationId: string, repair: Repair): Promise<boolean>;
  attributionRepairAllowed(repair: Repair, session: SessionSummary): Promise<boolean>;
  silenceRepairCurrent(conversationId: string, repair: Repair): Promise<boolean>;
  recoveryInputAllowed(sessionId: string, conversationId: string): boolean;
  goalActiveFor(conversationId: string): boolean;
  goalModeFor(conversationId: string): 'goal' | 'loop';
  tabRecoveryWanted(conversationId: string): boolean;
  pendingSuspects(incident: UnattributedIncident): UnattributedCandidate[];
}

export function createBridgeRecoveryReadModel(runtime: Runtime) {
  async function sessionRecoveryCountdowns(sessionId: string, conversationId: string): Promise<RecoveryCountdown[]> {
    const rows = await listInputs();
    const queuedAfterTurn = await hasQueuedAfterTurnInput(sessionId);
    const queuedPickups = await pendingQueuedPickups();
    const stoppedQueued = queuedPickups.find(row => row.sessionId === sessionId && row.conversationId === conversationId && row.pickupStoppedAt);
    const boundary = await readRecoveryBoundary(sessionId, activeUntil.get(conversationId)?.turnId);
    const session = await getSession(sessionId);
    if (session?.conversationId !== conversationId || session.browserRecoveryDismissedAt !== undefined || isChatBlocked(conversationId) || runtime.stopRequestedFor(conversationId) ||
        continuationForSession(sessionId) || supersededSourceConversations().includes(conversationId)) return [];
    const result: RecoveryCountdown[] = [];
    const pendingRepair = runtime.repairsInFlight.get(conversationId);
    if (pendingRepair?.sessionId === sessionId && pendingRepair.state !== 'done' && runtime.workerRecoveryAllowed(conversationId) && runtime.departureAllowsRepair(session)) {
      if (pendingRepair.reason === 'assistant-error' && await runtime.assistantRepairCurrent(conversationId, pendingRepair))
        return [{ kind: 'assistant-error', deadline: pendingRepair.notBefore }];
      if (pendingRepair.reason === 'unattributed' && await runtime.attributionRepairAllowed(pendingRepair, session))
        return [{ kind: 'unattributed', deadline: pendingRepair.notBefore }];
      if (pendingRepair.reason === 'silence' && await runtime.silenceRepairCurrent(conversationId, pendingRepair))
        return [{ kind: 'silence', deadline: pendingRepair.notBefore }];
      if (pendingRepair.reason === 'no-tab' || pendingRepair.reason === 'stalled')
        return [{ kind: 'tab-recovery', deadline: pendingRepair.notBefore }];
    }
    const recovery = rows.find(row => row.sessionId === sessionId && row.recovery &&
      (row.state === 'queued' || row.state === 'browser') && row.silenceBoundary);
    if (recovery?.silenceBoundary && runtime.recoveryInputAllowed(sessionId, conversationId)) {
      const stoppedAt = recovery.pickupRecovery?.stoppedAt ??
        (stoppedQueued?.inputId === recovery.id ? stoppedQueued.pickupStoppedAt : undefined);
      if (stoppedAt) return [{ kind: 'pickup-stopped', deadline: stoppedAt,
        attempts: recovery.pickupRecovery?.attempts ?? BROWSER_PICKUP_MAX_ATTEMPTS, next: 'continue' }];
      const wait = recovery.silenceBoundary.listenUntil ?? 0;
      const pickup = runtime.pickupWatch.get(conversationId);
      result.push(wait > Date.now() || !pickup ? {
        kind: recovery.silenceBoundary.nativeBusy ? 'native-busy' : 'post-reload',
        deadline: wait || Date.now(), next: 'continue'
      } : { kind: 'pickup', deadline: pickup.dueAt, visibleAt: pickup.dueAt - 30_000, next: 'continue' });
      return result;
    }
    if (stoppedQueued) {
      const queuedRow = rows.find(row => row.id === stoppedQueued.inputId);
      return [{ kind: 'pickup-stopped', deadline: stoppedQueued.pickupStoppedAt!,
        attempts: stoppedQueued.pickupAttempts, next: queuedRow?.recovery ? 'continue' : 'queue' }];
    }
    const pendingGoal = runtime.goalActiveFor(conversationId) ? goalPendingReplyFor(conversationId) : null;
    if (pendingGoal?.pickupStoppedAt && runningToolCalls(conversationId) === 0) {
      const source = await goalReplySourceTurn(sessionId, pendingGoal.silenceSourceTurnId ?? pendingGoal.turnId);
      const [latestQuestion] = await readRecentEvents(sessionId, 1, { kinds: ['user_message', 'turn_start'] });
      const questionPosition = latestQuestion?.kind === 'user_message' ? latestQuestion.origin ?? latestQuestion.seq : latestQuestion?.seq ?? 0;
      if (source && !(latestQuestion && ((pendingGoal.eventSeq > 0 && questionPosition > pendingGoal.eventSeq) ||
          (latestQuestion.kind === 'turn_start' && latestQuestion.turnId !== source)))) {
        return [{ kind: 'pickup-stopped', deadline: pendingGoal.pickupStoppedAt,
          attempts: pendingGoal.pickupAttempts ?? BROWSER_PICKUP_MAX_ATTEMPTS, next: runtime.goalModeFor(conversationId) }];
      }
    }
    if (pendingGoal && !pendingGoal.silenceSourceTurnId && runningToolCalls(conversationId) === 0 &&
        await readCompletedFinal(sessionId, conversationId, pendingGoal.turnId) &&
        goalPendingReplyFor(conversationId)?.acceptedAt === pendingGoal.acceptedAt) {
      const next = runtime.goalModeFor(conversationId);
      if ((pendingGoal.listenUntil ?? 0) > Date.now())
        return [{ kind: 'native-busy', deadline: pendingGoal.listenUntil!, next }];
      const pickup = runtime.pickupWatch.get(conversationId);
      if (pickup) return [{ kind: 'pickup', deadline: pickup.dueAt, visibleAt: pickup.dueAt - 30_000, next }];
    }
    if (runtime.browserPresent() && session.browserRecoveryDismissedAt === undefined) {
      const deadlines = [...runtime.unattributedIncidents.values()].flatMap(incident => {
        if (incident.pass >= 2) return [];
        const suspect = runtime.pendingSuspects(incident).find(candidate => candidate.sessionId === sessionId && candidate.conversationId === conversationId);
        if (!suspect || (session.activeTurnId ?? null) !== suspect.turnId) return [];
        const deadline = incident.pass === 0 ? incident.firstDueAt : incident.startedAt + UNATTRIBUTED_FINAL_WINDOW_MS;
        const retry = incident.pass === 1 && incident.requestId !== null && incident.firstAttemptAt !== null &&
          incident.lastUnknownStartedAt > incident.firstAttemptAt;
        return [{ kind: incident.pass === 0 ? 'unattributed' as const : 'unattributed-wait' as const,
          deadline, ...(retry ? { reload: true as const } : {}) }];
      });
      const earliest = deadlines.sort((a, b) => a.deadline - b.deadline)[0];
      if (earliest) result.push(earliest);
    }
    const grant = activeUntil.get(conversationId);
    if (runningToolCalls(conversationId) > 0) return result;
    const source = boundary?.kind === 'turn_start' || boundary?.kind === 'turn_end' ? boundary.turnId : null;
    if (!source || (session.activeTurnId && session.activeTurnId !== source)) return result;
    if (boundary?.kind === 'turn_end' && boundary.outcome === 'stopped') return result;
    if (!await turnHasMcpCall(sessionId, conversationId, source)) return result;
    const repair = runtime.repairsInFlight.get(conversationId);
    const confirmed = repair?.reason === 'silence' && repair.state === 'done' && repair.sessionId === sessionId;
    const owned = grant?.sessionId === sessionId && grant.turnId === source;
    if (owned && !confirmed &&
        (grant.thinkingFailed || runtime.recoveryInputAllowed(sessionId, conversationId) || runtime.tabRecoveryWanted(conversationId) || loopAfterTurnFor(conversationId) || queuedAfterTurn)) {
      result.push({ kind: 'silence', deadline: grant.until,
        visibleAt: grant.until - (grant.model === 'pro' ? 300_000 : 30_000) });
      return result;
    }
    const reloadDeadline = confirmed ? (runtime.lastBrowserRecoveryAt.get(conversationId) ?? 0) + recoveryBusyMs(grant?.model === 'pro') : undefined;
    const postReloadDeadline = owned && confirmed && grant.until === reloadDeadline ? grant.until : undefined;
    if (owned && !grant.thinkingFailed && !postReloadDeadline && grant.until > Date.now()) return result;
    const queued = rows.find(row => row.sessionId === sessionId && row.state === 'queued' && row.purpose !== 'decision' &&
      row.silenceBoundary?.conversationId === conversationId && row.silenceBoundary.turnId === source && row.silenceBoundary.listenUntil &&
      (row.silenceBoundary.nativeBusy || boundary?.kind !== 'turn_end' || boundary.outcome !== 'completed'));
    const reply = goalPendingReplyFor(conversationId);
    const goalDeadline = runtime.goalActiveFor(conversationId) && reply?.silenceSourceTurnId === source ? reply.listenUntil : undefined;
    const failedDeadline = grant?.sessionId === sessionId && grant.turnId === source && grant.thinkingFailed &&
      runtime.repairsInFlight.get(conversationId)?.state === 'done' ? grant.until : undefined;
    const deadline = queued?.silenceBoundary?.listenUntil ?? goalDeadline ?? failedDeadline ?? postReloadDeadline;
    const thinkingFailed = boundary?.kind === 'turn_end' && boundary.reason === 'thinking_failed';
    const next = queuedAfterTurn ? 'queue' : goalDeadline ? runtime.goalModeFor(conversationId) : undefined;
    if (deadline) result.push({ kind: !queued?.silenceBoundary?.nativeBusy && deadline === reloadDeadline ? 'post-reload' :
      queued?.silenceBoundary?.nativeBusy || !thinkingFailed ? 'native-busy' : 'thinking-failed', deadline,
      ...(postReloadDeadline && !queued?.silenceBoundary?.nativeBusy && deadline === reloadDeadline &&
        session.activeTurnId === source ? { generating: true as const } : {}), ...(next ? { next } : {}) });
    return result;
  }

  return { sessionRecoveryCountdowns };
}
