import type { AgentInfo, AgentMessage } from '../../../contracts/session.js';
import type { Agent, FinishStageState, Run, agentsFinishingRuntime } from './agents.js';
import type { Caller } from './agents-identity.js';

type Runtime = typeof agentsFinishingRuntime;
type SwarmMutationDurability = 'critical' | 'telemetry';
export interface FinishResult {
  info: AgentInfo;
  /** The report produced for the prime, so the caller can record it durably after acceptance. */
  report: AgentMessage | null;
  /** This call found the agent already terminal and changed nothing. */
  repeat: boolean;
}

/** A finish planned for the critical persistence lane but not yet published to live readers. */
export interface StagedFinish extends FinishResult {
  commit: () => void;
  rollback: () => void;
}

export function createAgentFinishing(runtime: Runtime) {
  const {
    AgentError,
    AgentsBusyError,
    IdentityLostError,
    MAX_MESSAGE_CHARS,
    PRIME_ID,
    activeFinishStages,
    agentForConversationId,
    canStageFinish,
    canStop,
    changed,
    ceilingCrossed,
    dormantAgentForConversation,
    dormantRuns,
    exactCaller,
    getConfig,
    hasCallerIdentity,
    hasStopped,
    isOver,
    logInfo,
    logWarn,
    newMessage,
    occupiesSlot,
    primeAgent,
    primeForOwnedAgent,
    recount,
    requireEnabled,
    requireFamilySelection,
    resolve,
    retiredAgent,
    runForAgent,
    runForConversation,
    runs,
    scopedRun
  } = runtime;
  function finishTarget(caller: Caller): Agent {
    caller = exactCaller(caller);
    requireEnabled();
    requireFamilySelection(caller);
    if (!hasCallerIdentity(caller)) throw new IdentityLostError();
    // A terminal worker may retry finish after delivery loses its result, so exact conversation ownership still permits that idempotent operation.
    const agent = resolve(caller) ?? retiredAgent(caller);
    if (agent) {
      if (agent.info.role !== 'worker') {
        throw new AgentError(
          'The prime agent does not finish: the run ends when its workers have reported and the user is done with it.'
        );
      }
      return agent;
    }

    const dormant = dormantAgentForConversation(caller.conversationId)?.agent ?? null;
    // A dormant worker may only be here as a retry of a finish that already stopped it. Never treat an unexpected dormant worker call as authority to resume or mutate its history.
    if (dormant?.info.role === 'worker' && hasStopped(dormant.info.state)) return dormant;
    if (runs.size > 0) throw new AgentsBusyError();
    if (!dormant) throw new AgentError('No sub-agent run or worker history belongs to this conversation.');
    if (dormant.info.role !== 'worker') {
      throw new AgentError(
        'The prime agent does not finish: the run ends when its workers have reported and the user is done with it.'
      );
    }
    throw new AgentError(`${dormant.info.id} is dormant but has not finished, so finish cannot be retried from this state.`);
  }

  function planFinish(agent: Agent, result: string): { info: AgentInfo; report: AgentMessage } {
    const run = runForAgent(agent);
    // What the prime told this worker and cannot be shown to have reached it. Taken before terminalisation and said out loud, because this app cannot prove a tool result arrived — the guarantee it can keep is "either the worker got it or you are told it may not have". This finish call is itself the acknowledgement for anything that was offered on the worker's preceding *ordinary* tool result. Kernel retires those rows immediately after the handler returns; counting them here produces a final report that says "never confirmed" about the very messages this call confirms. A row never offered is still uncertain, and a row offered on an earlier finish result is deliberately still uncertain because this may be the retry of that lost finish result (see acknowledgeOffers(byFinish=true)).
    const unconfirmed = agent.queue
      .filter(
        (message) =>
          message.ackedAt === null && (message.offeredAt === null || message.offeredOnFinish)
      )
      .map((message) => message.id);
    // A finish is evidence that this piece of work is over, and nothing more than that. The worker's chat is still there, still holds everything it learned, and is still the cheapest place to put the next piece of work — so it sleeps rather than ends, unless its own context has grown past the point where reopening it would achieve anything.
    const terminal = ceilingCrossed(agent.info);
    const now = Date.now();
    const info: AgentInfo = {
      ...agent.info,
      state: terminal ? 'finished' : 'sleeping',
      finishedAt: terminal ? now : null,
      sleptAt: now,
      detachedAt: null,
      result: result.slice(0, MAX_MESSAGE_CHARS),
      revivable: !terminal,
      silenceParked: false,
      silenceRecoveryTurnId: null,
      silenceRecoveryRequestOriginMax: null
    };
    // Unoffered messages remain pending; only lost retries or messages to ending workers are uncertain.
    const queuedNext = terminal ? [] : unconfirmed.filter(id => agent.queue.some(message => message.id === id && message.offeredAt === null));
    const uncertain = unconfirmed.filter(id => !queuedNext.includes(id));
    const list = (ids: string[]) => `${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}`;
    const caveat =
      (uncertain.length > 0
        ? `\n(${agent.info.id} ended without ever confirming ${uncertain.length} message(s) you sent it — ` +
          `${list(uncertain)}. Assume it may not have read them and check the result against what you asked for.)`
        : '') +
      (queuedNext.length > 0
        ? `\n(${queuedNext.length} message(s) you sent ${agent.info.id} arrived after its last step — ${list(queuedNext)}. ` +
          'They are still queued for it and reach it next; there is no need to send them again.)'
        : '');
    // A worker that stops is a freed slot, and the prime is the only party that can use it — but nothing in the final report ever said so. The recorded runs show the consequence: a prime that has just been told a worker ended sits on remaining work rather than putting that capacity back to use, because "finished" reads as an ending rather than as capacity coming back. Counting is done against the workers that outlive this one, since `agent` still holds its slot at plan time.
    const max = getConfig().multiAgent.maxWorkers;
    const stillWorking = run
      ? [...run.agents.values()].filter(
          (other) =>
            other.info.role === 'worker' &&
            other.info.id !== agent.info.id &&
            occupiesSlot(other.info.state)
        ).length
      : 0;
    const free = Math.max(0, max - stillWorking);
    const slots =
      free > 0
        ? `${free} of ${max} worker slot${max === 1 ? '' : 's'} ${free === 1 ? 'is' : 'are'} free. `
        : '';
    // The final report names the reusable worker first because spawning a replacement would duplicate provider history and discard useful context.
    const capacity = terminal
      ? `
  (${agent.info.id} is finished for good: its own chat has reached the context limit, so it cannot be woken again. ` +
        `${slots}Spawn a new worker for any remaining work.)`
      : `
  (${agent.info.id} sleeping; ${slots}Reuse first: agents action=message to="${agent.info.id}". ` +
        'Spawn only when no sleeping worker is suitable or more parallel capacity is needed.)';
    const report = newMessage(
      agent.info.id,
      PRIME_ID,
      `[${agent.info.id} ${terminal ? 'finished' : 'reported'}] ${info.result}${caveat}${capacity}`
    );
    return { info, report };
  }

  // Upgrades a finish that is still behind its immediate durability barrier when session accounting proves the worker crossed the 400k ceiling in the meantime. The live Agent intentionally stays active until commit, so the staged overlay is the state that is about to become authoritative. Leaving that overlay at sleeping/revivable=true while writing contextTokens>=400k creates a crash snapshot that revives a worker which should be terminal. Keep the staged report identity stable and update only its projected authority and wording.
  function upgradeStagedFinishAtCeiling(agent: Agent): boolean {
    const stage = activeFinishStages.get(agent);
    if (
      !stage ||
      stage.settled ||
      !runProjectionStillOwned(stage.run) ||
      stage.info.state === 'finished' ||
      !ceilingCrossed(agent.info)
    ) {
      return false;
    }
    const terminal = planFinish(agent, stage.info.result ?? '');
    stage.info.state = 'finished';
    stage.info.finishedAt = stage.info.sleptAt ?? terminal.info.finishedAt ?? Date.now();
    stage.info.revivable = false;
    stage.info.contextTokens = agent.info.contextTokens;
    stage.report.text = terminal.report.text;
    return true;
  }

  function publishFinish(agent: Agent, info: AgentInfo, report: AgentMessage, durability: SwarmMutationDurability): void {
    // Only the authority fields are committed from the plan. Liveness/detach telemetry may legitimately have advanced while an immediate disk write was awaiting I/O and must not be rewound to the copy captured before that await.
    agent.info.state = info.state;
    agent.info.finishedAt = info.finishedAt;
    agent.info.sleptAt = info.sleptAt;
    agent.info.detachedAt = null;
    agent.info.result = info.result;
    agent.info.revivable = info.revivable;
    agent.info.silenceParked = false;
    agent.info.silenceRecoveryTurnId = null;
    agent.info.silenceRecoveryRequestOriginMax = null;
    // The conversation is kept either way, and for two reasons now: a retried finish from that same chat is recognised as the retry it is, and — while the worker is only sleeping — that id is the whole of what a later revival needs to reopen the chat and type into it.
    const prime = primeForOwnedAgent(agent);
    if (!prime) throw new AgentError(`Cannot find the prime that owns ${agent.info.id}.`);
    // Over the queue limit on purpose: the worker is about to stop calling tools and has no way to retry its own report.
    prime.queue.push(report);
    recount(prime);
    logInfo(`multi-agent: ${agent.info.id} ${info.state === 'finished' ? 'finished for good' : 'is sleeping'}`);
    changed(durability);
  }

  /** Whether this exact run object still owns its agent map, active or parked. */
  function runProjectionStillOwned(owner: Run): boolean {
    if (runs.get(owner.runId) === owner) return true;
    return [...dormantRuns.values()].some((history) => history.agents === owner.agents);
  }

  function stageFinish(agent: Agent, result: string, acknowledgedMessageIds: readonly string[] = []): StagedFinish {
    const run = runForAgent(agent);
    if (!canStageFinish(agent)) {
      logInfo(`multi-agent: ${agent.info.id} called finish again after it had already stopped (${agent.info.state})`);
      return {
        info: { ...agent.info },
        report: null,
        repeat: true,
        commit: () => undefined,
        rollback: () => undefined
      };
    }
    if (activeFinishStages.has(agent)) {
      throw new AgentError(
        `FINISH_IN_PROGRESS: ${agent.info.id} is already crossing its durable finish barrier. Retry the same finish after that call settles.`
      );
    }
    if (!run) throw new AgentError('No sub-agent run is active.');
    const planned = planFinish(agent, result);
    const stage: FinishStageState = {
      run,
      agent,
      ...planned,
      acknowledgedMessageIds: [...new Set(acknowledgedMessageIds)],
      settled: false
    };
    activeFinishStages.set(agent, stage);
    // This critical revision is represented only as an overlay in the immediate snapshot. Live status/inbox readers and the ordinary debounce still see the active worker until commit.
    changed();

    const settle = (accepted: boolean): void => {
      if (stage.settled) return;
      stage.settled = true;
      if (activeFinishStages.get(agent) === stage) activeFinishStages.delete(agent);
      if (!runProjectionStillOwned(stage.run) || stage.run.agents.get(agent.info.id) !== agent) return;
      if (accepted) {
        // The exact projected terminal row + report already crossed the immediate durable barrier. Publishing those same facts changes only live readers and the debounced mirror.
        if (stage.acknowledgedMessageIds.length > 0) {
          const acked = new Set(stage.acknowledgedMessageIds);
          const now = Date.now();
          let delivered = 0;
          for (const message of agent.queue) {
            if (message.ackedAt !== null || !acked.has(message.id)) continue;
            message.ackedAt = now;
            delivered += 1;
          }
          agent.info.delivered += delivered;
          recount(agent);
        }
        // Feature-disable parking may already have put the live row into `sleeping`. The staged finish is still the accepted authority projection and carries the worker's real result plus its prime report, so publish it into the same parked owner map rather than dropping it merely because the active incarnation was released while the fsync was in flight.
        publishFinish(agent, stage.info, stage.report, 'telemetry');
        return;
      }
      // A failed write generation can remain queued for durable.ts retry. Emit a newer safe pre-finish snapshot after removing the overlay so the rejected finish cannot resurrect.
      changed();
    };
    return {
      // These are the staged authority objects themselves. A session measurement may cross the context ceiling while the fsync is in flight; upgradeStagedFinishAtCeiling() then updates these same objects so both the durable snapshot and the eventual tool/bridge result say what actually committed.
      info: stage.info,
      report: stage.report,
      repeat: false,
      commit: () => settle(true),
      rollback: () => settle(false)
    };
  }

  /** Plans an explicit worker finish behind its durable acceptance barrier. */
  function stageFinishAgent(caller: Caller, result: string): StagedFinish {
    return stageFinish(finishTarget(caller), result);
  }

  // Finishing twice is one finish because delivery can lose the result and trigger a retry with slightly different wording.
  function finishAgent(caller: Caller, result: string): FinishResult {
    const agent = finishTarget(caller);
    if (!canStop(agent.info.state)) {
      logInfo(`multi-agent: ${agent.info.id} called finish again after it had already stopped (${agent.info.state})`);
      return { info: { ...agent.info }, report: null, repeat: true };
    }
    const planned = planFinish(agent, result);
    publishFinish(agent, planned.info, planned.report, 'critical');
    return { info: { ...agent.info }, report: { ...planned.report }, repeat: false };
  }

  // A settled provider-page answer releases a worker slot when no later tool call can deliver an explicit finish.
  function finishWorkerConversation(conversationId: string, result: string): FinishResult | null {
    const run = runForConversation(conversationId);
    if (!run || !conversationId) return null;
    const agent = agentForConversationId(conversationId);
    if (!agent || agent.info.role !== 'worker' || !canStop(agent.info.state)) return null;
    return finishAgent({ conversationId }, result);
  }

  /** Browser-owned counterpart to stageFinishAgent(), resolved from the worker's bound chat. */
  function stageWorkerConversationFinish(conversationId: string, result: string): StagedFinish | null {
    const run = runForConversation(conversationId);
    if (!run || !conversationId) return null;
    const agent = agentForConversationId(conversationId);
    if (!agent || agent.info.role !== 'worker' || !canStageFinish(agent)) return null;
    // A settled browser answer acknowledges ordinary tool results that no later authenticated tool call can retire.
    const acknowledged = agent.queue
      .filter((message) => message.ackedAt === null && message.offeredAt !== null && !message.offeredOnFinish)
      .map((message) => message.id);
    return stageFinish(agent, result, acknowledged);
  }

  // Ends a worker that never got off the ground, definitively. Called by whoever owns the bootstrap once it has run out of retries or time. Before this existed, giving up only deleted the queued command: the worker stayed `invited`, still counted towards the worker limit, still blocked the next bootstrap, and still promised the prime a report that could never arrive.
  function failAgent(
    id: string,
    reason: string,
    note?: string,
    options: { revivable?: boolean } = {}, runId?: string
  ): FinishResult | null {
    const run = scopedRun(runId);
    const agent = run?.agents.get(id);
    if (!run || !agent || agent.info.role !== 'worker' || isOver(agent.info.state)) return null;
    // A final answer/explicit finish is stronger evidence than a concurrent timeout/cleanup. The callers that can legitimately race this path are themselves retryable after the in-flight acceptance barrier settles, so never publish two incompatible terminal reports.
    if (activeFinishStages.has(agent)) return null;
    agent.info.state = 'failed';
    agent.info.finishedAt = Date.now();
    agent.info.detachedAt = null;
    agent.info.result = reason.slice(0, MAX_MESSAGE_CHARS);
    // Only a failure that says nothing about the turn itself may be undone by the turn proving otherwise. A tab that never opened, a worker a person cleared, and a bootstrap that ran out of retries are all verdicts about the work; a chat that was closed is not.
    agent.info.revivable = options.revivable === true;
    agent.info.silenceParked = false;
    agent.info.silenceRecoveryTurnId = null;
    agent.info.silenceRecoveryRequestOriginMax = null;
    // A revivable failure keeps whatever the prime said to it. If the worker comes back, those messages are still the instructions it never acknowledged; throwing them away here and then reviving the worker would silently drop them.
    if (!agent.info.revivable) agent.queue = [];
    recount(agent);

    const report = newMessage(
      id,
      PRIME_ID,
      note ??
        `[${id} failed] The worker did not start: ${agent.info.result}. It will not report. Continue that part of the ` +
          'work yourself. Resolve the reported startup problem before spawning a replacement; repeating the same failed startup opens more tabs without starting the work.'
    );
    const prime = primeAgent(run);
    prime.queue.push(report);
    recount(prime);
    logWarn(`multi-agent: ${id} failed — ${reason}`);
    changed();
    return { info: { ...agent.info }, report: { ...report }, repeat: false };
  }


  return {
    failAgent,
    finishAgent,
    finishWorkerConversation,
    runProjectionStillOwned,
    stageFinishAgent,
    stageWorkerConversationFinish,
    upgradeStagedFinishAtCeiling
  };
}
