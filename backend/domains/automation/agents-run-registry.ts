import { randomUUID } from 'node:crypto';
import type { Agent, DormantRun, RetiredChat, Run } from './agents.js';

interface Runtime {
  dormantRunTtlMs: number;
  boundedFormerRunIds(ids: readonly string[]): string[];
  endListeners: Set<(reason: string, retired: RetiredChat[], runId: string) => void>;
  familyKey(owner: Run | DormantRun): string;
  hasWorkingWorkers(run: Run): boolean;
  logInfo(message: string): void;
  maxDormantRuns: number;
  primeId: string;
  persistRetiredWorkers(): void;
  releasePrimeWorkspace(conversationId: string | null, runId: string): void;
  retiredWorkerTtlMs: number;
  retiredWorkers: Map<string, RetiredChat>;
  runs: Map<string, Run>;
  dormantRuns: Map<string, DormantRun>;
  unpublishedRuns: Set<Run>;
  consecutiveWakeFailures: Map<string, number>;
  notifyChanged(): void;
}

export function createAgentRunRegistry(runtime: Runtime) {
  const {
    dormantRunTtlMs,
    boundedFormerRunIds,
    endListeners,
    familyKey,
    hasWorkingWorkers,
    logInfo,
    maxDormantRuns,
    primeId,
    notifyChanged,
    persistRetiredWorkers,
    releasePrimeWorkspace,
    retiredWorkerTtlMs,
    retiredWorkers,
    runs,
    dormantRuns,
    unpublishedRuns,
    consecutiveWakeFailures
  } = runtime;

  function scopedRun(runId?: string): Run | null {
    if (runId !== undefined) return runs.get(runId) ?? null;
    return runs.size === 1 ? runs.values().next().value ?? null : null;
  }

  function runForConversation(conversationId: string | null | undefined): Run | null {
    if (!conversationId) return null;
    let found: Run | null = null;
    for (const owner of runs.values()) {
      if (owner.primeConversationId !== conversationId && ![...owner.agents.values()].some(agent => agent.info.conversationId === conversationId)) continue;
      if (found) return null;
      found = owner;
    }
    return found;
  }

  function runForAgent(agent: Agent): Run | null {
    for (const owner of runs.values()) if (owner.agents.get(agent.info.id) === agent) return owner;
    return null;
  }

  function reactivateDormantRun(dormant: DormantRun): Run | null {
    if (dormantRuns.get(familyKey(dormant)) !== dormant || dormant.transfer) return null;
    const prime = dormant.agents.get(primeId);
    if (!prime) return null;
    dormantRuns.delete(familyKey(dormant));
    const now = Date.now();
    prime.info.state = 'active';
    prime.info.detachedAt = null;
    prime.info.lastSeenAt = now;
    const run: Run = {
      runId: randomUUID(),
      formerRunIds: boundedFormerRunIds([...(dormant.formerRunIds ?? []), familyKey(dormant)]),
      primeConversationId: dormant.primeConversationId,
      primeRequestId: dormant.primeRequestId,
      startedAt: dormant.startedAt,
      agents: dormant.agents,
      transfer: dormant.transfer,
      primeGoneAt: null
    };
    runs.set(run.runId, run);
    stampOwner(run);
    logInfo(`multi-agent: reactivated workers owned by conversation ${dormant.primeConversationId} as run ${run.runId}`);
    notifyChanged();
    return run;
  }

  function stampOwner(owner: Run): void {
    for (const agent of owner.agents.values()) {
      agent.info.runId = owner.runId;
      agent.info.primeConversationId = owner.primeConversationId ?? undefined;
    }
  }

  function activeRunIds(): string[] {
    return [...runs.values()].filter(run => !unpublishedRuns.has(run)).map(run => run.runId);
  }

  function endRun(run: Run, reason: string): void {
    if (!run) return;
    releasePrimeWorkspace(run.primeConversationId, run.runId);
    const retired: RetiredChat[] = [...run.agents.values()]
      .filter(agent => agent.info.role === 'worker' && agent.info.conversationId)
      .map(agent => ({
        id: agent.info.id,
        conversationId: agent.info.conversationId as string,
        reason,
        retiredAt: Date.now()
      }));
    for (const worker of retired) retiredWorkers.set(worker.conversationId, worker);
    const what = `${run.runId} (${[...run.agents.keys()].join(', ')})`;
    runs.delete(run.runId);
    for (const worker of retired) consecutiveWakeFailures.delete(worker.conversationId);
    persistRetiredWorkers();
    logInfo(`multi-agent: ended run ${what} — ${reason}`);
    for (const listener of endListeners) listener(reason, retired, run.runId);
  }

  function parkRun(run: Run | null, reason: string): boolean {
    if (!run || hasWorkingWorkers(run)) return false;
    releasePrimeWorkspace(run.primeConversationId, run.runId);
    dormantRuns.set(familyKey(run), {
      formerRunIds: run.formerRunIds,
      primeConversationId: run.primeConversationId,
      primeRequestId: run.primeRequestId,
      startedAt: run.startedAt,
      parkedAt: Date.now(),
      agents: run.agents,
      transfer: run.transfer
    });
    runs.delete(run.runId);
    logInfo(`multi-agent: parked run ${run.runId} for conversation ${run.primeConversationId} — ${reason}`);
    pruneDormantRuns();
    notifyChanged();
    return true;
  }

  function pruneDormantRuns(now = Date.now()): boolean {
    const candidates = [...dormantRuns.values()]
      .filter(dormant => !dormant.transfer)
      .sort((left, right) => left.parkedAt - right.parkedAt);
    const evict = candidates.filter((dormant, index) =>
      now - dormant.parkedAt >= dormantRunTtlMs || candidates.length - index > maxDormantRuns
    );
    if (evict.length === 0) return false;
    for (const dormant of evict) {
      dormantRuns.delete(familyKey(dormant));
      for (const agent of dormant.agents.values()) {
        if (agent.info.role !== 'worker' || !agent.info.conversationId) continue;
        retiredWorkers.set(agent.info.conversationId, {
          id: agent.info.id,
          conversationId: agent.info.conversationId,
          reason: 'its parked worker history was dropped',
          retiredAt: now
        });
      }
      logInfo(`multi-agent: dropped the parked worker history of conversation ${dormant.primeConversationId}`);
    }
    persistRetiredWorkers();
    return true;
  }

  function pruneRetiredWorkers(): void {
    const cutoff = Date.now() - retiredWorkerTtlMs;
    let removed = false;
    for (const [conversationId, worker] of retiredWorkers) {
      if (worker.retiredAt >= cutoff) continue;
      retiredWorkers.delete(conversationId);
      removed = true;
    }
    if (removed) persistRetiredWorkers();
  }

  function retiredWorkerForConversation(conversationId: string | null | undefined): RetiredChat | null {
    pruneRetiredWorkers();
    if (!conversationId) return null;
    const worker = retiredWorkers.get(conversationId);
    return worker ? { ...worker } : null;
  }

  function hasRetiredWorkerLeases(): boolean {
    pruneRetiredWorkers();
    return retiredWorkers.size > 0;
  }

  return {
    activeRunIds,
    endRun,
    hasRetiredWorkerLeases,
    parkRun,
    pruneDormantRuns,
    pruneRetiredWorkers,
    reactivateDormantRun,
    retiredWorkerForConversation,
    runForAgent,
    runForConversation,
    scopedRun,
    stampOwner
  };
}
