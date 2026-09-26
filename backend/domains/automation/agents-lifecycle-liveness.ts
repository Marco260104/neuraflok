import type { AgentInfo, AgentMessage } from "../../../contracts/session.js";
import type { FinishResult } from "./agents.js";
import type { AliveResult, AgentLifecycleRuntime } from "./agents-lifecycle-types.js";

/** Whether a sleeping worker can be revived by its prime. */
export function canBeRevived(info: AgentInfo): boolean {
  return info.role === "worker" && info.state === "sleeping" && info.revivable;
}

export function createAgentLiveness(runtime: AgentLifecycleRuntime) {
  const {
    PAGE_GENERATING_FRESH_MS,
    PRIME_ID,
    WORKER_SILENCE_MS,
    WORKER_THINKING_MAX_MS,
    boundAgent,
    changed,
    ceilingCrossed,
    consecutiveWakeFailures,
    getLivenessFloor,
    newMessage,
    pageGenerating,
    primeAgent,
    recount,
    runForAgent,
    runForConversation,
    runs,
    sleepAgent,
  } = runtime;

  // First-hand liveness renews worker clocks only when a call or accepted new output proves work is active.
  function noteAgentAlive(
    conversationId: string | null | undefined,
    source: "call" | "page" | "turn" | "output" = "call",
    at = Date.now(),
  ): AliveResult | null {
    const primeRuns = conversationId
      ? [...runs.values()].filter(
          (owner) => owner.primeConversationId === conversationId,
        )
      : [];
    if (primeRuns.length) {
      let revived = false;
      for (const owner of primeRuns) {
        const prime = owner.agents.get(PRIME_ID)!;
        prime.info.lastSeenAt = Date.now();
        if (owner.primeGoneAt !== null || prime.info.state === "detached") {
          owner.primeGoneAt = null;
          prime.info.state = "active";
          prime.info.detachedAt = null;
          revived = true;
        }
      }
      if (revived) changed();
      return { agentId: PRIME_ID, revived, report: null };
    }
    const run = runForConversation(conversationId);
    if (!run || !conversationId) return null;
    const agent = boundAgent(conversationId);
    if (!agent) return null;
    // Reachability clears a failed browser wake, but does not renew the work deadline.
    consecutiveWakeFailures.delete(conversationId);
    const now = Date.now();
    // Page reports establish attachment, never work, so repeated recovery cannot lease an inactive worker forever.
    if (source === "page") {
      if (agent.info.state === "detached") {
        agent.info.state = "active";
        agent.info.detachedAt = null;
        changed();
        return { agentId: agent.info.id, revived: true, report: null };
      }
      return { agentId: agent.info.id, revived: false, report: null };
    }
    // A new turn or proven call can wake a worker, while replayed output and stale turns cannot.
    const sleeping =
      agent.info.state === "sleeping" || agent.info.state === "waking";
    const staleTurn =
      (source === "turn" || source === "output") &&
      at <= (agent.info.sleptAt ?? 0);
    const reportedOutput = source === "output" && agent.info.result !== null;
    if (sleeping && (staleTurn || reportedOutput)) {
      return { agentId: agent.info.id, revived: false, report: null };
    }
    // Recorder timestamps belong to accepted work, not later delivery or replay time.
    const workAt = Math.max(agent.info.lastSeenAt ?? 0, Math.min(now, at));
    // Calls after tab closure prove the worker is alive without proving its page returned.
    if (agent.info.state === "detached" && source === "call") {
      agent.info.lastSeenAt = workAt;
      return { agentId: agent.info.id, revived: false, report: null };
    }
    const ended =
      agent.info.state !== "active" && agent.info.state !== "invited";
    const hasDeliveredRevival =
      Boolean(agent.info.lastRevivalCommandId) ||
      agent.queue.some(
        (message) =>
          message.ackedAt === null &&
          message.offeredViaRevival &&
          message.offeredAt !== null,
      );
    const provedDeliveredWake =
      agent.info.state === "waking" &&
      (agent.info.revivable || hasDeliveredRevival);
    if (
      !ended ||
      (!provedDeliveredWake &&
        agent.info.state !== "detached" &&
        !agent.info.revivable)
    ) {
      agent.info.lastSeenAt = workAt;
      return { agentId: agent.info.id, revived: false, report: null };
    }
    const was = agent.info.state;
    agent.info.state = "active";
    agent.info.detachedAt = null;
    agent.info.finishedAt = null;
    agent.info.sleptAt = null;
    agent.info.revivable = false;
    agent.info.silenceParked = false;
    agent.info.silenceRecoveryTurnId = null;
    agent.info.silenceRecoveryRequestOriginMax = null;
    agent.info.lastSeenAt = workAt;
    agent.info.result = null;
    if (!agent.info.activatedAt) agent.info.activatedAt = now;
    let report: AgentMessage | null = null;
    if (was === "failed" || was === "sleeping") {
      const how =
        source === "turn" || source === "output"
          ? "published new work"
          : "made another tool call";
      report = newMessage(
        agent.info.id,
        PRIME_ID,
        was === "failed"
          ? `[${agent.info.id} is back] It was reported gone, but it is working again — it just ${how}. ` +
              "Ignore that earlier report: do not redo its work, and expect its result normally."
          : `[${agent.info.id} is awake again] It was reported asleep with its slot free, but it never actually ` +
              `stopped — it just ${how}. It is working, it holds its slot again, and its result will arrive the ` +
              "ordinary way. You do not need to wake it.",
      );
      const prime = primeAgent(run);
      prime.queue.push(report);
      recount(prime);
    }
    // Record revival after repairing state and notifying the prime.
    runtime.logInfo(
      `multi-agent: ${agent.info.id} revived from ${was} — conversation ${conversationId} is still alive (${source})`,
    );
    changed();
    return { agentId: agent.info.id, revived: true, report };
  }

  // Track fresh provider-page generation evidence used by silence recovery.
  function notePageGenerating(
    conversationId: string,
    generating: boolean,
    at = Date.now(),
  ): void {
    if (generating) pageGenerating.set(conversationId, at);
    else pageGenerating.delete(conversationId);
  }

  function pageStillGenerating(
    conversationId: string,
    since: number,
    now: number,
  ): boolean {
    const at = pageGenerating.get(conversationId);
    return (
      at !== undefined &&
      now - at < PAGE_GENERATING_FRESH_MS &&
      now - since < WORKER_THINKING_MAX_MS
    );
  }

  // Park inactive workers only after liveness, page-generation and continuation evidence checks pass.
  function sleepSilentWorkers(
    now = Date.now(),
    runId?: string,
    isWorking: (conversationId: string) => boolean = () => false,
    unresolvedTurn?: (conversationId: string) => string | null | undefined,
    requestOriginMax?: (conversationId: string) => number | null | undefined,
  ): FinishResult[] {
    const out: FinishResult[] = [];
    for (const agent of [...runs.values()]
      .filter((run) => runId === undefined || run.runId === runId)
      .flatMap((run) => [...run.agents.values()])) {
      if (
        agent.info.role !== "worker" ||
        !["active", "detached"].includes(agent.info.state) ||
        !agent.info.conversationId
      )
        continue;
      if (isWorking(agent.info.conversationId)) continue;
      const since = Math.max(
        agent.info.activatedAt ?? 0,
        agent.info.lastSeenAt ?? 0,
        getLivenessFloor(),
      );
      if (now - since < WORKER_SILENCE_MS) continue;
      if (pageStillGenerating(agent.info.conversationId, since, now)) continue;
      const observedRecoveryTurn = unresolvedTurn?.(agent.info.conversationId);
      const observedRequestOriginMax = requestOriginMax?.(
        agent.info.conversationId,
      );
      // Unknown durable-turn evidence preserves continuation authority until an owner-wide sweep can inspect its session.
      if (
        ceilingCrossed(agent.info) &&
        ((unresolvedTurn && observedRecoveryTurn === undefined) ||
          (observedRecoveryTurn &&
            requestOriginMax &&
            !Number.isFinite(observedRequestOriginMax)))
      ) {
        continue;
      }
      const recoveryTurnId = observedRecoveryTurn ?? null;
      const recoveryRequestOriginMax = Number.isFinite(observedRequestOriginMax)
        ? observedRequestOriginMax!
        : null;
      if (ceilingCrossed(agent.info)) {
        agent.info.state = "sleeping";
        agent.info.sleptAt = Date.now();
        agent.info.finishedAt = null;
        agent.info.detachedAt = null;
        agent.info.revivable = false;
        agent.info.silenceParked = true;
        agent.info.silenceRecoveryTurnId = recoveryTurnId;
        agent.info.silenceRecoveryRequestOriginMax = recoveryRequestOriginMax;
        recount(agent);
        const report = newMessage(
          agent.info.id,
          PRIME_ID,
          `[${agent.info.id} paused at context limit] No new activity was observed for three minutes, but its current turn has not durably finished. Its slot is free and no new work may be assigned to this chat. ` +
            (recoveryTurnId && recoveryRequestOriginMax !== null
              ? "An exact late call already proven to belong to that same turn may resume it."
              : "No exact turn continuation can be proven here; wait for durable terminal evidence."),
        );
        const run = runForAgent(agent);
        if (!run) continue;
        const prime = primeAgent(run);
        prime.queue.push(report);
        recount(prime);
        changed("critical");
        out.push({
          info: { ...agent.info },
          report: { ...report },
          repeat: false,
        });
        continue;
      }
      const outcome = sleepAgent(
        agent,
        "No new assistant output, native work or tool activity was observed for three minutes. Its chat is preserved and can be resumed.",
      );
      if (outcome) {
        if (outcome.info.state === "sleeping") {
          // Preserve silence-stop provenance even if recorder state does not name the response.
          agent.info.silenceParked = true;
          agent.info.silenceRecoveryTurnId = recoveryTurnId;
          agent.info.silenceRecoveryRequestOriginMax = recoveryRequestOriginMax;
          outcome.info.silenceParked = true;
          outcome.info.silenceRecoveryTurnId = recoveryTurnId;
          outcome.info.silenceRecoveryRequestOriginMax =
            recoveryRequestOriginMax;
          changed("critical");
        }
        out.push(outcome);
      }
    }
    return out;
  }

  return { noteAgentAlive, notePageGenerating, sleepSilentWorkers };
}
