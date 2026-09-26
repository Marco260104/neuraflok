import { getConfig } from '../../infrastructure/settings/config.js';
import { requestCorrelation } from '../sessions/history/correlation.js';
import type { AgentInfo, SwarmState } from '../../../contracts/session.js';
import { isOver } from './agents-state-policy.js';
import type { Agent, CallerSwarmStatus, DormantRun, Run } from './agents-types.js';

export interface Caller {
  conversationId?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  runId?: string;
}

export type Family = Run | DormantRun;
export type FamilyOwner = Pick<Run, 'primeConversationId' | 'primeRequestId'>;

interface Runtime {
  primeId: string;
  runs: Map<string, Run>;
  dormantRuns: Map<string, DormantRun>;
  unpublishedRuns: Set<Run>;
  makeBusyError(): Error;
  makeError(message: string): Error;
  makeIdentityLostError(): Error;
  runForConversation(conversationId: string | null | undefined): Run | null;
  stateForAgents(agents: Map<string, Agent>, running: boolean, retainedHistory?: boolean): SwarmState;
  freeWorkerSlots(runId: string): number;
  retiredAgent(caller: Caller): Agent | null;
}

export function createAgentIdentity(runtime: Runtime) {
  const { dormantRuns, freeWorkerSlots, makeBusyError, makeError, makeIdentityLostError, primeId, retiredAgent, runs, runForConversation, stateForAgents, unpublishedRuns } = runtime;

  function familyKey(owner: Family): string {
    return 'runId' in owner ? owner.runId : owner.agents.get(primeId)!.info.runId!;
  }

  function boundedFormerRunIds(ids: readonly string[]): string[] {
    const unique = [...new Set(ids)];
    if (unique.length <= MAX_FORMER_RUN_IDS) return unique;
    return [unique[0]!, ...unique.slice(-MAX_RECENT_FORMER_RUN_IDS)];
  }

  function answersTo(owner: Family, runId: string): boolean {
    return familyKey(owner) === runId || Boolean(owner.formerRunIds?.includes(runId));
  }

  function familyReplyAddress(owner: Family): string {
    return owner.formerRunIds?.[0] ?? familyKey(owner);
  }

  function allFamilies(): Family[] {
    return [...runs.values(), ...dormantRuns.values()];
  }

  function familyForAddress(runId: string): Family | null {
    const matches = allFamilies().filter(owner => !unpublishedRuns.has(owner as Run) && answersTo(owner, runId));
    return matches.length === 1 ? matches[0]! : null;
  }

  function exactCaller(caller: Caller): Caller {
    const proof = requestCorrelation(caller.requestId);
    return proof && !caller.conversationId
      ? { ...caller, conversationId: proof.conversationId, sessionId: proof.sessionId }
      : caller;
  }

  function hasCallerIdentity(caller: Caller): boolean {
    return Boolean(caller.conversationId || (getConfig().multiAgent.allowUnattributedCalls && caller.requestId));
  }

  function ownsPrime(caller: Caller, owner: FamilyOwner): boolean {
    if (owner.primeConversationId) return caller.conversationId === owner.primeConversationId;
    return Boolean(owner.primeRequestId && !requestCorrelation(owner.primeRequestId) &&
      !caller.conversationId && getConfig().multiAgent.allowUnattributedCalls && caller.requestId === owner.primeRequestId);
  }

  function belongsToFamilyIdentity(caller: Caller, owner: Family): boolean {
    return ownsPrime(caller, owner) || Boolean(caller.conversationId && [...owner.agents.values()]
      .some(agent => agent.info.role === 'worker' && agent.info.conversationId === caller.conversationId));
  }

  function familiesForCaller(input: Caller, includeUnpublished = false): Family[] {
    const caller = exactCaller(input);
    return allFamilies().filter(owner => {
      const unpublished = unpublishedRuns.has(owner as Run);
      if (unpublished && !includeUnpublished) return false;
      const stagedRequest = includeUnpublished && unpublished && owner.primeRequestId &&
        (owner.primeRequestId === caller.requestId || Boolean(caller.conversationId &&
          requestCorrelation(owner.primeRequestId)?.conversationId === caller.conversationId));
      return stagedRequest || belongsToFamilyIdentity(caller, owner);
    });
  }

  function selectedFamily(input: Caller, includeUnpublished = false): Family | null {
    const owned = familiesForCaller(input, includeUnpublished);
    if (input.runId) return owned.find(owner => familyKey(owner) === input.runId) ?? owned.find(owner => answersTo(owner, input.runId!)) ?? null;
    return owned.length === 1 ? owned[0]! : null;
  }

  function requireFamilySelection(caller: Caller): void {
    const owned = familiesForCaller(caller, true);
    if (caller.runId && !owned.some(owner => answersTo(owner, caller.runId!))) throw makeBusyError();
    if (!caller.runId && owned.length > 1) {
      throw makeError('RUN_SELECTION_REQUIRED: this caller owns several worker fleets. Use agents action=status and select the intended run_id; worker names are local to each fleet. No agent operation was performed.');
    }
  }

  function runForCaller(input: Caller, includeUnpublished = false): Run | null {
    const selected = selectedFamily(input, includeUnpublished);
    return selected && 'runId' in selected ? selected : null;
  }

  function dormantRunForCaller(input: Caller): DormantRun | null {
    const selected = selectedFamily(input);
    return selected && !('runId' in selected) ? selected : null;
  }

  function requireEnabled(): void {
    if (!getConfig().multiAgent.enabled) throw makeError('Multi-agent mode is switched off in NEURAFLOK. Ask the user to enable it.');
  }

  function agentForConversationId(conversationId: string): Agent | null {
    const run = runForConversation(conversationId);
    if (!run) return null;
    if (conversationId === run.primeConversationId) return run.agents.get(primeId) ?? null;
    for (const agent of run.agents.values()) {
      if (agent.info.conversationId === conversationId && !isOver(agent.info.state)) return agent;
    }
    return null;
  }

  function dormantAgentForConversation(conversationId: string | null | undefined): { owner: DormantRun; agent: Agent } | null {
    if (!conversationId) return null;
    let found: { owner: DormantRun; agent: Agent } | null = null;
    for (const dormant of dormantRuns.values()) {
      if (dormant.primeConversationId === conversationId) {
        const prime = dormant.agents.get(primeId);
        if (!prime || found) return null;
        found = { owner: dormant, agent: prime };
        continue;
      }
      for (const agent of dormant.agents.values()) {
        if (agent.info.role !== 'worker' || agent.info.conversationId !== conversationId) continue;
        if (found) return null;
        found = { owner: dormant, agent };
      }
    }
    return found;
  }

  function currentRunForCaller(caller: Caller): string | null {
    return runForCaller(caller)?.runId ?? null;
  }

  function agentFamiliesForCaller(input: Caller): Array<{ run_id: string; running: boolean }> {
    return familiesForCaller(input).map(owner => ({ run_id: familyKey(owner), running: 'runId' in owner }));
  }

  function agentForCaller(caller: Caller): string | null {
    if (!getConfig().multiAgent.enabled) return null;
    if (!caller.runId && familiesForCaller(caller).some(owner => ownsPrime(exactCaller(caller), owner))) return primeId;
    return resolve(caller)?.info.id ?? null;
  }

  function agentForFinishCaller(caller: Caller): string | null {
    if (!getConfig().multiAgent.enabled) return null;
    return (resolve(caller) ?? retiredAgent(caller))?.info.id ?? null;
  }

  function swarmStateForCaller(caller: Caller): SwarmState {
    caller = exactCaller(caller);
    requireEnabled();
    if (!hasCallerIdentity(caller)) throw makeIdentityLostError();
    const owned = familiesForCaller(caller).filter(owner => !caller.runId || answersTo(owner, caller.runId));
    return { enabled: true, running: owned.some(owner => 'runId' in owner),
      retainedHistory: owned.some(owner => !('runId' in owner)),
      agents: owned.flatMap(owner => stateForAgents(owner.agents, 'runId' in owner).agents) };
  }

  function statusForCaller(caller: Caller): CallerSwarmStatus {
    caller = exactCaller(caller);
    const run = runForCaller(caller);
    requireEnabled();
    if (!hasCallerIdentity(caller)) throw makeIdentityLostError();
    if (caller.runId && !selectedFamily(caller)) throw makeBusyError();
    if (run) {
      const member = resolve(caller);
      if (member) return { self: { ...member.info }, state: stateForAgents(run.agents, true), runId: run.runId,
        freeWorkerSlots: freeWorkerSlots(run.runId) };
    }
    const dormant = dormantRunForCaller(caller);
    const member = dormant && (ownsPrime(caller, dormant) ? dormant.agents.get(primeId) :
      [...dormant.agents.values()].find(agent => agent.info.role === 'worker' && agent.info.conversationId === caller.conversationId));
    if (dormant && member) return { self: { ...member.info }, state: stateForAgents(dormant.agents, false),
      runId: null, freeWorkerSlots: getConfig().multiAgent.maxWorkers };
    return { self: null, state: stateForAgents(new Map(), false, false), runId: null,
      freeWorkerSlots: getConfig().multiAgent.maxWorkers };
  }

  function resolve(caller: Caller): Agent | null {
    caller = exactCaller(caller);
    const run = runForCaller(caller);
    if (!run) return null;
    if (ownsPrime(caller, run)) return run.agents.get(primeId) ?? null;
    return [...run.agents.values()].find(agent => agent.info.conversationId === caller.conversationId && !isOver(agent.info.state)) ?? null;
  }

  function requireMember(caller: Caller): Agent {
    caller = exactCaller(caller);
    const run = runForCaller(caller);
    requireEnabled();
    if (!hasCallerIdentity(caller)) throw makeIdentityLostError();
    if (!run && runs.size > 0) throw makeBusyError();
    if (!run) throw makeError('No sub-agent run is active in this provider chat. The chat that calls agents action=spawn becomes the prime agent of a new run.');
    const agent = resolve(caller);
    if (!agent) throw makeBusyError();
    return agent;
  }

  function identify(caller: Caller): AgentInfo {
    caller = exactCaller(caller);
    requireEnabled();
    if (!hasCallerIdentity(caller)) throw makeIdentityLostError();
    const active = resolve(caller);
    if (active) return { ...active.info };
    const dormant = dormantRunForCaller(caller);
    const prime = dormant?.agents.get(primeId);
    if (prime) return { ...prime.info };
    if (runs.size > 0) throw makeBusyError();
    throw makeError('No sub-agent run or worker history belongs to this conversation. Call agents action=spawn to start one.');
  }

  return {
    agentFamiliesForCaller,
    agentForCaller,
    agentForFinishCaller,
    agentForConversationId,
    dormantAgentForConversation,
    dormantRunForCaller,
    currentRunForCaller,
    identify,
    requireEnabled,
    requireMember,
    resolve,
    runForCaller,
    statusForCaller,
    swarmStateForCaller,
    allFamilies,
    answersTo,
    boundedFormerRunIds,
    exactCaller,
    familiesForCaller,
    familyForAddress,
    familyKey,
    familyReplyAddress,
    hasCallerIdentity,
    ownsPrime,
    requireFamilySelection,
    selectedFamily
  };
}

const MAX_RECENT_FORMER_RUN_IDS = 8;
const MAX_FORMER_RUN_IDS = MAX_RECENT_FORMER_RUN_IDS + 1;
