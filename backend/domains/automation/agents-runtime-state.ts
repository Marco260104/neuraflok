import type { AgentMessage } from "../../../contracts/session.js";
import type {
  Agent,
  DormantRun,
  FinishStageState,
  RetiredChat,
  Run,
  SpawnStageState,
  WorkerSpawn,
} from "./agents-types.js";

export const runs = new Map<string, Run>();
export const dormantRuns = new Map<string, DormantRun>();
export const consecutiveWakeFailures = new Map<string, number>();
export const retiredWorkers = new Map<string, RetiredChat>();
export const unpublishedAgents = new WeakSet<Agent>();
export const unpublishedRuns = new Set<Run>();
export const activeSpawnStages = new Map<Run, SpawnStageState>();
export const unpublishedMessages = new WeakSet<AgentMessage>();
export const activeFinishStages = new Map<Agent, FinishStageState>();
export const pageGenerating = new Map<string, number>();

let livenessFloor = 0;
let spawnRequest: ((workers: WorkerSpawn[]) => void) | null = null;
let localAgentDeliveryActive = false;

export function getLivenessFloor(): number {
  return livenessFloor;
}

export function setLivenessFloor(value: number): void {
  livenessFloor = value;
}

export function getSpawnRequest(): ((workers: WorkerSpawn[]) => void) | null {
  return spawnRequest;
}

export function setSpawnRequest(
  handler: ((workers: WorkerSpawn[]) => void) | null,
): void {
  spawnRequest = handler;
}

export function isLocalAgentDeliveryActive(): boolean {
  return localAgentDeliveryActive;
}

export function setLocalAgentDeliveryActive(active: boolean): void {
  localAgentDeliveryActive = active;
}
