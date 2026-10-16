import type { Agent } from "./agents.js";
import type { AgentLifecycleRuntime } from "./agents-lifecycle-types.js";

export function createAgentPrimeTransfers(runtime: AgentLifecycleRuntime) {
  const { PRIME_ID, allFamilies, changed, dormantRuns, logInfo, runs } = runtime;

  // Mark the prime conversation as transferring during Compact & Resume.
  function beginPrimeTransfer(conversationId: string): boolean {
    const owned = allFamilies().filter(
      (owner) => owner.primeConversationId === conversationId,
    );
    for (const owner of owned)
      owner.transfer = { from: conversationId, at: Date.now(), frozen: false };
    return owned.length > 0;
  }

  /** Abandons an open handover, so the prime stays where it is. */
  function cancelPrimeTransfer(conversationId: string): void {
    for (const owner of allFamilies())
      if (owner.transfer?.from === conversationId) owner.transfer = null;
  }

  // Freeze a validated transfer before the durable session write begins.
  function freezePrimeTransfer(
    fromConversationId: string,
  ): "absent" | "unavailable" | "frozen" {
    const owned = allFamilies().filter(
      (owner) => owner.primeConversationId === fromConversationId,
    );
    if (!owned.length) return "absent";
    if (
      owned.some(
        (owner) =>
          owner.transfer?.from !== fromConversationId ||
          !owner.agents.has(PRIME_ID),
      )
    )
      return "unavailable";
    for (const owner of owned) owner.transfer!.frozen = true;
    return "frozen";
  }

  /** Undoes a freeze whose commit did not happen, leaving the handover open. */
  function thawPrimeTransfer(fromConversationId: string): void {
    for (const owner of allFamilies())
      if (owner.transfer?.from === fromConversationId)
        owner.transfer.frozen = false;
  }

  // Commit the frozen prime binding after the session continuation transaction succeeds.
  function commitPrimeTransfer(
    fromConversationId: string,
    toConversationId: string,
  ): boolean {
    if (
      !fromConversationId ||
      !toConversationId ||
      fromConversationId === toConversationId
    )
      return false;
    const owned = allFamilies().filter(
      (owner) => owner.primeConversationId === fromConversationId,
    );
    if (
      !owned.length ||
      owned.some(
        (owner) =>
          owner.transfer?.from !== fromConversationId ||
          !owner.agents.has(PRIME_ID) ||
          conversationOwnedOutside(
            owner.agents,
            fromConversationId,
            toConversationId,
          ),
      )
    )
      return false;
    for (const owner of owned) {
      owner.primeConversationId = toConversationId;
      owner.agents.get(PRIME_ID)!.info.conversationId = toConversationId;
      for (const agent of owner.agents.values())
        agent.info.primeConversationId = toConversationId;
      owner.transfer = null;
    }
    logInfo(
      `multi-agent: moved ${owned.length} prime fleet(s) from ${fromConversationId} to ${toConversationId}`,
    );
    changed();
    return true;
  }

  // Reject destinations already assigned to another active or dormant family.
  function conversationOwnedOutside(
    ownerAgents: Map<string, Agent>,
    fromConversationId: string,
    toConversationId: string,
  ): boolean {
    if (toConversationId === fromConversationId) return false;
    for (const run of runs.values()) {
      if (run.agents === ownerAgents) continue;
      if (run.primeConversationId === toConversationId) return true;
      if (
        [...run.agents.values()].some(
          (agent) => agent.info.conversationId === toConversationId,
        )
      )
        return true;
    }
    for (const dormant of dormantRuns.values()) {
      if (dormant.agents === ownerAgents) continue;
      if (dormant.primeConversationId === toConversationId) return true;
      if (
        [...dormant.agents.values()].some(
          (agent) => agent.info.conversationId === toConversationId,
        )
      )
        return true;
    }
    return [...ownerAgents.values()].some(
      (agent) =>
        agent.info.id !== PRIME_ID &&
        agent.info.conversationId === toConversationId,
    );
  }

  /** Whether a sub-agent fleet is led from this chat. */
  function primeFleetIn(conversationId: string): boolean {
    return allFamilies().some(
      (owner) => owner.primeConversationId === conversationId,
    );
  }

  // Repair a committed transfer only when durable recovery has proved its exact source and destination.
  function repairPrimeConversationAfterRecovery(
    fromConversationId: string,
    toConversationId: string,
  ): boolean {
    if (
      !fromConversationId ||
      !toConversationId ||
      fromConversationId === toConversationId
    )
      return false;
    const owned = allFamilies().filter(
      (owner) => owner.primeConversationId === fromConversationId,
    );
    if (!owned.length)
      return allFamilies().some(
        (owner) => owner.primeConversationId === toConversationId,
      );
    if (
      owned.some(
        (owner) =>
          !owner.agents.has(PRIME_ID) ||
          conversationOwnedOutside(
            owner.agents,
            fromConversationId,
            toConversationId,
          ),
      )
    )
      return false;
    for (const owner of owned) {
      owner.primeConversationId = toConversationId;
      owner.agents.get(PRIME_ID)!.info.conversationId = toConversationId;
      for (const agent of owner.agents.values())
        agent.info.primeConversationId = toConversationId;
      owner.transfer = null;
    }
    logInfo(
      `multi-agent: recovered ${owned.length} prime fleet(s) from ${fromConversationId} to ${toConversationId}`,
    );
    changed();
    return true;
  }

  return {
    beginPrimeTransfer,
    cancelPrimeTransfer,
    freezePrimeTransfer,
    thawPrimeTransfer,
    commitPrimeTransfer,
    primeFleetIn,
    repairPrimeConversationAfterRecovery,
  };
}
