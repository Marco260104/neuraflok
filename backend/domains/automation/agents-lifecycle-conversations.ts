import type { Run } from "./agents.js";
import { canBeRevived } from "./agents-lifecycle-liveness.js";
import type { AgentLifecycleRuntime } from "./agents-lifecycle-types.js";

export function createAgentConversationLifecycle(runtime: AgentLifecycleRuntime) {
  const {
    PRIME_ID,
    boundAgent,
    changed,
    dormantAgentForConversation,
    dormantRuns,
    endRun,
    isOver,
    logInfo,
    occupiesSlot,
    runForConversation,
    runs,
    scopedRun,
    unpublishedAgents,
  } = runtime;

  /** Whether a run exists at all. */
  function swarmRunning(runId?: string): boolean {
    return runId === undefined ? runs.size > 0 : runs.has(runId);
  }

  /** The conversation the prime is bound to, or null when no run exists. */
  function primeConversation(runId?: string): string | null {
    return scopedRun(runId)?.primeConversationId ?? null;
  }

  /** The run identifier, or null. */
  function currentRunId(conversationId?: string): string | null {
    return (
      (conversationId === undefined
        ? scopedRun()
        : runForConversation(conversationId)
      )?.runId ?? null
    );
  }

  /** Whether Compact & Resume currently owns the prime binding transition. */
  function swarmTransferActive(runId?: string): boolean {
    return runId === undefined
      ? [...runs.values()].some((run) => Boolean(run.transfer))
      : Boolean(scopedRun(runId)?.transfer);
  }

  // Keep a run paused when its prime chat closes while workers or unread reports remain.
  function primeConversationGone(conversationId: string): boolean {
    const owned = [...runs.values()].filter(
      (run) => run.primeConversationId === conversationId,
    );
    return owned
      .map((run) => detachPrimeRun(run, conversationId))
      .some((ended) => ended);
  }

  function detachPrimeRun(run: Run, conversationId: string): boolean {
    if (run.transfer) return false;
    const prime = run.agents.get(PRIME_ID);
    const pendingPrimeReport = Boolean(
      prime?.queue.some((message) => message.ackedAt === null),
    );
    const reusable = [...run.agents.values()].some(
      (agent) =>
        agent.info.role === "worker" &&
        (occupiesSlot(agent.info.state) || canBeRevived(agent.info)),
    );
    if (!reusable && !pendingPrimeReport) {
      endRun(
        run,
        "the prime conversation was closed and no worker was left to come back to",
      );
      changed();
      return true;
    }
    if (prime && prime.info.state !== "detached") {
      prime.info.state = "detached";
      prime.info.detachedAt = Date.now();
    }
    if (run.primeGoneAt === null) {
      run.primeGoneAt = Date.now();
      logInfo(
        `multi-agent: the prime chat ${conversationId} closed, but its run keeps ${pendingPrimeReport ? "its undelivered reports" : "its workers"} until the user returns or clears it`,
      );
    }
    changed();
    return false;
  }

  // Detach a working worker when its browser tab closes.
  function workerConversationGone(conversationId: string): boolean {
    const run = runForConversation(conversationId);
    if (!run || !conversationId) return false;
    const worker = [...run.agents.values()].find(
      (agent) =>
        agent.info.role === "worker" &&
        agent.info.conversationId === conversationId &&
        occupiesSlot(agent.info.state),
    );
    if (
      !worker ||
      worker.info.state === "detached" ||
      worker.info.state === "waking"
    )
      return false;
    worker.info.state = "detached";
    worker.info.detachedAt = Date.now();
    worker.info.revivable = true;
    logInfo(
      `multi-agent: ${worker.info.id} detached — its chat was closed while its turn may still be running`,
    );
    changed();
    return true;
  }

  /** Every agent bound to a conversation, including terminal agents. */
  function endedWorkerNotice(
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
      !isOver(agent.info.state) ||
      agent.info.revivable
    )
      return null;
    return (
      `WORKER_ENDED: ${agent.info.id} has already ${agent.info.state === "finished" ? "finished" : "ended"} in this run` +
      `${agent.info.result ? ` (${agent.info.result.slice(0, 200)})` : ""}. Nothing was run. Stop working and stop ` +
      "calling tools: the prime agent is not waiting for anything else from this chat, and anything you do here now is " +
      "work nobody asked for."
    );
  }

  // Block actions from worker chats retained in dormant run history.
  function dormantWorkerNotice(
    conversationId: string | null | undefined,
  ): string | null {
    const found = dormantAgentForConversation(conversationId);
    const agent = found?.agent ?? null;
    if (!agent || agent.info.role !== "worker") return null;
    if (isOver(agent.info.state)) {
      return (
        `WORKER_ENDED: ${agent.info.id} remains part of its prime's dormant worker history but is ${agent.info.state} and cannot act again. ` +
        "Nothing was run. Stop working and return to the prime conversation."
      );
    }
    if (agent.info.state !== "sleeping" || !agent.info.revivable) return null;
    return (
      `WORKER_SLEEPING: ${agent.info.id} belongs to the dormant worker history owned by its prime conversation. ` +
      "Nothing was run. Stay stopped until that prime sends a new agents message into this exact chat."
    );
  }

  // Return stopped worker chats beyond the most recently used keep count.
  function closableWorkerConversations(keep: number): string[] {
    const stopped: Array<{ conversationId: string; usedAt: number }> = [];
    const families = [...runs.values(), ...dormantRuns.values()].map(
      (owner) => owner.agents,
    );
    for (const agents of families) {
      for (const agent of agents.values()) {
        const info = agent.info;
        if (
          info.role !== "worker" ||
          !info.conversationId ||
          unpublishedAgents.has(agent)
        )
          continue;
        if (info.state === "sleeping" && info.silenceParked && !info.revivable)
          continue;
        if (
          info.state !== "sleeping" &&
          info.state !== "finished" &&
          info.state !== "failed"
        )
          continue;
        stopped.push({
          conversationId: info.conversationId,
          usedAt: Math.max(
            info.activatedAt ?? 0,
            info.sleptAt ?? 0,
            info.finishedAt ?? 0,
            info.lastSeenAt ?? 0,
          ),
        });
      }
    }
    stopped.sort((a, b) => a.usedAt - b.usedAt);
    const surplus = Math.max(0, stopped.length - Math.max(0, keep));
    return stopped.slice(0, surplus).map((entry) => entry.conversationId);
  }

  /** Whether dormant history retains any worker conversation identities. */
  function hasDormantWorkerLeases(): boolean {
    for (const dormant of dormantRuns.values()) {
      if (
        [...dormant.agents.values()].some(
          (agent) =>
            agent.info.role === "worker" && Boolean(agent.info.conversationId),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  return {
    swarmRunning,
    primeConversation,
    currentRunId,
    swarmTransferActive,
    primeConversationGone,
    workerConversationGone,
    endedWorkerNotice,
    dormantWorkerNotice,
    closableWorkerConversations,
    hasDormantWorkerLeases,
  };
}
