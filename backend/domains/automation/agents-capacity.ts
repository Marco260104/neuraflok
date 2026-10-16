import type { AgentState } from '../../../contracts/session.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import type { Agent, Run } from './agents.js';

interface Runtime {
  runs: Map<string, Run>;
  unpublishedAgents: WeakSet<Agent>;
  scopedRun(runId?: string): Run | null;
  runForConversation(conversationId: string | null | undefined): Run | null;
  occupiesSlot(state: AgentState): boolean;
}

export function createAgentCapacity(runtime: Runtime) {
  const { runs, unpublishedAgents, scopedRun, runForConversation, occupiesSlot } = runtime;

  function workingWorkers(run: Run | null): Agent[] {
    if (!run) return [];
    return [...run.agents.values()].filter(agent =>
      agent.info.role === 'worker' && occupiesSlot(agent.info.state) && !unpublishedAgents.has(agent)
    );
  }

  function freeWorkerSlots(runId?: string): number {
    const run = scopedRun(runId);
    if (!run) return runId === undefined && runs.size === 0 ? getConfig().multiAgent.maxWorkers : 0;
    return Math.max(0, getConfig().multiAgent.maxWorkers - workingWorkers(run).length);
  }

  function globalOccupiedWorkerSlots(): number {
    let occupied = 0;
    for (const run of runs.values()) {
      for (const agent of run.agents.values()) {
        if (agent.info.role === 'worker' && occupiesSlot(agent.info.state)) occupied += 1;
      }
    }
    return occupied;
  }

  function globalFreeWorkerSlots(): number {
    const limit = getConfig().multiAgent.globalMaxWorkers ?? 0;
    if (limit <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit - globalOccupiedWorkerSlots());
  }

  function waitingForSubAgents(conversationId: string | null | undefined): boolean {
    if (getConfig().multiAgent.waitForSubAgents !== true) return false;
    return workingWorkers(runForConversation(conversationId)).length > 0;
  }

  return { freeWorkerSlots, globalFreeWorkerSlots, globalOccupiedWorkerSlots, waitingForSubAgents, workingWorkers };
}
