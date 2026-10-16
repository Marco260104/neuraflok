import type { SessionSummary } from '../../../contracts/session.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { supersededSourceConversations } from '../sessions/continuity/continuation.js';
import { requestCorrelation } from '../sessions/history/correlation.js';
import { liveConversations } from '../sessions/history/recorder.js';
import { conversationHasMcpCallSince, getSession } from '../sessions/history/store.js';
import { activeUntil } from './session-activity.js';
import type { Repair, UnattributedCandidate, UnattributedIncident } from './bridge-recovery-types.js';

export const UNATTRIBUTED_SINGLE_WINDOW_MS = 15_000;
export const UNATTRIBUTED_FIRST_WINDOW_MS = 60_000;
export const UNATTRIBUTED_FINAL_WINDOW_MS = 5 * 60_000;

interface Runtime {
  incidents: Map<string, UnattributedIncident>;
  repairsInFlight: Map<string, Repair>;
  browserPresent(): boolean;
  workerRecoveryAllowed(conversationId: string): boolean;
  stopRequestedFor(conversationId: string): boolean;
}

export function createBridgeAttributionRecovery(runtime: Runtime) {
  const { incidents, repairsInFlight, browserPresent, workerRecoveryAllowed, stopRequestedFor } = runtime;

  function repairCandidates(): UnattributedCandidate[] {
    const live = new Map(liveConversations().map(entry => [entry.conversationId, entry]));
    const candidates = new Set(activeUntil.keys());
    for (const entry of live.values()) if (entry.activeTurnId) candidates.add(entry.conversationId);
    return [...candidates].flatMap(conversationId => {
      const page = live.get(conversationId);
      const grant = activeUntil.get(conversationId);
      const sessionId = page?.sessionId ?? grant?.sessionId ?? null;
      return sessionId ? [{
        conversationId,
        sessionId,
        endedTurns: page?.endedTurns ?? 0,
        turnId: page?.activeTurnId ?? grant?.turnId ?? null
      }] : [];
    });
  }

  function retireSpentRepairs(): void {
    const live = new Map(liveConversations().map(entry => [entry.conversationId, entry]));
    for (const [conversationId, repair] of repairsInFlight) {
      if (repair.reason !== 'unattributed') continue;
      const page = live.get(conversationId);
      if (page && page.endedTurns > repair.endedTurns) repairsInFlight.delete(conversationId);
    }
  }

  function unattributedCandidateCurrent(target: UnattributedCandidate): boolean {
    const page = liveConversations().find(entry => entry.conversationId === target.conversationId);
    if (!workerRecoveryAllowed(target.conversationId)) return false;
    return !isChatBlocked(target.conversationId) && !stopRequestedFor(target.conversationId) &&
      !supersededSourceConversations().includes(target.conversationId) &&
      (!page || (page.sessionId === target.sessionId && page.endedTurns === target.endedTurns && page.activeTurnId === target.turnId));
  }

  function pendingSuspects(incident: UnattributedIncident | null): UnattributedCandidate[] {
    if (incident?.requestId && requestCorrelation(incident.requestId)) return [];
    return (incident?.candidates ?? repairCandidates()).filter(candidate =>
      !incident?.proven.has(candidate.conversationId) && !incident?.dismissed.has(candidate.conversationId) &&
      unattributedCandidateCurrent(candidate) && (incident !== null || !repairsInFlight.has(candidate.conversationId)));
  }

  function unattributedRepairEta(now = Date.now(), requestId?: string | null): number | null {
    if (!browserPresent() || (requestId && requestCorrelation(requestId))) return null;
    const known = requestId ? incidents.get(requestId) : undefined;
    const eligible = (incident: UnattributedIncident): boolean => incident.pass < 2 && pendingSuspects(incident).length > 0 &&
      (incident.pass === 0 || (incident.requestId !== null && incident.firstAttemptAt !== null &&
        incident.lastUnknownStartedAt > incident.firstAttemptAt));
    if (known && !eligible(known)) return null;
    const pending = known ? [known] : requestId ? [] : [...incidents.values()].filter(eligible);
    if (pending.length) {
      const deadline = Math.min(...pending.map(incident =>
        incident.pass === 0 ? incident.firstDueAt : incident.startedAt + UNATTRIBUTED_FINAL_WINDOW_MS));
      return Math.max(0, Math.ceil((deadline - now) / 1000));
    }
    const count = pendingSuspects(null).length;
    return count ? (count === 1 ? UNATTRIBUTED_SINGLE_WINDOW_MS : UNATTRIBUTED_FIRST_WINDOW_MS) / 1000 : null;
  }

  async function attributionCandidateProven(
    incident: UnattributedIncident,
    candidate: UnattributedCandidate,
    session: SessionSummary
  ): Promise<boolean> {
    if (session.lastToolCallAt === null || session.lastToolCallAt < incident.startedAt) return false;
    const proof = await conversationHasMcpCallSince(candidate.sessionId, candidate.conversationId, incident.startedAt, candidate.turnId);
    if (!proof) return false;
    const current = await getSession(candidate.sessionId);
    if (current?.conversationId !== candidate.conversationId || (current.activeTurnId ?? null) !== candidate.turnId ||
        !unattributedCandidateCurrent(candidate) || ![...incidents.values()].includes(incident)) return false;
    incident.proven.add(candidate.conversationId);
    return true;
  }

  async function attributionRepairAllowed(repair: Repair, session: SessionSummary | null): Promise<boolean> {
    if (!attributionRepairCurrent(repair, session)) return false;
    const scope = repair.attribution;
    if (!scope || !session) return true;
    if (await attributionCandidateProven(scope.incident, scope.candidate, session)) return false;
    return attributionRepairCurrent(repair, await getSession(repair.sessionId));
  }

  function attributionRepairCurrent(repair: Repair, session: SessionSummary | null): boolean {
    const scope = repair.attribution;
    return !scope || (!!session && session.endedAt === null && [...incidents.values()].includes(scope.incident) &&
      session.conversationId === scope.candidate.conversationId &&
      (session.activeTurnId ?? null) === scope.candidate.turnId && !session.finishTurn?.released &&
      (!scope.incident.requestId || !requestCorrelation(scope.incident.requestId)) &&
      !scope.incident.proven.has(scope.candidate.conversationId) &&
      !scope.incident.dismissed.has(scope.candidate.conversationId) && unattributedCandidateCurrent(scope.candidate));
  }

  return {
    repairCandidates,
    retireSpentRepairs,
    unattributedCandidateCurrent,
    pendingSuspects,
    unattributedRepairEta,
    attributionCandidateProven,
    attributionRepairAllowed,
    attributionRepairCurrent
  };
}
