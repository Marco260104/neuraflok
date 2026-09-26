import { randomUUID } from 'node:crypto';
import type { AgentInfo, ReasoningEffort } from '../../../contracts/session.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { workerBrief } from '../../../contracts/worker-brief.js';
import { inheritWorkspace, releasePrimeWorkspace } from '../workspace/workspace.js';
import type { Caller, Family } from './agents-identity.js';
import type { Agent, DormantRun, RetiredChat, Run, SpawnStageState, WorkerSpawn } from './agents-types.js';

export interface SpawnInput {
  workers: ReadonlyArray<{ label?: string; task: string; model?: string | null; reasoning_effort?: string | null }>;
  context?: string | null;
  caller: Caller;
}

export interface SpawnResult {
  created: AgentInfo[];
  becamePrime: boolean;
  runId: string;
  defaultNotes?: string[];
}

export interface StagedSpawn extends SpawnResult {
  commit: () => void;
  rollback: () => void;
}

export function createPrimeAgent(conversationId: string | null, primeId: string): Agent {
  return {
    info: {
      id: primeId,
      role: 'prime',
      label: 'Prime',
      task: 'Coordinates the workers',
      model: null,
      reasoningEffort: null,
      state: 'active',
      createdAt: Date.now(),
      activatedAt: Date.now(),
      finishedAt: null,
      result: null,
      pending: 0,
      awaitingAck: 0,
      delivered: 0,
      conversationId,
      detachedAt: null,
      lastSeenAt: Date.now(),
      revivable: false,
      silenceParked: false,
      silenceRecoveryTurnId: null,
      silenceRecoveryRequestOriginMax: null,
      sleptAt: null,
      contextTokens: 0
    },
    queue: []
  };
}

interface WorkerBootstrapRuntime {
  scopedRun(runId?: string): Run | null;
  unpublishedAgents: WeakSet<Agent>;
  spawnRequest(): ((workers: WorkerSpawn[]) => void) | null;
  logWarn(message: string): void;
}

export function createWorkerBootstrapRequester(runtime: WorkerBootstrapRuntime) {
  return function requestWorkerBootstraps(ids: readonly string[], runId?: string): number {
    const run = runtime.scopedRun(runId);
    if (!run || ids.length === 0) return 0;
    const wanted = new Set(ids);
    const owed = [...run.agents.values()]
      .filter(agent => agent.info.role === 'worker' && agent.info.state === 'invited' &&
        !runtime.unpublishedAgents.has(agent) && wanted.has(agent.info.id))
      .map(agent => ({ runId: run.runId, primeConversationId: run.primeConversationId, id: agent.info.id,
        task: agent.info.task, model: agent.info.model, reasoningEffort: agent.info.reasoningEffort }));
    if (owed.length === 0) return 0;
    const request = runtime.spawnRequest();
    if (request) request(owed);
    else runtime.logWarn('multi-agent: no browser extension is paired, so worker chats cannot be opened automatically');
    return owed.length;
  };
}

export function listPendingWorkerSpawns(runs: Map<string, Run>, unpublishedAgents: WeakSet<Agent>): WorkerSpawn[] {
  return [...runs.values()].flatMap(run => [...run.agents.values()]
    .filter(agent => agent.info.role === 'worker' && agent.info.state === 'invited' && !unpublishedAgents.has(agent))
    .map(agent => ({ runId: run.runId, primeConversationId: run.primeConversationId, id: agent.info.id,
      task: agent.info.task, model: agent.info.model, reasoningEffort: agent.info.reasoningEffort })));
}

interface SpawnOptions {
  deferDelivery?: boolean;
  stageTopology?: boolean;
}

interface Runtime {
  PRIME_ID: string;
  MAX_CONTEXT_CHARS: number;
  MAX_TASK_CHARS: number;
  MAX_LABEL_CHARS: number;
  runs: Map<string, Run>;
  dormantRuns: Map<string, DormantRun>;
  activeSpawnStages: Map<Run, SpawnStageState>;
  unpublishedAgents: WeakSet<Agent>;
  unpublishedRuns: Set<Run>;
  makeAgentError(message: string): Error;
  makeBusyError(): Error;
  makeIdentityLostError(message?: string): Error;
  requireEnabled(): void;
  exactCaller(caller: Caller): Caller;
  requireFamilySelection(caller: Caller): void;
  runForCaller(caller: Caller, includeUnpublished?: boolean): Run | null;
  hasCallerIdentity(caller: Caller): boolean;
  resolve(caller: Caller): Agent | null;
  ownsPrime(caller: Caller, owner: Run): boolean;
  isWorkerConversation(conversationId: string): boolean;
  retiredWorkerForConversation(conversationId: string): RetiredChat | null;
  dormantRunForCaller(caller: Caller): DormantRun | null;
  reactivateDormantRun(dormant: DormantRun): Run | null;
  familyKey(owner: Family): string;
  makePrime(conversationId: string | null): Agent;
  stampOwner(owner: Run): void;
  workingWorkers(run: Run | null): Agent[];
  requestWorkerBootstraps(ids: readonly string[], runId?: string): number;
  parkRun(run: Run | null, reason: string): boolean;
  globalOccupiedWorkerSlots(): number;
  logInfo(message: string): void;
  changed(durability?: 'critical' | 'telemetry'): void;
  normalizeModel(index: number, value: string | null | undefined): string | null;
  normalizeReasoningEffort(index: number, value: string | null | undefined): ReasoningEffort | null;
}

export function createAgentSpawner(runtime: Runtime) {
  function makeWorker(id: string, label: string, task: string, model: string | null, reasoningEffort: ReasoningEffort | null): Agent {
    return {
      info: {
        id,
        role: 'worker',
        label,
        task,
        model,
        reasoningEffort,
        state: 'invited',
        createdAt: Date.now(),
        activatedAt: null,
        finishedAt: null,
        result: null,
        pending: 0,
        awaitingAck: 0,
        delivered: 0,
        conversationId: null,
        detachedAt: null,
        lastSeenAt: null,
        revivable: false,
        silenceParked: false,
        silenceRecoveryTurnId: null,
        silenceRecoveryRequestOriginMax: null,
        sleptAt: null,
        contextTokens: 0
      },
      queue: []
    };
  }

  function settleSpawnStage(stage: SpawnStageState, accepted: boolean): void {
    if (stage.settled) return;
    stage.settled = true;
    if (runtime.activeSpawnStages.get(stage.run) === stage) runtime.activeSpawnStages.delete(stage.run);
    for (const agent of stage.created) runtime.unpublishedAgents.delete(agent);
    runtime.unpublishedRuns.delete(stage.run);

    if (accepted) {
      if (runtime.runs.get(stage.run.runId) === stage.run) runtime.changed('telemetry');
      return;
    }

    const run = stage.run;
    if (runtime.runs.get(stage.run.runId) !== stage.run) return;
    for (const agent of stage.created) {
      if (run.agents.get(agent.info.id) === agent) run.agents.delete(agent.info.id);
    }
    if (stage.createdFreshRun) {
      runtime.runs.delete(run.runId);
    } else if (stage.resumedDormant) {
      releasePrimeWorkspace(run.primeConversationId, run.runId);
      runtime.dormantRuns.set(runtime.familyKey(stage.resumedDormant), {
        ...stage.resumedDormant,
        agents: run.agents,
        transfer: run.transfer
      });
      runtime.runs.delete(run.runId);
    }
    runtime.changed();
  }

  function matchExistingRequest(
    requested: ReadonlyArray<{ label: string; task: string; model: string | null; reasoningEffort: ReasoningEffort | null }>,
    live: readonly Agent[]
  ): Agent[] | null {
    if (requested.length === 0 || live.length === 0) return null;
    const shape = (label: string, task: string, model: string | null, reasoningEffort: ReasoningEffort | null): string =>
      JSON.stringify([label.trim(), task.trim(), model, reasoningEffort]);
    const taken = new Set<Agent>();
    const matched: Agent[] = [];
    for (const worker of requested) {
      const found = live.find(agent =>
        !taken.has(agent) &&
        (shape(agent.info.label, agent.info.task, agent.info.model, agent.info.reasoningEffort) ===
          shape(worker.label || agent.info.id, worker.task, worker.model, worker.reasoningEffort) ||
          shape(agent.info.label, agent.info.task, agent.info.model, agent.info.reasoningEffort) ===
            shape(worker.label, worker.task, worker.model, worker.reasoningEffort))
      );
      if (!found) return null;
      taken.add(found);
      matched.push(found);
    }
    return matched;
  }

  function spawn(input: SpawnInput, options: SpawnOptions = {}): SpawnResult {
    runtime.requireEnabled();
    input = { ...input, caller: runtime.exactCaller(input.caller) };
    runtime.requireFamilySelection(input.caller);
    let run = runtime.runForCaller(input.caller, true);
    if (run && runtime.activeSpawnStages.has(run)) {
      throw runtime.makeAgentError('SPAWN_IN_PROGRESS: another worker spawn is still crossing its durable acceptance barrier. Retry this spawn after that call finishes.');
    }
    const max = getConfig().multiAgent.maxWorkers;
    if (input.workers.length === 0) throw runtime.makeAgentError('At least one worker is required');

    const context = input.context?.trim() ?? '';
    if (context.length > runtime.MAX_CONTEXT_CHARS) {
      throw runtime.makeAgentError(`The shared context is too long (limit ${runtime.MAX_CONTEXT_CHARS} characters)`);
    }

    const planned = input.workers.map((worker, index) => {
      const task = worker.task.trim();
      if (!task) throw runtime.makeAgentError(`Worker ${index + 1} has no task. Every worker needs one.`);
      if (task.length > runtime.MAX_TASK_CHARS) throw runtime.makeAgentError(`Worker ${index + 1}'s task is too long`);
      const label = worker.label?.trim() ?? '';
      if (label.length > runtime.MAX_LABEL_CHARS) {
        throw runtime.makeAgentError(`Worker ${index + 1}'s label is too long (limit ${runtime.MAX_LABEL_CHARS} characters)`);
      }
      const model = runtime.normalizeModel(index, worker.model === undefined ? getConfig().multiAgent.defaultModel : worker.model);
      const reasoningEffort = runtime.normalizeReasoningEffort(index,
        worker.reasoning_effort === undefined ? getConfig().multiAgent.defaultReasoning : worker.reasoning_effort);
      return { label, task: workerBrief(context, task), model, reasoningEffort };
    });

    const conversationId = input.caller.conversationId ?? null;
    if (!runtime.hasCallerIdentity(input.caller)) {
      throw runtime.makeIdentityLostError(
        'UNIDENTIFIED_CALLER: this app could not prove which provider conversation this call came from, so it will not ' +
          'make this chat the prime agent of a run. No workers were created. The browser companion has to be ' +
          'connected and this conversation has to be showing its connector activity; wait a moment and call ' +
          'agents action=spawn again.'
      );
    }

    if (run) {
      const caller = runtime.resolve(input.caller);
      if (caller?.info.role === 'worker') {
        throw runtime.makeAgentError(`${caller.info.id} is a worker in this run. Workers must not create workers of their own — send the prime agent a message instead and let it decide.`);
      }
      if (!runtime.ownsPrime(input.caller, run)) throw runtime.makeBusyError();
      if (run.transfer) throw runtime.makeAgentError('PRIME_TRANSFER_IN_PROGRESS: this prime is being compacted/resumed.');
    }

    if (conversationId && (runtime.isWorkerConversation(conversationId) || runtime.retiredWorkerForConversation(conversationId))) {
      throw runtime.makeAgentError('Workers must not create workers of their own.');
    }
    if (input.caller.runId && !run && !runtime.dormantRunForCaller(input.caller)) throw runtime.makeBusyError();
    const becamePrime = run === null;
    let resumedDormant: DormantRun | null = null;
    let createdFreshRun = false;
    if (!run) {
      resumedDormant = runtime.dormantRunForCaller(input.caller);
      if (resumedDormant) {
        if (!(run = runtime.reactivateDormantRun(resumedDormant))) {
          throw runtime.makeAgentError('PRIME_TRANSFER_IN_PROGRESS: this conversation is being compacted/resumed, so its worker history cannot start a new active incarnation until that handoff settles.');
        }
      } else {
        run = {
          runId: randomUUID(),
          primeConversationId: conversationId,
          primeRequestId: conversationId ? undefined : input.caller.requestId!,
          startedAt: Date.now(),
          agents: new Map([[runtime.PRIME_ID, runtime.makePrime(conversationId)]]),
          transfer: null,
          primeGoneAt: null
        };
        runtime.runs.set(run.runId, run);
        runtime.stampOwner(run);
        createdFreshRun = true;
      }
    }
    const activeRun = run;
    if (!activeRun) throw runtime.makeAgentError('The worker history could not acquire the active run slot.');

    const live = runtime.workingWorkers(run);
    const repeat = matchExistingRequest(planned, live);
    if (repeat) {
      const runId = activeRun.runId;
      if (!options.deferDelivery) runtime.requestWorkerBootstraps(repeat.map(agent => agent.info.id), run.runId);
      runtime.logInfo(`multi-agent: repeated spawn matched ${repeat.length} existing worker(s) in run ${runId}`);
      return { created: repeat.map(agent => ({ ...agent.info })), becamePrime, runId };
    }

    if (live.length + planned.length > max) {
      const total = live.length + planned.length;
      if (resumedDormant) runtime.parkRun(run, 'a new spawn was rejected before changing its dormant history');
      else if (createdFreshRun) runtime.runs.delete(run.runId);
      throw runtime.makeAgentError(`That would make ${total} live workers; the limit set in the app is ${max}.`);
    }

    const globalMax = getConfig().multiAgent.globalMaxWorkers ?? 0;
    const globalTotal = runtime.globalOccupiedWorkerSlots() + planned.length;
    if (globalMax > 0 && globalTotal > globalMax) {
      if (resumedDormant) runtime.parkRun(run, 'a new spawn was rejected by the global worker admission cap');
      else if (createdFreshRun) runtime.runs.delete(run.runId);
      throw runtime.makeAgentError(
        `GLOBAL_WORKER_LIMIT: that would make ${globalTotal} live workers across all prime families; ` +
          `the global worker admission limit set in the app is ${globalMax}. Wait for a worker to stop and try again.`
      );
    }

    const ids: string[] = [];
    for (let n = 1; ids.length < planned.length; n++) {
      const id = `worker-${n}`;
      if (!activeRun.agents.has(id)) ids.push(id);
    }

    const created: AgentInfo[] = [];
    const createdAgents: Agent[] = [];
    for (const [index, worker] of planned.entries()) {
      const id = ids[index] as string;
      const agent = makeWorker(id, worker.label || id, worker.task, worker.model, worker.reasoningEffort);
      activeRun.agents.set(id, agent);
      runtime.stampOwner(activeRun);
      inheritWorkspace(id, activeRun.primeConversationId, activeRun.runId, activeRun.primeRequestId);
      createdAgents.push(agent);
      created.push({ ...agent.info });
    }

    if (options.stageTopology) {
      const stage: SpawnStageState = {
        run: activeRun,
        created: createdAgents,
        becamePrime,
        resumedDormant,
        createdFreshRun,
        settled: false
      };
      runtime.activeSpawnStages.set(activeRun, stage);
      for (const agent of createdAgents) runtime.unpublishedAgents.add(agent);
      if (becamePrime) runtime.unpublishedRuns.add(activeRun);
    }

    runtime.logInfo(becamePrime
      ? `multi-agent: run ${activeRun.runId} started by conversation ${conversationId} with ${created.length} worker(s)`
      : `multi-agent: created ${created.length} worker(s) in run ${activeRun.runId}`);
    runtime.changed();
    if (!options.deferDelivery) runtime.requestWorkerBootstraps(created.map(agent => agent.id), activeRun.runId);
    return { created, becamePrime, runId: activeRun.runId };
  }

  function stageSpawn(input: SpawnInput): StagedSpawn {
    const result = spawn(input, { deferDelivery: true, stageTopology: true });
    const owner = runtime.runs.get(result.runId);
    const stage = owner ? runtime.activeSpawnStages.get(owner) : undefined;
    if (!stage) return { ...result, commit: () => undefined, rollback: () => undefined };
    return {
      ...result,
      commit: () => settleSpawnStage(stage, true),
      rollback: () => settleSpawnStage(stage, false)
    };
  }

  return { settleSpawnStage, spawn, stageSpawn };
}
