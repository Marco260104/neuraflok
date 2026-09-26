import { randomUUID } from 'node:crypto';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { recordWorkerAssignment } from '../sessions/history/store.js';
import type { Agent, RetiredChat, Run, agentsPersistenceRuntime } from './agents.js';
import { deserializeAgents, serializeAgents, type SerializedAgent } from './agents-persistence-codec.js';

// Reads and writes the durable swarm and retired-worker snapshots.
type Runtime = typeof agentsPersistenceRuntime;

export interface RetiredWorkersSnapshot {
  version: 1;
  savedAt: number;
  workers: RetiredChat[];
}

interface DormantRunSnapshot {
  formerRunIds?: string[];
  primeConversationId: string | null;
  primeRequestId?: string;
  startedAt: number;
  parkedAt: number;
  agents: SerializedAgent[];
}

export interface SwarmSnapshot {
  // 7 adds provisional request owners and multiple recovered fleets per prime. 6 introduced independent activeRuns plus dormant histories. Top-level fields remain a sole-run compatibility projection; versions 6/7 restore from activeRuns. Versions 4/5 migrate their single active incarnation; versions before 4 are discarded because their worker identity depended on routing codes this build cannot honour.
  version: 4 | 5 | 6 | 7;
  activeRuns?: Array<{ runId: string; formerRunIds?: string[]; primeConversationId: string | null; primeRequestId?: string; startedAt: number; agents: SerializedAgent[] }>;
  savedAt: number;
  // Top-level fields are the active incarnation; all are null/empty while only history remains.
  runId: string | null;
  primeConversationId: string | null;
  startedAt: number | null;
  agents: SerializedAgent[];
  dormantRuns?: DormantRunSnapshot[];
}

export function createAgentPersistence(runtime: Runtime) {
  const {
    PRIME_ID, RETIRED_WORKER_TTL_MS, activeFinishStages, activeSpawnStages, boundedFormerRunIds, changed, dormantRuns, occupiesSlot, parkRun, pendingWorkerSpawns, pruneDormantRuns, pruneRetiredWorkers, retiredWorkers, runs, spawnRequest, stampOwner, unpublishedRuns, workingWorkers
  } = runtime;
  const archivedAssignments = new Map<string, string>();
  const codecRuntime = {
    PRIME_ID,
    activeFinishStages,
    isProviderModelId: runtime.isProviderModelId,
    logWarn,
    recount: runtime.recount,
    unpublishedAgents: runtime.unpublishedAgents,
    unpublishedMessages: runtime.unpublishedMessages
  };

function snapshotRetiredWorkers(): RetiredWorkersSnapshot {
  pruneRetiredWorkers();
  return { version: 1, savedAt: Date.now(), workers: [...retiredWorkers.values()].map((worker) => ({ ...worker })) };
}

function restoreRetiredWorkers(snapshot: RetiredWorkersSnapshot | null): void {
  retiredWorkers.clear();
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.workers)) return;
  const cutoff = Date.now() - RETIRED_WORKER_TTL_MS;
  // Every still-live lease is authority state. The old `slice(-64)` matched the previous lifetime worker-id ceiling, but histories are now intentionally unbounded; after explicit clear a long-lived prime can retire more than 64 worker conversations at once. Dropping the oldest rows on restart would let those still-open worker chats become ordinary callers.
  for (const worker of snapshot.workers) {
    if (
      !worker ||
      typeof worker.id !== 'string' ||
      typeof worker.conversationId !== 'string' ||
      !worker.conversationId ||
      typeof worker.reason !== 'string' ||
      !Number.isFinite(worker.retiredAt) ||
      worker.retiredAt < cutoff
    ) {
      continue;
    }
    retiredWorkers.set(worker.conversationId, { ...worker });
  }
}







function snapshotSwarm(): SwarmSnapshot | null {
  return buildSwarmSnapshot(false);
}



// Project only a snapshot whose broker write succeeded. Also migrate saved history before TTL pruning. Callers do not wait on it, so it never rejects: a malformed entry is skipped.
async function archiveWorkerAssignments(snapshot: SwarmSnapshot | null): Promise<void> {
  if (!snapshot || ![4, 5, 6, 7].includes(snapshot.version) || !Number.isFinite(snapshot.savedAt)) return;
  const groups = snapshot.version >= 6 && Array.isArray(snapshot.activeRuns)
    ? snapshot.activeRuns : [{ agents: snapshot.agents }];
  const workers = [...groups, ...(Array.isArray(snapshot.dormantRuns) ? snapshot.dormantRuns : [])]
    .flatMap(group => Array.isArray(group?.agents) ? group.agents : []);
  for (const agent of workers) {
    const info = agent?.info;
    if (info?.role !== 'worker' || typeof info.conversationId !== 'string' || typeof info.id !== 'string' ||
        typeof info.label !== 'string' || typeof info.task !== 'string') continue;
    const key = JSON.stringify([info.id, info.label, info.task]);
    if (archivedAssignments.get(info.conversationId) === key) continue;
    try {
      await recordWorkerAssignment({ conversationId: info.conversationId, agentId: info.id,
        label: info.label, task: info.task, recordedAt: snapshot.savedAt });
      archivedAssignments.set(info.conversationId, key);
    } catch (err) {
      logWarn(`could not archive worker presentation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Snapshot used only by the explicit critical acceptance barrier. A staged agent message has to be present in exactly the generation whose successful immediate write publishes acceptance. It must be absent from every ordinary/debounced generation, because those can reach disk before the immediate writer succeeds. Keeping this helper private makes that distinction structural rather than a convention callers can accidentally bypass.
function snapshotSwarmIncludingUnpublished(): SwarmSnapshot | null {
  return buildSwarmSnapshot(true);
}

// Earlier ids from disk: UUIDs only, never the current id, with one stable plus eight recent. A legacy snapshot that already discarded an older peer address contains no trustworthy source family for that opaque UUID, so restore preserves what exists and never reconstructs by guess.
function savedFormerRunIds(saved: unknown, current: string): string[] | undefined {
  if (!Array.isArray(saved)) return undefined;
  const ids = saved.filter((id): id is string => typeof id === 'string' && id !== current &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
  const bounded = boundedFormerRunIds(ids);
  return bounded.length ? bounded : undefined;
}

function buildSwarmSnapshot(includeUnpublished: boolean): SwarmSnapshot | null {
  const active = [...runs.values()].filter(r => includeUnpublished || !unpublishedRuns.has(r));
  const dormant = [...dormantRuns.values()];
  if (active.length === 0 && dormant.length === 0) return null;
  // Legacy top-level projection is deliberately empty with multiple owners. Version 6 readers use activeRuns exclusively; retaining a sole-owner projection keeps older diagnostic readers useful.
  const sole = active.length === 1 ? active[0] : null;
  return { version: 7, savedAt: Date.now(), runId: sole?.runId ?? null,
    primeConversationId: sole?.primeConversationId ?? null, startedAt: sole?.startedAt ?? null,
    agents: sole ? serializeAgents(sole.agents, includeUnpublished, codecRuntime) : [],
    activeRuns: active.map(r => ({ runId: r.runId, ...(r.formerRunIds?.length ? { formerRunIds: r.formerRunIds } : {}),
      primeConversationId: r.primeConversationId,
      primeRequestId: r.primeRequestId,
      startedAt: r.startedAt, agents: serializeAgents(r.agents, includeUnpublished, codecRuntime) })),
    dormantRuns: dormant.map(h => ({ ...(h.formerRunIds?.length ? { formerRunIds: h.formerRunIds } : {}),
      primeConversationId: h.primeConversationId, startedAt: h.startedAt,
      primeRequestId: h.primeRequestId,
      parkedAt: h.parkedAt, agents: serializeAgents(h.agents, includeUnpublished, codecRuntime) })) };
}

// Restores persisted runs and keeps browser-acknowledged messages from being offered twice after restart.
function restoreSwarm(snapshot: SwarmSnapshot | null): void {
  runtime.resetRequestOwnerRecovery();
  runs.clear();
  dormantRuns.clear();
  unpublishedRuns.clear();
  activeSpawnStages.clear();
  activeFinishStages.clear();
  runtime.criticalMutationRevision = 0;
  runtime.persistedCriticalRevision = 0;
  runtime.criticalPersistFlight = null;
  if (!snapshot || !Array.isArray(snapshot.agents)) return;
  if (snapshot.version !== 4 && snapshot.version !== 5 && snapshot.version !== 6 && snapshot.version !== 7) {
    logInfo('multi-agent: discarded a run saved by an older build — spawn again to start a new one.');
    return;
  }
  let repaired = false;
  const occupiedWorkers = new Set<string>();
  const occupiedPrimes = new Set<string>();
  const ordinaryPrimes = new Set<string>();

  const occupiedRequests = new Set<string>();
  const validRequestOwner = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z0-9_-]{1,100}$/i.test(value);
  const acceptOwner = (primeConversationId: string | null, agents: Map<string, Agent>, primeRequestId?: string): boolean => {
    const prime = agents.get(PRIME_ID);
    if (!prime || prime.info.role !== 'prime' || prime.info.conversationId !== primeConversationId) return false;
    if (!primeConversationId && !validRequestOwner(primeRequestId)) return false;
    if (primeRequestId && (!validRequestOwner(primeRequestId) || occupiedRequests.has(primeRequestId))) return false;
    if (primeConversationId && (occupiedWorkers.has(primeConversationId) ||
      (snapshot.version < 7 && occupiedPrimes.has(primeConversationId)) ||
      (!primeRequestId && ordinaryPrimes.has(primeConversationId)))) return false;
    const local = new Set<string>();
    for (const agent of agents.values()) {
      if (agent.info.id === PRIME_ID || !agent.info.conversationId) continue;
      if (agent.info.conversationId === primeConversationId || local.has(agent.info.conversationId) ||
        occupiedWorkers.has(agent.info.conversationId) || occupiedPrimes.has(agent.info.conversationId)) return false;
      local.add(agent.info.conversationId);
    }
    for (const conversationId of local) occupiedWorkers.add(conversationId);
    if (primeConversationId) {
      occupiedPrimes.add(primeConversationId);
      if (!primeRequestId) ordinaryPrimes.add(primeConversationId);
    }
    if (primeRequestId) occupiedRequests.add(primeRequestId);
    return true;
  };

  if (snapshot.version >= 5 && Array.isArray(snapshot.dormantRuns)) {
    for (const saved of snapshot.dormantRuns) {
      if (!saved || (!(typeof saved.primeConversationId === 'string' && saved.primeConversationId) &&
        !(snapshot.version === 7 && saved.primeConversationId === null && validRequestOwner(saved.primeRequestId))) || !Array.isArray(saved.agents)) {
        repaired = true;
        continue;
      }
      const restored = deserializeAgents(saved.agents, snapshot.savedAt, codecRuntime);
      repaired ||= restored.repaired;
      // A dormant history can never contain a slot-holder. If disk says otherwise, choosing to run it beside another owner or silently sleeping live work would both be guesses.
      if ([...restored.agents.values()].some((agent) => agent.info.role === 'worker' && occupiesSlot(agent.info.state))) {
        repaired = true;
        logWarn(`multi-agent: discarded invalid dormant history for ${saved.primeConversationId} with a live worker`);
        continue;
      }
      const previousRunId = restored.agents.get(PRIME_ID)?.info.runId;
      const runId = typeof previousRunId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previousRunId)
        ? previousRunId : randomUUID();
      if (dormantRuns.has(runId) || !acceptOwner(saved.primeConversationId, restored.agents, snapshot.version === 7 ? saved.primeRequestId : undefined)) {
        repaired = true;
        logWarn(`multi-agent: discarded conflicting dormant history for ${saved.primeConversationId}`);
        continue;
      }
      if (runId !== previousRunId) repaired = true;
      for (const agent of restored.agents.values()) {
        agent.info.runId = runId;
        agent.info.primeConversationId = saved.primeConversationId ?? undefined;
      }
      dormantRuns.set(runId, {
        formerRunIds: savedFormerRunIds(saved.formerRunIds, runId),
        primeConversationId: saved.primeConversationId,
        primeRequestId: snapshot.version === 7 ? saved.primeRequestId : undefined,
        startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt : snapshot.savedAt || Date.now(),
        parkedAt: Number.isFinite(saved.parkedAt) ? saved.parkedAt : snapshot.savedAt || Date.now(),
        agents: restored.agents,
        transfer: null
      });
    }
    // Disk is the one place old history accumulates unchecked between parkings.
    if (pruneDormantRuns()) repaired = true;
  }

  const savedRuns = snapshot.version >= 6 ? (Array.isArray(snapshot.activeRuns) ? snapshot.activeRuns : []) : [snapshot];
  for (const saved of savedRuns) {
    if (!saved) { repaired = true; continue; }
    const hasActive =
      ((typeof saved.primeConversationId === 'string' && Boolean(saved.primeConversationId)) ||
        (snapshot.version === 7 && saved.primeConversationId === null && 'primeRequestId' in saved && validRequestOwner(saved.primeRequestId))) &&
      typeof saved.runId === 'string' &&
      Boolean(saved.runId) &&
      Array.isArray(saved.agents);
    if (snapshot.version === 4 && !hasActive) {
      logInfo('multi-agent: discarded a version-4 run with no usable prime binding');
      return;
    }
    if (hasActive) {
      const primeConversationId = saved.primeConversationId;
      const primeRequestId = snapshot.version === 7 && 'primeRequestId' in saved && validRequestOwner(saved.primeRequestId)
        ? saved.primeRequestId : undefined;
      const restored = deserializeAgents(saved.agents, snapshot.savedAt, codecRuntime);
      repaired ||= restored.repaired;
      if (runs.has(saved.runId!) || dormantRuns.has(saved.runId!) || !acceptOwner(primeConversationId, restored.agents, primeRequestId)) {
        logWarn(`multi-agent: discarded active run for ${primeConversationId} because its conversation ownership conflicted`);
        repaired = true;
      } else {
        const restoredRunId =
          typeof saved.runId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.runId)
            ? saved.runId
            : randomUUID();
        if (restoredRunId !== saved.runId) {
          repaired = true;
          logWarn('multi-agent: re-keyed a restored run whose legacy incarnation id was not a full UUID');
        }
        const formerRunIds = savedFormerRunIds((saved as { formerRunIds?: unknown }).formerRunIds, restoredRunId);
        const run: Run = {
          runId: restoredRunId,
          ...(formerRunIds ? { formerRunIds } : {}),
          primeConversationId,
          primeRequestId,
          startedAt: Number.isFinite(saved.startedAt) ? (saved.startedAt as number) : snapshot.savedAt || Date.now(),
          agents: restored.agents,
          transfer: null,
          primeGoneAt: null
        };
        if (runs.has(run.runId)) { repaired = true; continue; }
        runs.set(run.runId, run);
        stampOwner(run);
      }
    }

  }

  // This process has been watching for exactly no time. Every `lastSeenAt` that came back from disk predates the restart and cannot be evidence of silence since it.
  runtime.livenessFloor = Date.now();

  // A crash can land after the final worker's sleeping snapshot but before the cheap parking write. Reconstruct ownership first, then complete that lifecycle edge deterministically.
  const restoredActiveIds = [...runs.keys()];
  for (const run of [...runs.values()]) {
    if (workingWorkers(run).length === 0) {
      parkRun(run, 'restart recovered an active incarnation with no slot-holding workers');
      repaired = true;
    }
  }
  if (repaired) changed();

  // A worker that was invited but whose chat was never bound needs it opened again. If the bridge is not registered yet — at startup it is not, because the run is restored first — this is replayed by onSpawnRequest the moment it registers.
  const stranded = pendingWorkerSpawns();
  if (stranded.length > 0 && spawnRequest) {
    spawnRequest(stranded);
    logInfo(`multi-agent: re-requested ${stranded.length} worker chat(s) that were unbound at the restart`);
  }
  const activeAgents = [...runs.values()].flatMap(r => [...r.agents.values()]);
  const pending = activeAgents.reduce((sum, agent) => sum + agent.info.pending, 0);
  logInfo(
    `multi-agent: restored ${restoredActiveIds.length ? `active runs ${restoredActiveIds.join(', ')}` : 'no active run'} with ${dormantRuns.size} dormant owner histor${dormantRuns.size === 1 ? 'y' : 'ies'} and ${pending} active undelivered message(s)`
  );
}

  function clearArchiveCache(): void { archivedAssignments.clear(); }
  return { archiveWorkerAssignments, clearArchiveCache, restoreRetiredWorkers, restoreSwarm, snapshotRetiredWorkers, snapshotSwarm, snapshotSwarmIncludingUnpublished };
}
