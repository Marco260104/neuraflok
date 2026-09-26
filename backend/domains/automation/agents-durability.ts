import type { RetiredWorkersSnapshot, SwarmSnapshot } from './agents-persistence.js';
import type { RetiredChat } from './agents-types.js';

interface Runtime {
  archiveWorkerAssignments(snapshot: SwarmSnapshot | null): Promise<void>;
  snapshotRetiredWorkers(): RetiredWorkersSnapshot;
  snapshotSwarmIncludingUnpublished(): SwarmSnapshot | null;
}

export function createAgentDurability(runtime: Runtime) {
  const listeners = new Set<() => void>();
  const endListeners = new Set<(reason: string, retired: RetiredChat[], runId: string) => void>();
  let persist: (() => void) | null = null;
  let persistNow: ((snapshot: SwarmSnapshot | null) => Promise<void>) | null = null;
  let criticalMutationRevision = 0;
  let persistedCriticalRevision = 0;
  let criticalPersistFlight: Promise<boolean> | null = null;
  let retiredPersist: (() => void) | null = null;
  let retiredPersistNow: ((snapshot: RetiredWorkersSnapshot) => Promise<void>) | null = null;

  function onSwarmChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function changed(durability: 'critical' | 'telemetry' = 'critical'): void {
    if (durability === 'critical') criticalMutationRevision += 1;
    persist?.();
    for (const listener of listeners) listener();
  }

  function onSwarmPersist(handler: (() => void) | null): void {
    persist = handler;
  }

  function onSwarmPersistNow(handler: ((snapshot: SwarmSnapshot | null) => Promise<void>) | null): void {
    persistNow = handler;
  }

  async function persistCriticalSwarmNow(): Promise<boolean> {
    if (!persistNow) return false;
    if (persistedCriticalRevision >= criticalMutationRevision) return true;
    if (!criticalPersistFlight) {
      criticalPersistFlight = (async () => {
        while (persistedCriticalRevision < criticalMutationRevision) {
          const handler = persistNow;
          if (!handler) return false;
          const targetRevision = criticalMutationRevision;
          const snapshot = runtime.snapshotSwarmIncludingUnpublished();
          await handler(snapshot);
          void runtime.archiveWorkerAssignments(snapshot);
          persistedCriticalRevision = Math.max(persistedCriticalRevision, targetRevision);
        }
        return true;
      })().finally(() => {
        criticalPersistFlight = null;
      });
    }
    return criticalPersistFlight;
  }

  function onRetiredWorkersPersist(handler: (() => void) | null): void {
    retiredPersist = handler;
  }

  function onRetiredWorkersPersistNow(handler: ((snapshot: RetiredWorkersSnapshot) => Promise<void>) | null): void {
    retiredPersistNow = handler;
  }

  async function persistRetiredWorkersNow(): Promise<boolean> {
    const handler = retiredPersistNow;
    if (!handler) return false;
    await handler(runtime.snapshotRetiredWorkers());
    return true;
  }

  async function persistAgentAuthorityNow(): Promise<boolean> {
    if (!(await persistRetiredWorkersNow())) return false;
    return persistCriticalSwarmNow();
  }

  function onSwarmEnd(listener: (reason: string, retired: RetiredChat[], runId: string) => void): () => void {
    endListeners.add(listener);
    return () => endListeners.delete(listener);
  }

  function resetForTests(): void {
    persist = null;
    persistNow = null;
    criticalMutationRevision = 0;
    persistedCriticalRevision = 0;
    criticalPersistFlight = null;
    retiredPersist = null;
    retiredPersistNow = null;
    listeners.clear();
    endListeners.clear();
  }

  return {
    changed,
    endListeners,
    onRetiredWorkersPersist,
    onRetiredWorkersPersistNow,
    onSwarmChange,
    onSwarmEnd,
    onSwarmPersist,
    onSwarmPersistNow,
    persistAgentAuthorityNow,
    persistCriticalSwarmNow,
    persistRetiredWorkers: () => retiredPersist?.(),
    persistRetiredWorkersNow,
    resetForTests,
    get criticalMutationRevision() { return criticalMutationRevision; },
    set criticalMutationRevision(value: number) { criticalMutationRevision = value; },
    get persistedCriticalRevision() { return persistedCriticalRevision; },
    set persistedCriticalRevision(value: number) { persistedCriticalRevision = value; },
    get criticalPersistFlight() { return criticalPersistFlight; },
    set criticalPersistFlight(value: Promise<boolean> | null) { criticalPersistFlight = value; }
  };
}
