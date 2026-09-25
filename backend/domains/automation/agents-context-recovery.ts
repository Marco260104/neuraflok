import type { FinishResult, agentsLifecycleRuntime } from './agents.js';
import type { AliveResult } from './agents-lifecycle.js';

type Runtime = typeof agentsLifecycleRuntime;

export function createAgentContextRecovery(runtime: Runtime) {
  const {
    PRIME_ID,
    WORKER_CONTEXT_CEILING_TOKENS,
    boundAgent,
    ceilingCrossed,
    changed,
    dormantAgentForConversation,
    finishStoppedWorkerAtCeiling,
    hasStopped,
    logInfo,
    newMessage,
    primeAgent,
    recount,
    reactivateDormantRun,
    runForConversation,
    upgradeStagedFinishAtCeiling
  } = runtime;
  // Kernel ingress hook: a proven tool call from a parked *sleeping* worker reclaims its family independently of other primes, so that the noteAgentAlive() call right after it can revive the worker the same way it would inside a live run. Inside a live run a sleeping worker that keeps calling is revived on the spot ("it never actually stopped"). Parking happens the moment the last worker is thought asleep, so the last worker of every run used to be refused WORKER_SLEEPING mid-turn for exactly the calls that would have revived any of its siblings — on 2026-09-01 six workers hit that. Whether a chat that is visibly running gets its tools must not depend on that bookkeeping accident. Nothing else reactivates here: a prime's ordinary calls, a finished or failed worker, or a family whose prime is mid-handover leave the slot alone, and a lookup never reactivates.
  function reactivateDormantRunForConversation(
    conversationId: string | null | undefined,
  ): boolean {
    if (runForConversation(conversationId) || !conversationId) return false;
    const found = dormantAgentForConversation(conversationId);
    if (!found || found.agent.info.role !== "worker") return false;
    if (found.agent.info.state !== "sleeping" || !found.agent.info.revivable)
      return false;
    return reactivateDormantRun(found.owner) !== null;
  }

  /** Turn identity retained after a ceiling-crossed worker is parked by ambiguous silence. */
  function silentCeilingRecoveryTurn(
    conversationId: string | null | undefined,
  ): string | null {
    if (!conversationId) return null;
    const agent =
      boundAgent(conversationId) ??
      dormantAgentForConversation(conversationId)?.agent ??
      null;
    return agent?.info.role === "worker" &&
      agent.info.state === "sleeping" &&
      !agent.info.revivable &&
      agent.info.silenceParked
      ? (agent.info.silenceRecoveryTurnId ?? null)
      : null;
  }

  /** Pre-silence request/turn authority required before an MCP call may reclaim the worker slot. */
  function silentCeilingRecoveryAuthority(
    conversationId: string | null | undefined,
  ): { turnId: string; requestOriginMax: number } | null {
    if (!conversationId) return null;
    const agent =
      boundAgent(conversationId) ??
      dormantAgentForConversation(conversationId)?.agent ??
      null;
    const turnId = agent?.info.silenceRecoveryTurnId ?? null;
    const requestOriginMax = agent?.info.silenceRecoveryRequestOriginMax;
    if (
      !agent ||
      agent.info.role !== "worker" ||
      agent.info.state !== "sleeping" ||
      agent.info.revivable ||
      !agent.info.silenceParked ||
      !turnId ||
      !Number.isFinite(requestOriginMax)
    ) {
      return null;
    }
    return { turnId, requestOriginMax: requestOriginMax! };
  }

  // Refusal for a context-limited worker whose old turn was parked by silence but whose arriving call did not prove ownership of that exact turn. The marker is recovery eligibility, never execution authority: a new turn in the same conversation must not inherit the old turn's tools.
  function silentCeilingWorkerNotice(
    conversationId: string | null | undefined,
  ): string | null {
    if (!conversationId) return null;
    const agent =
      boundAgent(conversationId) ??
      dormantAgentForConversation(conversationId)?.agent ??
      null;
    if (
      !agent ||
      agent.info.role !== "worker" ||
      agent.info.state !== "sleeping" ||
      agent.info.revivable ||
      !agent.info.silenceParked
    ) {
      return null;
    }
    const recovery = silentCeilingRecoveryAuthority(conversationId);
    return (
      `WORKER_CONTEXT_LIMITED: ${agent.info.id} is parked because its previous turn went silent after reaching the context limit. ` +
      (recovery
        ? "Nothing was run. New work is not allowed in this chat. Only a provenance-matched call from that exact unresolved turn may resume it; otherwise stop and return to the prime conversation."
        : "Nothing was run. New work is not allowed in this chat. No complete pre-park request/turn recovery proof was retained, so wait for durable terminal evidence and return to the prime conversation.")
    );
  }

  // Reclaims a ceiling-crossed worker only after the caller independently proved that the arriving request belongs to the exact unresolved turn retained above.
  function recoverSilentCeilingWorker(
    conversationId: string,
    turnId: string,
    announce = true,
  ): AliveResult | null {
    let run = runForConversation(conversationId);
    let agent = boundAgent(conversationId);
    if (!agent) {
      const dormant = dormantAgentForConversation(conversationId);
      if (
        !dormant ||
        !dormant.agent.info.silenceParked ||
        dormant.agent.info.silenceRecoveryTurnId !== turnId
      )
        return null;
      run = reactivateDormantRun(dormant.owner);
      agent = run ? boundAgent(conversationId) : null;
    }
    if (
      !run ||
      !agent ||
      agent.info.role !== "worker" ||
      agent.info.state !== "sleeping" ||
      agent.info.revivable ||
      !agent.info.silenceParked ||
      agent.info.silenceRecoveryTurnId !== turnId
    ) {
      return null;
    }
    agent.info.state = "active";
    agent.info.sleptAt = null;
    agent.info.finishedAt = null;
    agent.info.detachedAt = null;
    agent.info.silenceParked = false;
    agent.info.silenceRecoveryTurnId = null;
    agent.info.silenceRecoveryRequestOriginMax = null;
    agent.info.lastSeenAt = Date.now();
    const report = announce
      ? newMessage(
          agent.info.id,
          PRIME_ID,
          `[${agent.info.id} is still working] Its context-limited chat was parked after silence, but an exact call from the same unresolved turn arrived. It holds its worker slot again. Do not assign new work to this chat; wait for this turn to finish.`,
        )
      : null;
    if (report) {
      const prime = primeAgent(run);
      prime.queue.push(report);
      recount(prime);
    }
    logInfo(
      `multi-agent: ${agent.info.id} resumed its exact ceiling-silenced turn ${turnId}`,
    );
    changed("critical");
    return { agentId: agent.info.id, revived: true, report };
  }

  // Makes a parked owner's map available to the existing staged-finish barrier without granting the worker execution authority. The row itself stays sleeping/context-fenced until commit. Callers must independently hold terminal evidence.
  function reactivateSilentCeilingRunForTerminal(
    conversationId: string | null | undefined,
  ): boolean {
    if (!conversationId) return false;
    let agent = boundAgent(conversationId);
    if (agent) {
      return (
        agent.info.role === "worker" &&
        agent.info.state === "sleeping" &&
        !agent.info.revivable &&
        agent.info.silenceParked === true &&
        ceilingCrossed(agent.info)
      );
    }
    const dormant = dormantAgentForConversation(conversationId);
    if (
      !dormant ||
      dormant.agent.info.role !== "worker" ||
      dormant.agent.info.state !== "sleeping" ||
      dormant.agent.info.revivable ||
      !dormant.agent.info.silenceParked ||
      !ceilingCrossed(dormant.agent.info)
    ) {
      return false;
    }
    if (!reactivateDormantRun(dormant.owner)) return false;
    agent = boundAgent(conversationId);
    return Boolean(
      agent && agent.info.state === "sleeping" && agent.info.silenceParked,
    );
  }

  /** Explicitly ends a ceiling-silenced worker, including while its family is parked. */
  function finishSilentCeilingWorker(
    conversationId: string | null | undefined,
    reason: string,
  ): FinishResult | null {
    if (!conversationId) return null;
    const agent =
      boundAgent(conversationId) ??
      dormantAgentForConversation(conversationId)?.agent ??
      null;
    if (
      !agent ||
      agent.info.role !== "worker" ||
      agent.info.state !== "sleeping" ||
      !agent.info.silenceParked ||
      !ceilingCrossed(agent.info)
    ) {
      return null;
    }
    const report = finishStoppedWorkerAtCeiling(
      agent,
      reason,
      agent.info.sleptAt ?? Date.now(),
    );
    changed("critical");
    return { info: { ...agent.info }, report: { ...report }, repeat: false };
  }

  // What the local session store measured this agent's own chat to be carrying. Fed from the durable session that records this exact conversation, never from anything a model said about itself. Monotonic within a run: a conversation's context only grows, and a transient read of a half-rebuilt summary must not be able to un-cross the ceiling and make a worker revivable again after the prime was told it was finished.
  function noteAgentContextTokens(
    conversationId: string | null | undefined,
    tokens: number,
  ): void {
    if (!conversationId || !Number.isFinite(tokens) || tokens < 0) return;
    const agent =
      boundAgent(conversationId) ??
      dormantAgentForConversation(conversationId)?.agent ??
      null;
    if (!agent || agent.info.contextTokens >= tokens) return;
    const crossed =
      !ceilingCrossed(agent.info) && tokens >= WORKER_CONTEXT_CEILING_TOKENS;
    agent.info.contextTokens = tokens;
    // Crossing never stops anything. A worker in the middle of a task keeps its slot, its inbox and its right to report; all that changes is that it can no longer be woken afterwards, which is only decided the next time it stops.
    if (crossed && agent.info.role === "worker") {
      const staged = upgradeStagedFinishAtCeiling(agent);
      if (
        !staged &&
        agent.info.state === "sleeping" &&
        !agent.info.silenceParked
      ) {
        finishStoppedWorkerAtCeiling(
          agent,
          "A late measurement crossed the context ceiling after this worker had already stopped.",
        );
      } else if (hasStopped(agent.info.state)) {
        agent.info.revivable = false;
      }
      logInfo(
        `multi-agent: ${agent.info.id} passed the ${WORKER_CONTEXT_CEILING_TOKENS} token ceiling; it keeps working but cannot be woken again`,
      );
      // The crossing can revoke wake authority or rewrite a staged finish projection. That is a critical state edge, not optional telemetry: crash recovery must never resurrect the old revivable state after this process has already measured the terminal ceiling.
      changed("critical");
      return;
    }
    changed("telemetry");
  }


  return {
    reactivateDormantRunForConversation,
    silentCeilingRecoveryTurn,
    silentCeilingRecoveryAuthority,
    silentCeilingWorkerNotice,
    recoverSilentCeilingWorker,
    reactivateSilentCeilingRunForTerminal,
    finishSilentCeilingWorker,
    noteAgentContextTokens
  };
}