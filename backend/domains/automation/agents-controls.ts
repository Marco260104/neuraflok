import type { FinishResult } from './agents-finishing.js';
import type { ClearResult } from './agents-types.js';
import type { agentsControlRuntime } from './agents.js';
import { ceilingCrossed, hasStopped, isOver } from './agents-state-policy.js';

type Runtime = typeof agentsControlRuntime;

export function createAgentControls(runtime: Runtime) {
  const {
    MAX_MESSAGE_CHARS,
    PRIME_ID,
    activeSpawnStages,
    changed,
    consecutiveWakeFailures,
    dormantRuns,
    endRun,
    failAgent,
    parkRun,
    persistRetiredWorkers,
    recount,
    runs,
    scopedRun,
    settleSpawnStage,
    retiredWorkers
  } = runtime;

  function resetSwarm(): void {
    const reason = 'the run was cleared in the app';
    for (const run of [...runs.values()]) endRun(run, reason);
    consecutiveWakeFailures.clear();
    const retiredAt = Date.now();
    let retiredDormant = false;
    for (const dormant of dormantRuns.values()) {
      for (const agent of dormant.agents.values()) {
        if (agent.info.role !== 'worker' || !agent.info.conversationId) continue;
        retiredWorkers.set(agent.info.conversationId, {
          id: agent.info.id,
          conversationId: agent.info.conversationId,
          reason,
          retiredAt
        });
        retiredDormant = true;
      }
    }
    dormantRuns.clear();
    if (retiredDormant) persistRetiredWorkers();
    changed();
  }

  function pauseSwarmForDisable(reason = 'multi-agent mode was turned off'): boolean {
    for (const stage of [...activeSpawnStages.values()]) settleSpawnStage(stage, false);
    const now = Date.now();
    let parked = false;
    let terminalizedDormant = false;
    for (const run of [...runs.values()]) {
      for (const agent of run.agents.values()) {
        if (agent.info.role !== 'worker') continue;
        const unresolvedCeilingTurn = agent.info.state === 'sleeping' && agent.info.silenceParked === true;
        if (hasStopped(agent.info.state) && !unresolvedCeilingTurn) continue;
        if (!agent.info.conversationId) {
          agent.info.state = 'failed';
          agent.info.finishedAt = now;
          agent.info.sleptAt = null;
          agent.info.detachedAt = null;
          agent.info.revivable = false;
          agent.info.silenceParked = false;
          agent.info.silenceRecoveryTurnId = null;
          agent.info.silenceRecoveryRequestOriginMax = null;
          agent.info.result = reason.slice(0, MAX_MESSAGE_CHARS);
          agent.queue = [];
          recount(agent);
          continue;
        }

        const terminal = ceilingCrossed(agent.info);
        agent.info.state = terminal ? 'finished' : 'sleeping';
        agent.info.sleptAt = now;
        agent.info.finishedAt = terminal ? now : null;
        agent.info.detachedAt = null;
        agent.info.revivable = !terminal;
        agent.info.silenceParked = false;
        agent.info.silenceRecoveryTurnId = null;
        agent.info.silenceRecoveryRequestOriginMax = null;
        recount(agent);
      }

      parked = parkRun(run, reason) || parked;
    }
    for (const dormant of dormantRuns.values()) {
      for (const agent of dormant.agents.values()) {
        if (
          agent.info.role !== 'worker' ||
          agent.info.state !== 'sleeping' ||
          !agent.info.silenceParked ||
          !ceilingCrossed(agent.info)
        ) {
          continue;
        }
        agent.info.state = 'finished';
        agent.info.sleptAt ??= now;
        agent.info.finishedAt = now;
        agent.info.detachedAt = null;
        agent.info.revivable = false;
        agent.info.silenceParked = false;
        agent.info.silenceRecoveryTurnId = null;
        agent.info.silenceRecoveryRequestOriginMax = null;
        recount(agent);
        terminalizedDormant = true;
      }
    }
    if (terminalizedDormant || runs.size === 0) changed();
    return parked || terminalizedDormant;
  }

  function clearAgent(id: string, runId?: string): ClearResult {
    const run = scopedRun(runId);
    if (id === PRIME_ID) {
      if (!run) return { cleared: 'none', report: null, reason: 'there is no run to clear' };
      const reason = 'the run was cleared in the app';
      endRun(run, reason);
      changed();
      return { cleared: 'run', report: null, reason };
    }
    const agent = run?.agents.get(id);
    if (!agent) return { cleared: 'none', report: null, reason: `${id} is not part of this run` };
    if (isOver(agent.info.state)) return { cleared: 'none', report: null, reason: `${id} has already ended` };

    const reason = 'the user cleared this worker in the app';
    const outcome: FinishResult | null = failAgent(
      id,
      reason,
      `[${id} cleared] The user ended this worker from the app. It will not report and cannot be messaged. Carry on ` +
        'without it, or spawn a replacement worker if the work still needs doing.', {}, run?.runId
    );
    return { cleared: 'worker', report: outcome?.report ?? null, reason };
  }

  return { clearAgent, pauseSwarmForDisable, resetSwarm };
}

