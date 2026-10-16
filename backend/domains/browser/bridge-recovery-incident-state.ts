import type { Repair, UnattributedIncident } from './bridge-recovery-types.js';

interface Runtime {
  clearUnattributedTimer(): void;
}

// Owns the mutable registries shared by browser-recovery policies.
export function createBridgeRecoveryIncidentState() {
  const unattributedIncidents = new Map<string, UnattributedIncident>();
  const UNATTRIBUTED_REQUEST_MEMORY = 500;
  const TURN_SCOPED_REPAIRS: ReadonlySet<Repair['reason']> = new Set(['unattributed', 'assistant-error']);
  const repairsInFlight = new Map<string, Repair>();
  const lastBrowserRecoveryAt = new Map<string, number>();
  const turnRepairSpent = new Map<string, { sessionId: string; turnKey: string; token: string; at: number }>();
  const assistantRecoveryCancelled = new Map<string, { sessionId: string; turnKey: string }>();
  const failedTurnQuiet = new Map<string, { sessionId: string; outcome: 'failed' | 'stalled' }>();
  const UNCLAIMED_REPAIR_OFFERS = 10;
  const unclaimedRepairTold = new Set<string>();
  const pagelessChats = new Set<string>();

  function clear(runtime: Runtime): void {
    runtime.clearUnattributedTimer();
    unattributedIncidents.clear();
    repairsInFlight.clear();
    lastBrowserRecoveryAt.clear();
    turnRepairSpent.clear();
    assistantRecoveryCancelled.clear();
    pagelessChats.clear();
    // Reset one-time notices with incident state so later incidents can notify again.
    unclaimedRepairTold.clear();
    failedTurnQuiet.clear();
  }

  return {
    unattributedIncidents,
    UNATTRIBUTED_REQUEST_MEMORY,
    TURN_SCOPED_REPAIRS,
    repairsInFlight,
    lastBrowserRecoveryAt,
    turnRepairSpent,
    assistantRecoveryCancelled,
    failedTurnQuiet,
    UNCLAIMED_REPAIR_OFFERS,
    unclaimedRepairTold,
    pagelessChats,
    clear
  };
}
