import type { Agent, agentsBindingRuntime } from './agents.js';

type Runtime = typeof agentsBindingRuntime;

export function createAgentBindings(runtime: Runtime) {
  const {
    PRIME_ID,
    bindAgentWorkspace,
    changed,
    dormantAgentForConversation,
    hasStopped,
    logInfo,
    logWarn,
    runForConversation,
    scopedRun,
    unpublishedAgents
  } = runtime;

  function boundAgent(conversationId: string): Agent | null {
    const run = runForConversation(conversationId);
    if (!run) return null;
    if (conversationId === run.primeConversationId) return run.agents.get(PRIME_ID) ?? null;
    for (const agent of run.agents.values()) {
      if (agent.info.conversationId === conversationId) return agent;
    }
    return null;
  }

  function activateWorker(agent: Agent, conversationId: string): boolean {
    const wasBound = agent.info.conversationId !== null;
    if (!bindWorkerConversation(agent, conversationId)) return false;
    let mutated = !wasBound;
    if (agent.info.state === 'invited') {
      agent.info.state = 'active';
      agent.info.activatedAt = Date.now();
      logInfo(`multi-agent: ${agent.info.id} is active in conversation ${conversationId}`);
      mutated = true;
    }
    if (mutated) changed();
    return true;
  }

  function bindWorkerConversation(agent: Agent, conversationId: string): boolean {
    if (!conversationId) return false;
    if (agent.info.conversationId === conversationId) return true;
    if (agent.info.conversationId) {
      logWarn(`multi-agent: refused to move ${agent.info.id} from conversation ${agent.info.conversationId} to ${conversationId}`);
      return false;
    }
    const taken = boundAgent(conversationId);
    if (taken && taken !== agent) {
      logWarn(`multi-agent: refused to bind ${agent.info.id} to conversation ${conversationId}, already held by ${taken}`);
      return false;
    }
    const dormantTaken = dormantAgentForConversation(conversationId);
    if (dormantTaken) {
      logWarn(`multi-agent: refused to bind ${agent.info.id} to conversation ${conversationId}, already owned by dormant ${dormantTaken.agent.info.id}`);
      return false;
    }
    agent.info.conversationId = conversationId;
    return true;
  }

  function bindConversation(id: string, conversationId: string, runId?: string): boolean {
    const run = scopedRun(runId);
    const agent = run?.agents.get(id);
    if (!agent || agent.info.role !== 'worker' || hasStopped(agent.info.state)) return false;
    if (unpublishedAgents.has(agent)) return false;
    const bound = activateWorker(agent, conversationId);
    if (bound && run) bindAgentWorkspace(id, conversationId, run.runId);
    return bound;
  }

  return { bindConversation, boundAgent };
}

