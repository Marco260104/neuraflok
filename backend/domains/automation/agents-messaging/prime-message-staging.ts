import type { AgentMessage } from "../../../../contracts/session.js";
import type { Agent, Caller, agentsMessagingRuntime } from "../agents.js";

type Runtime = typeof agentsMessagingRuntime;
type PrimeMessageRuntime = Pick<
  Runtime,
  | "AgentError"
  | "IdentityLostError"
  | "MAX_MESSAGE_CHARS"
  | "PRIME_ID"
  | "allFamilies"
  | "answersTo"
  | "changed"
  | "exactCaller"
  | "familyForAddress"
  | "familyKey"
  | "familyReplyAddress"
  | "hasCallerIdentity"
  | "newMessage"
  | "ownsPrime"
  | "requireEnabled"
  | "requireFamilySelection"
  | "selectedFamily"
  | "unpublishedMessages"
>;

export interface StagedPrimeMessage {
  /** Address the recipient can use to reply to this prime family. */
  sourceRunId: string;
  /** Current canonical address of the destination family. */
  targetRunId: string;
  /** Stable copy for the caller to record after acceptance. */
  message: AgentMessage;
  /** Publishes the already-durable row. False only if the destination disappeared meanwhile. */
  commit: () => boolean;
  /** Removes an unaccepted row and queues a newer safe snapshot. */
  rollback: () => void;
}

interface QueueStaging {
  assertRoom: (to: Agent, incoming: number) => void;
  enqueue: (to: Agent, message: AgentMessage) => void;
  recount: (agent: Agent) => void;
}

export function createPrimeMessageStaging(
  runtime: PrimeMessageRuntime,
  queue: QueueStaging,
) {
  const {
    AgentError,
    IdentityLostError,
    MAX_MESSAGE_CHARS,
    PRIME_ID,
    allFamilies,
    answersTo,
    changed,
    exactCaller,
    familyForAddress,
    familyKey,
    familyReplyAddress,
    hasCallerIdentity,
    newMessage,
    ownsPrime,
    requireEnabled,
    requireFamilySelection,
    selectedFamily,
    unpublishedMessages,
  } = runtime;
  const { assertRoom, enqueue, recount } = queue;

  // Queues one message from an existing prime to another existing prime family. The destination is an explicit opaque run address, not discovery authority. Only a prime may use it, only the destination prime receives the row, and workers remain invisible/unreachable across the family boundary. The source address rides with the durable message so the recipient can reply even after either family parks and wakes under a newer incarnation id.
  function stagePrimeMessage(
    input: Caller,
    targetRunId: string,
    text: string,
  ): StagedPrimeMessage {
    requireEnabled();
    const caller = exactCaller(input);
    requireFamilySelection(caller);
    if (!hasCallerIdentity(caller)) throw new IdentityLostError();

    const source = selectedFamily(caller);
    if (!source) {
      throw new AgentError(
        "No prime family belongs to this conversation. Call agents action=spawn before messaging another prime.",
      );
    }
    if (!ownsPrime(caller, source)) {
      throw new AgentError(
        "Only a prime agent may message another prime family.",
      );
    }
    if (source.transfer) {
      throw new AgentError(
        "PRIME_TRANSFER_IN_PROGRESS: this prime is being compacted/resumed.",
      );
    }

    const address = targetRunId.trim();
    const target = address ? familyForAddress(address) : null;
    if (!target) {
      throw new AgentError(
        "TARGET_RUN_UNAVAILABLE: no addressable prime family matches target_run_id. Nothing was sent.",
      );
    }
    if (ownsPrime(caller, target)) {
      throw new AgentError(
        "A prime cannot message one of its own families through target_run_id.",
      );
    }
    const targetPrime = target.agents.get(PRIME_ID);
    if (!targetPrime) {
      throw new AgentError(
        "TARGET_RUN_UNAVAILABLE: the addressed prime family has no reachable prime. Nothing was sent.",
      );
    }

    const trimmed = text.trim();
    if (!trimmed) throw new AgentError("The message is empty");
    if (trimmed.length > MAX_MESSAGE_CHARS) {
      throw new AgentError(
        `Message is too long (limit ${MAX_MESSAGE_CHARS} characters)`,
      );
    }
    assertRoom(targetPrime, 1);

    const sourceRunId = familyReplyAddress(source);
    const canonicalTargetRunId = familyKey(target);
    const message: AgentMessage = {
      ...newMessage(PRIME_ID, PRIME_ID, trimmed),
      fromRunId: sourceRunId,
    };
    unpublishedMessages.add(message);
    enqueue(targetPrime, message);
    changed();

    let settled: boolean | null = null;
    const remove = (): void => {
      unpublishedMessages.delete(message);
      const index = targetPrime.queue.indexOf(message);
      if (index >= 0) targetPrime.queue.splice(index, 1);
      recount(targetPrime);
    };
    const destinationStillOwnsPrime = (): boolean =>
      allFamilies().some(
        (owner) =>
          owner.agents.get(PRIME_ID) === targetPrime &&
          answersTo(owner, address),
      );

    return {
      sourceRunId,
      targetRunId: canonicalTargetRunId,
      message: { ...message },
      commit: () => {
        if (settled !== null) return settled;
        if (!destinationStillOwnsPrime()) {
          remove();
          settled = false;
          changed();
          return false;
        }
        unpublishedMessages.delete(message);
        recount(targetPrime);
        settled = true;
        changed("telemetry");
        return true;
      },
      rollback: () => {
        if (settled !== null) return;
        remove();
        settled = false;
        changed();
      },
    };
  }

  return { stagePrimeMessage };
}
