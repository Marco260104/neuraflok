import type { AgentMessage } from "../../../../contracts/session.js";
import type { Agent, Caller, agentsMessagingRuntime } from "../agents.js";
import { createPrimeMessageStaging } from "./prime-message-staging.js";
export type { StagedPrimeMessage } from "./prime-message-staging.js";

type Runtime = typeof agentsMessagingRuntime;

// Owns atomic staging, queue capacity and rollback for agent messages.
export interface StagedAgentMessages {
  /** Incarnation actually reserved, which may differ after reviving parked history. */
  runId: string;
  /** Stable copies for the caller to record/report after commit. */
  messages: AgentMessage[];
  // Sleeping workers this batch reserved a slot for, and whose chats open only after durable acceptance.
  waking: string[];
  /** Makes the already-durable queue entries visible to the recipient. Pure in-memory publish. */
  commit: () => void;
  /** Removes an unaccepted batch and supersedes any failed durable snapshot with the safe state. */
  rollback: () => void;
}

export function createAgentMessageStaging(runtime: Runtime) {
  const {
    AgentError,
    MAX_BATCH_MESSAGES,
    MAX_LABEL_CHARS,
    MAX_MESSAGE_CHARS,
    MAX_QUEUE,
    activeFinishStages,
    activeSpawnStages,
    beginRevival,
    changed,
    dormantRunForCaller,
    exactCaller,
    freeWorkerSlots,
    getConfig,
    globalFreeWorkerSlots,
    hasCallerIdentity,
    isOver,
    newMessage,
    parkRun,
    recount,
    reactivateDormantRun,
    requireFamilySelection,
    requireMember,
    returnWakingWorkerToStopped,
    runForCaller,
    runProjectionStillOwned,
    unpublishedAgents,
    unpublishedMessages,
  } = runtime;
  // Star topology, enforced. Two workers talking directly is the thing this mode must not allow: it is how a swarm silently negotiates a plan the user never sees and the prime cannot report.
  function assertRoute(from: Agent, to: Agent): void {
    if (from.info.id === to.info.id)
      throw new AgentError("An agent cannot message itself");
    if (from.info.role === "worker" && to.info.role !== "prime") {
      throw new AgentError(
        "Workers may only message the prime agent. Send it there and let the prime decide.",
      );
    }
    if (from.info.role === "prime" && to.info.role !== "worker") {
      throw new AgentError("The prime agent can only message workers");
    }
  }

  // Adds a message to a recipient's queue, or refuses. Refusing is the point. Dropping the oldest waiting message to make room would throw away a task or a result while still telling the sender it was sent.
  function assertRoom(to: Agent, incoming: number): void {
    const waiting = to.queue.filter((item) => item.ackedAt === null).length;
    if (waiting + incoming > MAX_QUEUE) {
      throw new AgentError(
        `QUEUE_FULL: ${to.info.id} already has ${waiting} unacknowledged messages, which is the limit. Nothing was sent ` +
          "and nothing was discarded. A queue this deep normally means that agent has stopped calling tools.",
      );
    }
  }

  function enqueue(to: Agent, message: AgentMessage): void {
    assertRoom(to, 1);
    to.queue.push(message);
    if (to.queue.length > MAX_QUEUE * 2) {
      const settled = to.queue
        .filter((item) => item.ackedAt !== null)
        .slice(-MAX_QUEUE);
      to.queue = [
        ...settled,
        ...to.queue.filter((item) => item.ackedAt === null),
      ];
    }
    recount(to);
  }


  const { stagePrimeMessage } = createPrimeMessageStaging(runtime, { assertRoom, enqueue, recount });

  // Sends several messages from the caller in one operation, all or nothing. One `agents` call is one proof of who is calling. Sending three corrections used to be three MCP round trips and three separate identity resolutions — each of which can be refused on its own, so a prime redirecting its whole run could get two of its three messages delivered and no way to tell which. Everything that can be checked is checked across the whole batch before anything is queued, including how much room each recipient has left, so a batch either lands complete or changes nothing. Two messages to the same worker keep their written order.
  function stageMessages(
    caller: Caller,
    items: ReadonlyArray<{ to: string; text: string; label?: string }>,
  ): StagedAgentMessages {
    caller = exactCaller(caller);
    requireFamilySelection(caller);
    if (items.length === 0) throw new AgentError("No messages were given");
    if (items.length > MAX_BATCH_MESSAGES) {
      throw new AgentError(
        `Too many messages in one call (limit ${MAX_BATCH_MESSAGES})`,
      );
    }
    let run = runForCaller(caller);
    let resumedDormant = false;
    if (!run && hasCallerIdentity(caller)) {
      const dormant = dormantRunForCaller(caller);
      if (dormant) {
        if (!(run = reactivateDormantRun(dormant))) {
          throw new AgentError(
            "PRIME_TRANSFER_IN_PROGRESS: this conversation is being compacted/resumed, so its sleeping workers cannot be woken until that handoff settles.",
          );
        }
        resumedDormant = true;
        caller = { ...caller, runId: run.runId };
      }
    }
    try {
      return stageMessagesActive(caller, items, resumedDormant);
    } catch (error) {
      if (resumedDormant)
        parkRun(
          run,
          "a dormant-owner message was rejected before any worker was woken",
        );
      throw error;
    }
  }

  function stageMessagesActive(
    caller: Caller,
    items: ReadonlyArray<{ to: string; text: string; label?: string }>,
    resumedDormant: boolean,
  ): StagedAgentMessages {
    const run = runForCaller(caller);
    const from = requireMember(caller);
    if (run && (activeSpawnStages.has(run) || run.transfer))
      throw new AgentError(
        "OWNER_TRANSITION_IN_PROGRESS: wait for this run spawn or prime transfer to settle.",
      );
    if (activeFinishStages.has(from)) {
      throw new AgentError(
        `FINISH_IN_PROGRESS: ${from.info.id} is still crossing its durable finish barrier and cannot send another message yet.`,
      );
    }
    // A finished worker keeps its conversation so a lost finish result can be recognised as a retry. Without this guard that same binding let it go on queueing work for the prime after it had reported and stopped.
    if (isOver(from.info.state)) {
      throw new AgentError(
        `${from.info.id} has ${from.info.state === "failed" ? "failed" : "finished"} and cannot send messages.`,
      );
    }

    const planned: Array<{ to: Agent; message: AgentMessage }> = [];
    const perRecipient = new Map<string, number>();
    /** Sleeping recipients this batch is about to wake, and therefore about to take a slot for. */
    const reserved = new Set<Agent>();
    const labels = new Map<Agent, string>();
    for (const [index, item] of items.entries()) {
      const where =
        items.length > 1 ? ` (message ${index + 1} of ${items.length})` : "";
      const trimmed = item.text?.trim() ?? "";
      if (!trimmed) throw new AgentError(`The message is empty${where}`);
      if (trimmed.length > MAX_MESSAGE_CHARS) {
        throw new AgentError(
          `Message is too long (limit ${MAX_MESSAGE_CHARS} characters)${where}`,
        );
      }
      const toId = item.to?.trim() ?? "";
      const to = toId ? run?.agents.get(toId) : undefined;
      if (!to) {
        throw new AgentError(
          `Unknown agent "${toId}"${where}. Call agents action=status to see who exists.`,
        );
      }
      if (unpublishedAgents.has(to)) {
        throw new AgentError(
          `SPAWN_IN_PROGRESS: ${toId} has not crossed its durable spawn acceptance barrier yet${where}. Retry after the spawn call finishes.`,
        );
      }
      if (activeFinishStages.has(to)) {
        throw new AgentError(
          `FINISH_IN_PROGRESS: ${toId} is still crossing its durable finish barrier${where}. Retry after that finish call settles.`,
        );
      }
      assertRoute(from, to);
      if (item.label !== undefined) {
        const label = item.label.trim();
        if (!label || label.length > MAX_LABEL_CHARS)
          throw new AgentError("Worker label must contain 1–60 characters.");
        if (
          from.info.role !== "prime" ||
          to.info.role !== "worker" ||
          to.info.state !== "sleeping"
        ) {
          throw new AgentError(
            "label is only valid when the prime wakes a sleeping worker.",
          );
        }
        if (labels.has(to) && labels.get(to) !== label)
          throw new AgentError("Conflicting labels for the same worker.");
        labels.set(to, label);
      }
      if (isOver(to.info.state)) {
        throw new AgentError(
          to.info.state === "failed"
            ? `${toId} has failed and is no longer listening${where}`
            : `${toId} is finished for good — its own chat reached the context limit, so it cannot be woken` +
                `${where}. Spawn a new worker for this work.`,
        );
      }
      // A revival already crossing the browser is its own in-flight transaction, exactly like a spawn or a finish, and for the same reason: this call's `waking` list is what causes the browser to be asked for anything at all. A second message would see the worker already reserved, report nothing to wake, and be durably queued behind a revival that may yet roll back to `sleeping` — leaving the prime's words in a chat nothing is going to open.
      if (to.info.state === "waking") {
        throw new AgentError(
          `REVIVE_IN_PROGRESS: ${toId} is being woken right now${where}. Nothing was sent; send this again once it is ` +
            "awake, or once you are told the revival failed.",
        );
      }
      if (to.info.state === "sleeping") {
        if (to.info.silenceParked && !to.info.revivable) {
          throw new AgentError(
            `${toId} is context-limited and its previous turn is still unresolved${where}. Nothing was sent. Spawn a new worker for new work.`,
          );
        }
        if (!to.info.conversationId) {
          throw new AgentError(
            `${toId} is asleep but this app never learned which chat it is in, so it cannot be woken${where}.`,
          );
        }
        // Waking is the one send that needs capacity, because the recipient is not running. The slot is reserved here, synchronously, so two messages to two sleeping workers cannot both be told the same last slot is theirs. Refused rather than queued: a message that sits unread in a chat nobody is going to open is worse than being told to wait.
        if (!reserved.has(to)) {
          if (freeWorkerSlots(run?.runId) - reserved.size <= 0) {
            throw new AgentError(
              `NO_FREE_SLOT: ${toId} is asleep and all ${getConfig().multiAgent.maxWorkers} worker slots are busy, so it ` +
                `cannot be woken right now${where}. Nothing was sent. Wait for a worker to report and try again.`,
            );
          }
          const globalMax = getConfig().multiAgent.globalMaxWorkers ?? 0;
          if (globalMax > 0 && globalFreeWorkerSlots() - reserved.size <= 0) {
            throw new AgentError(
              `GLOBAL_WORKER_LIMIT: ${toId} is asleep and all ${globalMax} globally admitted worker slots are busy, so it ` +
                `cannot be woken right now${where}. Nothing was sent. Wait for a worker to stop and try again.`,
            );
          }
        }
        reserved.add(to);
      }
      // Counted per recipient across the batch: three messages to one worker with two slots left has to be refused here, not half-delivered and then refused by enqueue.
      const already = perRecipient.get(to.info.id) ?? 0;
      assertRoom(to, already + 1);
      perRecipient.set(to.info.id, already + 1);
      planned.push({
        to,
        message: newMessage(from.info.id, to.info.id, trimmed),
      });
    }

    for (const { to, message } of planned) {
      unpublishedMessages.add(message);
      enqueue(to, message);
    }
    // Reservation is part of the same all-or-nothing plan as the queue entries: every check above has passed by now, so no recipient can still turn out to be unreachable.
    const previousAssignments = new Map(
      [...reserved].map((agent) => [
        agent,
        beginRevival(agent, labels.get(agent)),
      ]),
    );
    changed();
    const messages = planned.map(({ message }) => ({ ...message }));
    let settled = false;
    const recipients = [...new Set(planned.map(({ to }) => to))];
    return {
      runId: run!.runId,
      messages,
      waking: [...reserved].map((agent) => agent.info.id),
      commit: () => {
        if (settled) return;
        settled = true;
        if (!run || !runProjectionStillOwned(run)) return;
        for (const { message } of planned) unpublishedMessages.delete(message);
        for (const recipient of recipients) recount(recipient);
        // No new durable fact: the exact queue entries were already in the snapshot that crossed the acceptance barrier. This only publishes them to live inbox readers and the UI.
        changed("telemetry");
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        if (!run || !runProjectionStillOwned(run)) return;
        for (const { to, message } of planned) {
          unpublishedMessages.delete(message);
          const index = to.queue.indexOf(message);
          if (index >= 0) to.queue.splice(index, 1);
        }
        // The slot goes back with the message it was reserved for. A rejected write must not leave a worker `waking` with nothing on its way to wake it.
        for (const agent of reserved) {
          if (agent.info.state !== "waking") continue;
          Object.assign(agent.info, previousAssignments.get(agent));
          returnWakingWorkerToStopped(
            agent,
            Date.now(),
            "Its pending revival was rolled back before any new work was accepted.",
          );
        }
        for (const recipient of recipients) recount(recipient);
        // writeDurableNow deliberately retains a failed generation for retry. Queue a *newer* safe snapshot immediately so that failed generation can never later persist a message whose tool call reported failure.
        changed();
        if (resumedDormant)
          parkRun(
            run,
            "a dormant-owner message rolled back before its worker was woken",
          );
      },
    };
  }

  return { stagePrimeMessage, stageMessages };
}
