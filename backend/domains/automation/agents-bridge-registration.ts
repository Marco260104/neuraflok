import { logInfo } from '../../infrastructure/settings/logger.js';
import { listPendingWorkerSpawns } from './agents-spawning.js';
import type { WorkerSpawn } from './agents-types.js';
import {
  getSpawnRequest,
  isLocalAgentDeliveryActive as readLocalAgentDeliveryActive,
  runs,
  setLocalAgentDeliveryActive as writeLocalAgentDeliveryActive,
  setSpawnRequest,
  unpublishedAgents
} from './agents-runtime-state.js';

export const pendingWorkerSpawns = () => listPendingWorkerSpawns(runs, unpublishedAgents);

export function onSpawnRequest(handler: (workers: WorkerSpawn[]) => void): () => void {
  setSpawnRequest(handler);
  const owed = pendingWorkerSpawns();
  if (owed.length > 0) {
    handler(owed);
    logInfo(`multi-agent: ${owed.length} worker chat(s) still owed a tab`);
  }
  return () => {
    if (getSpawnRequest() === handler) setSpawnRequest(null);
  };
}

export function setLocalAgentDeliveryActive(active: boolean): void {
  writeLocalAgentDeliveryActive(active);
}

export function isLocalAgentDeliveryActive(): boolean {
  return readLocalAgentDeliveryActive();
}
