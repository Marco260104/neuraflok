import type { SessionSummary } from '../../../contracts/session.js';
import type { Repair, UnattributedCandidate, UnattributedIncident } from './bridge-recovery-types.js';

interface Runtime {
  incidents: Map<string, UnattributedIncident>;
  repairsInFlight: Map<string, Repair>;
  finalWindowMs: number;
  retireSpentRepairs(): void;
  pendingSuspects(incident: UnattributedIncident): UnattributedCandidate[];
  getSession(sessionId: string): Promise<SessionSummary | null>;
  attributionCandidateProven(
    incident: UnattributedIncident,
    target: UnattributedCandidate,
    session: SessionSummary
  ): Promise<boolean>;
  queueBrowserRecovery(
    conversationId: string,
    sessionId: string,
    episode: string,
    reason: Repair['reason'],
    endedTurns: number
  ): boolean;
  changed(): void;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

// Owns the bounded timer that advances unattributed browser recovery incidents.
export function createBridgeUnattributedRecoveryTimer(runtime: Runtime) {
  const { incidents, repairsInFlight, finalWindowMs, retireSpentRepairs, pendingSuspects,
    getSession, attributionCandidateProven, queueBrowserRecovery, changed, logInfo, logWarn } = runtime;
  let timer: NodeJS.Timeout | null = null;

  function armUnattributedTick(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    const pending = [...incidents.values()].filter(incident => incident.pass < 2);
    if (!pending.length) return;
    const due = Math.min(...pending.map(incident => incident.pass === 0 ? incident.firstDueAt : incident.startedAt + finalWindowMs));
    timer = setTimeout(() => {
      timer = null;
      void tickUnattributedIncident().catch(error => logWarn(`bridge: attribution recovery failed: ${String(error)}`));
    }, Math.max(0, due - Date.now()));
    timer.unref?.();
  }

  async function tickUnattributedIncident(): Promise<void> {
    retireSpentRepairs();
    let updated = false;
    for (const incident of incidents.values()) {
      if (incident.pass === 2) continue;
      await incident.ready;
      if (incident.pass >= 2 || ![...incidents.values()].includes(incident)) continue;
      const suspects = pendingSuspects(incident);
      if (!suspects.length) { incident.pass = 2; updated = true; continue; }
      const due = incident.pass === 0 ? incident.firstDueAt : incident.startedAt + finalWindowMs;
      if (Date.now() < due) continue;
      const pass = ++incident.pass;
      updated = true;
      // No fresh same-request work after the issued first action means no second refresh.
      if (pass === 2 && (!incident.requestId || incident.firstAttemptAt === null ||
          incident.lastUnknownStartedAt <= incident.firstAttemptAt)) continue;
      for (const target of suspects) {
        const session = await getSession(target.sessionId);
        if (![...incidents.values()].includes(incident)) break;
        if (!session || session.conversationId !== target.conversationId ||
            (session.activeTurnId ?? null) !== target.turnId || session.finishTurn?.released ||
            await attributionCandidateProven(incident, target, session) ||
            !pendingSuspects(incident).includes(target)) {
          incident.dismissed.add(target.conversationId);
          continue;
        }
        if (![...incidents.values()].includes(incident)) break;
        const held = repairsInFlight.get(target.conversationId);
        if (held?.attribution?.incident === incident) repairsInFlight.delete(target.conversationId);
        else if (held) continue;
        if (queueBrowserRecovery(target.conversationId, target.sessionId,
            `unattributed:${incident.startedAt}:${pass}`, 'unattributed', target.endedTurns)) {
          const repair = repairsInFlight.get(target.conversationId)!;
          repair.attribution = { incident, candidate: target };
          if (held) { repair.progressId = held.progressId; repair.progress = held.progress; }
          logInfo(`bridge: unattributed activity — requesting refresh ${pass}/2 for ${target.conversationId}`);
        }
      }
    }
    armUnattributedTick();
    if (updated) changed();
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { armUnattributedTick, tickUnattributedIncident, clearTimer, get timer() { return timer; } };
}
