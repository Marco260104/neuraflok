import { randomUUID } from 'node:crypto';
import type { AgentMessage } from "../../../contracts/session.js";
import type { Agent, Caller, agentsMessagingRuntime } from "./agents.js";
import { createAgentMessageStaging } from "./agents-messaging/staging.js";
export type { StagedAgentMessages, StagedPrimeMessage } from "./agents-messaging/staging.js";

type Runtime = typeof agentsMessagingRuntime;

export function createAgentMessage(from: string, to: string, text: string): AgentMessage {
  return {
    id: randomUUID().slice(0, 8),
    from,
    to,
    time: Date.now(),
    text,
    offeredAt: null,
    offers: 0,
    offeredOnFinish: false,
    offeredViaRevival: false,
    ackedAt: null
  };
}

// Coordinates routed messages, staged delivery and inbox acknowledgements.
export function createAgentMessaging(runtime: Runtime) {
  const {
    MAX_INBOX_OFFER_CHARS,
    PRIME_ID,
    activeSpawnStages,
    allFamilies,
    answersTo,
    boundAgent,
    changed,
    dormantAgentForConversation,
    exactCaller,
    familiesForCaller,
    familyKey,
    hasStopped,
    isOver,
    ownsPrime,
    parkRun,
    recount,
    runForConversation,
    runs,
    scopedRun,
    selectedFamily,
    unpublishedMessages,
    workingWorkers,
  } = runtime;
  const { stagePrimeMessage, stageMessages } = createAgentMessageStaging(runtime);

  // The over-and-done slot a caller belongs to, if it belongs to one. Terminal agents are invisible to ordinary resolution on purpose — nothing in a run should route to them — but a retried `finish` still has to be answered honestly. This is the one lookup that can see them.
  function retiredAgent(caller: Caller): Agent | null {
    const run = runForConversation(caller.conversationId);
    if (!run || !caller.conversationId) return null;
    for (const agent of run.agents.values()) {
      if (
        agent.info.conversationId === caller.conversationId &&
        isOver(agent.info.state)
      )
        return agent;
    }
    return null;
  }

  // Sends a message from the caller — whoever the broker says that is — to `toId`. There is deliberately no "from" parameter. The sender is derived from the caller's binding, so the star topology cannot be sidestepped by writing someone else's id.
  function sendMessage(
    caller: Caller,
    toId: string,
    text: string,
  ): AgentMessage {
    return sendMessages(caller, [{ to: toId, text }])[0] as AgentMessage;
  }

  /** Immediate broker API used by internal/unit callers that do not expose a durable-acceptance result. */
  function sendMessages(
    caller: Caller,
    items: ReadonlyArray<{ to: string; text: string; label?: string }>,
  ): AgentMessage[] {
    const staged = stageMessages(caller, items);
    staged.commit();
    return staged.messages;
  }

  // Offer unacknowledged messages at least once so a dropped MCP result cannot lose them; repeated offers are labeled and finish-result retries remain idempotent.
  function offerMessages(
    id: string,
    onFinish = false,
    runId?: string,
  ): AgentMessage[] {
    const run = scopedRun(runId);
    const agent = run?.agents.get(id);
    if (!agent) return [];
    return offerAgentMessages(agent, onFinish);
  }

  function offerAgentMessages(
    agent: Agent,
    onFinish = false,
    maxChars = MAX_INBOX_OFFER_CHARS,
  ): AgentMessage[] {
    // While the browser owns a wake, deliver its queued text only as the user message and never duplicate it in an MCP result.
    const browserOwnsWake =
      agent.info.role === "worker" &&
      agent.info.state === "waking" &&
      !agent.info.revivable;
    if (browserOwnsWake) return [];
    const waiting: AgentMessage[] = [];
    let offeredChars = 0;
    for (const message of agent.queue) {
      if (
        message.ackedAt !== null ||
        message.offeredViaRevival ||
        unpublishedMessages.has(message)
      )
        continue;
      if (offeredChars + message.text.length > maxChars) break;
      waiting.push(message);
      offeredChars += message.text.length;
    }
    if (waiting.length === 0) return [];
    const now = Date.now();
    for (const message of waiting) {
      message.offeredAt = now;
      message.offers += 1;
      message.offeredOnFinish = onFinish;
    }
    recount(agent);
    changed("telemetry");
    return waiting.map((message) => ({ ...message }));
  }

  /** Caller-scoped inbox offer that remains safe when another owner has an active worker-1. */
  function offerMessagesForConversation(
    conversationId: string | null | undefined,
    onFinish = false,
    allowDormantWorkerFinishRetry = false,
  ): { agentId: string; messages: AgentMessage[] } | null {
    if (!conversationId) return null;
    if (
      allFamilies().some(
        (owner) => owner.primeConversationId === conversationId,
      )
    ) {
      if (!familiesForCaller({ conversationId }).length) return null;
      return offerMessagesForCaller(
        { conversationId },
        onFinish,
        allowDormantWorkerFinishRetry,
      );
    }
    const active = boundAgent(conversationId);
    if (active)
      return {
        agentId: active.info.id,
        messages: offerAgentMessages(active, onFinish),
      };
    const dormant = dormantAgentForConversation(conversationId);
    if (!dormant) return null;
    // A dormant worker is stopped and must never receive ordinary broker work through an MCP result. The sole exception is an exact retry of its own finish call after the first finish result was lost: rows offered on that finish result must be re-offered rather than silently abandoned merely because the same finish also parked the run.
    if (dormant.agent.info.role === "worker") {
      if (
        !allowDormantWorkerFinishRetry ||
        !onFinish ||
        !hasStopped(dormant.agent.info.state)
      )
        return null;
      return {
        agentId: dormant.agent.info.id,
        messages: offerAgentMessages(dormant.agent, true),
      };
    }
    return {
      agentId: PRIME_ID,
      messages: offerAgentMessages(dormant.agent, onFinish),
    };
  }

  /** A missing browser attachment does not interrupt a request-owned prime's inbox. */
  function offerMessagesForCaller(
    input: Caller,
    onFinish = false,
    allowDormantWorkerFinishRetry = false,
  ): {
    agentId: string;
    messages: Array<AgentMessage & { runId?: string }>;
  } | null {
    const caller = exactCaller(input);
    const owned = familiesForCaller(caller).filter(
      (owner) =>
        ownsPrime(caller, owner) &&
        (!caller.runId || answersTo(owner, caller.runId)),
    );
    if (owned.length) {
      let budget = MAX_INBOX_OFFER_CHARS;
      const messages = owned.flatMap((owner) =>
        offerAgentMessages(owner.agents.get(PRIME_ID)!, onFinish, budget).map(
          (message) => {
            budget -= message.text.length;
            return owned.length > 1
              ? { ...message, runId: familyKey(owner) }
              : message;
          },
        ),
      );
      return { agentId: PRIME_ID, messages };
    }
    if (caller.runId && !selectedFamily(caller)) return null;
    return offerMessagesForConversation(
      caller.conversationId,
      onFinish,
      allowDormantWorkerFinishRetry,
    );
  }

  // Retires everything previously offered to this agent, except what this call cannot honestly be said to have proven. Called at the start of that agent's next authenticated call, because that call is the best evidence available that the previous tool result made it back into the conversation. Evidence, not proof — so a message offered on a `finish` result is not retired by another `finish`, which would otherwise let a worker's own retry count an unread message as delivered and then terminalise it.
  function acknowledgeOffers(
    id: string,
    byFinish = false,
    callStartedAt = Number.POSITIVE_INFINITY,
    runId?: string,
  ): AgentMessage[] {
    const run = scopedRun(runId);
    const agent = run?.agents.get(id);
    if (!agent) return [];
    return acknowledgeAgentOffers(agent, byFinish, callStartedAt);
  }

  function acknowledgeAgentOffers(
    agent: Agent,
    byFinish = false,
    callStartedAt = Number.POSITIVE_INFINITY,
  ): AgentMessage[] {
    const offered = agent.queue.filter(
      (message) =>
        message.ackedAt === null &&
        message.offeredAt !== null &&
        // A call proves only what was already delivered before that call began. This matters for revival ACKs because the browser can submit the user message while an older MCP handler is still running. Letting that older call retire the newly offered row would make a post-crash retry indistinguishable from successful acknowledgement. Strictly earlier, rather than <=, also closes the same-millisecond ordering ambiguity.
        message.offeredAt < callStartedAt &&
        !(byFinish && message.offeredOnFinish),
    );
    if (offered.length === 0) return [];
    const now = Date.now();
    for (const message of offered) message.ackedAt = now;
    agent.info.delivered += offered.length;
    recount(agent);
    changed("telemetry");
    return offered.map((message) => ({ ...message }));
  }

  /** Caller-scoped acknowledgement counterpart to {@link offerMessagesForConversation}. */
  function acknowledgeOffersForConversation(
    conversationId: string | null | undefined,
    byFinish = false,
    callStartedAt = Number.POSITIVE_INFINITY,
    allowDormantWorkerFinishRetry = false,
  ): { agentId: string; messages: AgentMessage[] } | null {
    if (!conversationId) return null;
    if (
      allFamilies().some(
        (owner) => owner.primeConversationId === conversationId,
      )
    ) {
      if (!familiesForCaller({ conversationId }).length) return null;
      return acknowledgeOffersForCaller(
        { conversationId },
        byFinish,
        callStartedAt,
        allowDormantWorkerFinishRetry,
      );
    }
    const active = boundAgent(conversationId);
    if (active) {
      return {
        agentId: active.info.id,
        messages: acknowledgeAgentOffers(active, byFinish, callStartedAt),
      };
    }
    const dormant = dormantAgentForConversation(conversationId);
    if (!dormant) return null;
    if (dormant.agent.info.role === "worker") {
      if (
        !allowDormantWorkerFinishRetry ||
        !byFinish ||
        !hasStopped(dormant.agent.info.state)
      )
        return null;
      return {
        agentId: dormant.agent.info.id,
        messages: acknowledgeAgentOffers(dormant.agent, true, callStartedAt),
      };
    }
    return {
      agentId: PRIME_ID,
      messages: acknowledgeAgentOffers(dormant.agent, byFinish, callStartedAt),
    };
  }

  function acknowledgeOffersForCaller(
    input: Caller,
    byFinish = false,
    callStartedAt = Number.POSITIVE_INFINITY,
    allowDormantWorkerFinishRetry = false,
  ): { agentId: string; messages: AgentMessage[] } | null {
    const caller = exactCaller(input);
    const owned = familiesForCaller(caller).filter(
      (owner) =>
        ownsPrime(caller, owner) &&
        (!caller.runId || answersTo(owner, caller.runId)),
    );
    if (owned.length)
      return {
        agentId: PRIME_ID,
        messages: owned.flatMap((owner) =>
          acknowledgeAgentOffers(
            owner.agents.get(PRIME_ID)!,
            byFinish,
            callStartedAt,
          ),
        ),
      };
    if (caller.runId && !selectedFamily(caller)) return null;
    return acknowledgeOffersForConversation(
      caller.conversationId,
      byFinish,
      callStartedAt,
      allowDormantWorkerFinishRetry,
    );
  }

  function pendingCount(id: string, runId?: string): number {
    const run = scopedRun(runId);
    return run?.agents.get(id)?.info.pending ?? 0;
  }

  // Parks an owner after its workers release their slots while preserving dormant history.
  function releaseQuiescentRun(
    options: { allowPendingReports?: boolean; reason?: string } = {},
    runId?: string,
  ): boolean {
    if (runId === undefined) {
      let parked = false;
      for (const id of [...runs.keys()])
        parked = releaseQuiescentRun(options, id) || parked;
      return parked;
    }
    const run = scopedRun(runId);
    if (!run) return false;
    if (activeSpawnStages.has(run)) return false;
    // `pending` intentionally hides messages that are still behind an immediate durability barrier. That visibility rule must not make them look nonexistent to lifecycle teardown: a parallel worker finish + prime ACK can otherwise make pending=0 and destroy the run while another agents::message call is still staged. Its later commit would then report success into an Agent object no longer reachable from the broker. A staged queue entry is therefore outstanding work even though it is not yet an offerable inbox item.
    if (
      [...run.agents.values()].some((agent) =>
        agent.queue.some((message) => unpublishedMessages.has(message)),
      )
    ) {
      return false;
    }
    if (workingWorkers(run).length > 0) return false;
    return parkRun(run, options.reason ?? "no worker is currently running");
  }

  return {
    sendMessage,
    stagePrimeMessage,
    stageMessages,
    sendMessages,
    offerMessages,
    offerMessagesForConversation,
    offerMessagesForCaller,
    acknowledgeOffers,
    acknowledgeOffersForConversation,
    acknowledgeOffersForCaller,
    pendingCount,
    releaseQuiescentRun,
    retiredAgent,
  };
}
