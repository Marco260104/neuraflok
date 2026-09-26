interface ClearableState {
  clear(): void;
}

interface ResetRuntime {
  activeFinishStages: ClearableState;
  activeSpawnStages: ClearableState;
  consecutiveWakeFailures: ClearableState;
  dormantRuns: ClearableState;
  durability: { resetForTests(): void };
  pageGenerating: ClearableState;
  persistence: { clearArchiveCache(): void };
  requestOwnership: { reset(): void };
  retiredWorkers: ClearableState;
  revival: { reset(): void };
  runs: ClearableState;
  setLivenessFloor(value: number): void;
  setSpawnRequest(handler: null): void;
  unpublishedRuns: ClearableState;
  writeLocalAgentDeliveryActive(active: boolean): void;
}

export function createAgentStateReset(runtime: ResetRuntime): () => void {
  return function resetAgentStateForTests(): void {
    runtime.requestOwnership.reset();
    runtime.runs.clear();
    runtime.dormantRuns.clear();
    runtime.persistence.clearArchiveCache();
    runtime.consecutiveWakeFailures.clear();
    runtime.pageGenerating.clear();
    runtime.unpublishedRuns.clear();
    runtime.activeSpawnStages.clear();
    runtime.activeFinishStages.clear();
    runtime.retiredWorkers.clear();
    runtime.setLivenessFloor(0);
    runtime.setSpawnRequest(null);
    runtime.revival.reset();
    runtime.durability.resetForTests();
    runtime.writeLocalAgentDeliveryActive(false);
  };
}
