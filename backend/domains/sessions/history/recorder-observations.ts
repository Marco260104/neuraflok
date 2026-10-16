import { commitRequestCorrelations } from './correlation.js';
import { observationTitle, supersededLineage } from './recorder-observation-helpers.js';
import { recordChatObservationsNow } from './recorder-observation-transcript.js';
import type { ChatObservation, ObservationActivity, ObservationRuntime } from './recorder-observation-types.js';
export type { ChatObservation, LiveConversation, ObservationActivity, ObservationRuntime, PageCallEvidence, ProgressRecord } from './recorder-observation-types.js';
export { pageToolKey } from './recorder-observation-tools.js';
export function createObservationRecorder(runtime: ObservationRuntime) {
  const { conversations, recordingEnabled, sessionForConversation, noteCallEvidence } = runtime;

  const observationChains = new Map<string, Promise<void>>();

  // Resolve exact request ownership before queuing transcript writes, which may be slow.
  async function recordRequestEvidence(
    conversationId: string,
    observations: readonly ChatObservation[]
  ): Promise<string | null> {
    if (!recordingEnabled()) return null;
    const lineage = !conversations.has(conversationId) ? await supersededLineage(conversationId) : null;
    const sessionId = lineage ?? await sessionForConversation(conversationId, observationTitle(observations));
    if (!sessionId) return null;
    // Proof identifies even a retired caller; kernel/recorder attachment checks then refuse it as superseded. Never turn an exact historical owner into anonymous executable authority.
    let storedOwner = false;
    for (const item of observations) {
      if (item.kind === 'tool_evidence' && item.calls?.length) {
        storedOwner = noteCallEvidence(conversationId, sessionId, item.fiberConversationId, item.calls, item.time) || storedOwner;
      }
    }
    if (storedOwner) await commitRequestCorrelations();
    return sessionId;
  }

  function recordChatObservations(
    conversationId: string,
    observations: readonly ChatObservation[],
    agent?: string | null
  ): Promise<{
    sessionId: string | null;
    stored: number;
    activity: ObservationActivity;
    goalCandidates: Array<{ replyId: string; turnId: string; eventSeq: number }>;
  }> {
    const hasEvidence = observations.some((item) => item.kind === 'tool_evidence');
    const ownership = hasEvidence ? recordRequestEvidence(conversationId, observations) : null;
    // Observe rejection now even if an earlier transcript batch is still blocked. The queued work below rethrows it to the journal owner, which retains the batch for its normal retry.
    void ownership?.catch(() => undefined);
    const transcript = hasEvidence ? observations.filter((item) => item.kind !== 'tool_evidence') : observations;
    return serializeObservations(conversationId, async () => {
      await ownership;
      return recordChatObservationsNow(runtime, conversationId, transcript, agent);
    });
  }

  /** Transcript and MCP lifecycle changes share the same per-conversation publication order. */
  function serializeObservations<T>(conversationId: string, action: () => Promise<T>): Promise<T> {
    const prior = observationChains.get(conversationId) ?? Promise.resolve();
    const work = prior.then(action);
    const tracked = work.then(
      () => undefined,
      () => undefined
    );
    observationChains.set(conversationId, tracked);
    void tracked.finally(() => {
      if (observationChains.get(conversationId) === tracked) observationChains.delete(conversationId);
    });
    return work;
  }

  return {
    recordRequestEvidence,
    recordChatObservations,
    serializeObservations,
    resetForTests: () => observationChains.clear()
  };
}
