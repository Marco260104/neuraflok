import type { AgentInfo, SwarmState } from '../../../contracts/session.js';
import type { Agent, Run, agentsReadModelRuntime } from './agents.js';

type Runtime = typeof agentsReadModelRuntime;
export interface WorkerPrimeOwner {
  /** True only when this exact conversation is durably/presently owned by a worker slot. */
  owned: boolean;
  /** Null for ambiguous/provisional ownership: strict authorization must fail closed. */
  primeConversationId: string | null;
  /** Current family incarnation, useful for diagnostics only; never an authorization token. */
  runId: string | null;
}

export function createAgentReadModel(runtime: Runtime) {
  const {
    PRIME_ID,
    allFamilies,
    answersTo,
    agentForConversationId,
    dormantAgentForConversation,
    dormantRuns,
    familyKey,
    getConfig,
    runForConversation,
    runs,
    scopedRun,
    unpublishedAgents,
    unpublishedRuns
  } = runtime;
  function stateForAgents(agents: Map<string, Agent>, running: boolean, retainedHistory = !running): SwarmState {
    const list = [...agents.values()]
      .filter((agent) => !unpublishedAgents.has(agent))
      .map((agent) => ({ ...agent.info }));
    list.sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'prime' ? -1 : 1));
    return {
      enabled: getConfig().multiAgent.enabled,
      running,
      retainedHistory,
      agents: list
    };
  }

  function swarmState(runId?: string): SwarmState {
    const visible = [...runs.values()].filter(r => !unpublishedRuns.has(r) && (runId === undefined || r.runId === runId));
    return { enabled: getConfig().multiAgent.enabled, running: visible.length > 0, retainedHistory: dormantRuns.size > 0,
      retainedWorkers: [...dormantRuns.values()].filter(r => runId === undefined || answersTo(r, runId))
        .flatMap(r => stateForAgents(r.agents, false).agents.filter(agent => agent.role === 'worker')),
      agents: visible.flatMap(r => stateForAgents(r.agents, true).agents) };
  }

  function agentConversation(id: string, runId?: string): string | null {
    const run = scopedRun(runId);
    return run?.agents.get(id)?.info.conversationId ?? null;
  }

  /** Reverse lookup used to file a recorded event into the right session. */
  function agentForConversation(conversationId: string): string | null {
    if ([...runs.values()].some(owner => !unpublishedRuns.has(owner) && owner.primeConversationId === conversationId)) return PRIME_ID;
    const run = runForConversation(conversationId);
    if (!run) return null;
    if (conversationId === run.primeConversationId) return PRIME_ID;
    for (const agent of run.agents.values()) {
      if (agent.info.conversationId === conversationId) return agent.info.id;
    }
    return null;
  }

  // Exact conversation ownership for durable recording/presentation, active or dormant. This deliberately does not reactivate anything and is not a command-authority lookup. A sleeping/terminal worker keeps the same recorder identity after its active run parks, while independently durable browser commands continue to use {@link agentForConversation} plus the current run-id fence so old transport rows can never attach to dormant history.
  function agentForOwnedConversation(conversationId: string): string | null {
    return agentInfoForOwnedConversation(conversationId)?.id ?? null;
  }

  /** Exact prime identity for presentation; does not activate or adopt a parked run. */
  function primeForOwnedConversation(conversationId: string): string | null {
    if (allFamilies().some(owner => !unpublishedRuns.has(owner as Run) && owner.primeConversationId === conversationId)) return conversationId;
    const run = runForConversation(conversationId);
    if (run && agentForConversationId(conversationId)) return run.primeConversationId;
    return dormantAgentForConversation(conversationId)?.owner.primeConversationId ?? null;
  }


  // Exact worker -> prime provenance across active, terminal and dormant worker history. Unlike the presentation helpers above, authorization must not lose a worker merely because it finished, slept or parked. Inspect the published families directly, exclude unpublished staged runs, and refuse to guess if corrupted/restored state names the same worker chat twice.
  function workerPrimeOwner(conversationId: string): WorkerPrimeOwner {
    if (!conversationId) return { owned: false, primeConversationId: null, runId: null };
    const owners = allFamilies().filter((owner) => {
      if ('runId' in owner && unpublishedRuns.has(owner)) return false;
      return [...owner.agents.values()].some(
        (agent) => agent.info.role === 'worker' && agent.info.conversationId === conversationId
      );
    });
    if (owners.length === 0) return { owned: false, primeConversationId: null, runId: null };
    if (owners.length !== 1) return { owned: true, primeConversationId: null, runId: null };
    const owner = owners[0]!;
    return {
      owned: true,
      primeConversationId: owner.primeConversationId ?? null,
      runId: familyKey(owner)
    };
  }

  /** A currently occupied slot; parked history must not grant or refuse browser recovery. */
  function liveAgentForOwnedConversation(conversationId: string): AgentInfo | null {
    const agent = agentForConversationId(conversationId);
    return agent ? { ...agent.info } : null;
  }

  /** Read-only exact owner metadata for recorder/origin reconstruction across parked histories. */
  function agentInfoForOwnedConversation(conversationId: string): AgentInfo | null {
    const primes = allFamilies().filter(owner => !unpublishedRuns.has(owner as Run) && owner.primeConversationId === conversationId)
      .map(owner => owner.agents.get(PRIME_ID)!.info);
    if (primes.length) return { ...primes[0]!, runId: primes.length === 1 ? primes[0]!.runId : undefined,
      pending: primes.reduce((sum, prime) => sum + prime.pending, 0),
      awaitingAck: primes.reduce((sum, prime) => sum + prime.awaitingAck, 0),
      delivered: primes.reduce((sum, prime) => sum + prime.delivered, 0) };
    const run = runForConversation(conversationId);
    if (run) {
      const active = agentForConversationId(conversationId);
      if (active) return { ...active.info };
    }
    const dormant = dormantAgentForConversation(conversationId)?.agent ?? null;
    return dormant ? { ...dormant.info } : null;
  }

  // Whether this conversation is a worker chat this app opened — in any state, ever. The owner lookups above answer "who is working here", and deliberately skip a worker that is over: a finished chat calling tools is not a slot. This answers the other question, the one the Goal and compaction fences ask: is this a chat the loop may author in, or that a Compact & Resume may be typed into? A worker chat never becomes an ordinary chat by finishing. On 2026-09-03 two workers crossed the context ceiling, went terminal, and were from that moment invisible to `agentForOwnedConversation()`; the auto-compaction fence read them as plain chats over the line, filed tickets a worker page can never discharge, and reloaded each working page five times before giving up.
  function isWorkerConversation(conversationId: string): boolean {
    if (!conversationId) return false;
    const owns = (agents: Map<string, Agent>): boolean =>
      [...agents.values()].some((agent) => agent.info.role === 'worker' && agent.info.conversationId === conversationId);
    for (const run of runs.values()) if (owns(run.agents)) return true;
    for (const dormant of dormantRuns.values()) if (owns(dormant.agents)) return true;
    return false;
  }

  return {
    agentConversation,
    agentForConversation,
    agentForOwnedConversation,
    agentInfoForOwnedConversation,
    isWorkerConversation,
    liveAgentForOwnedConversation,
    primeForOwnedConversation,
    stateForAgents,
    swarmState,
    workerPrimeOwner
  };
}