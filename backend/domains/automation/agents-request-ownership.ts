import type { RequestCorrelation } from '../sessions/history/correlation.js';
import type { continuationForSession } from '../sessions/continuity/continuation.js';
import type { findSessionByConversation, getSession } from '../sessions/history/store.js';
import type { Family } from './agents-identity.js';
import { PRIME_ID, type RetiredChat, type Run } from './agents-types.js';

interface Runtime {
  allFamilies(): Family[];
  changed(): void;
  continuationForSession: typeof continuationForSession;
  findSessionByConversation: typeof findSessionByConversation;
  getSession: typeof getSession;
  isWorkerConversation(conversationId: string): boolean;
  recordWorkerOrigin(conversationId: string, origin: {
    kind: 'worker';
    fromSessionId: string;
    agentId: string;
    task: string;
  }): Promise<void>;
  requestCorrelation(requestId: string): RequestCorrelation | null;
  retiredWorkerForConversation(conversationId: string): RetiredChat | null;
  unpublishedRuns: Set<Run>;
}

export function createAgentRequestOwnership(runtime: Runtime) {
  let inFlight: Promise<void> | null = null;
  let pending = false;
  let epoch = 0;

  async function reconcileOwners(activeEpoch: number): Promise<void> {
    do {
      pending = false;
      let attached = false;
      for (const owner of runtime.allFamilies()) {
        if (owner.primeConversationId || !owner.primeRequestId || runtime.unpublishedRuns.has(owner as Run)) continue;
        const proof = runtime.requestCorrelation(owner.primeRequestId);
        if (!proof) continue;
        const session = await runtime.getSession(proof.sessionId);
        if (!session?.conversationId || !session.chatIds.includes(proof.conversationId)) continue;

        let target = session.conversationId;
        let targetSessionId = session.id;
        // Parent discovery follows recorded worker bindings instead of caller-provided identifiers.
        const visited = new Set<Family>([owner]);
        const parentBindings = new Map<Family, string>();
        while (runtime.isWorkerConversation(target)) {
          const parents = runtime.allFamilies().filter(family => [...family.agents.values()]
            .some(agent => agent.info.role === 'worker' && agent.info.conversationId === target));
          const parent = parents.length === 1 ? parents[0]! : null;
          if (!parent || visited.has(parent) || !parent.primeConversationId) {
            target = '';
            break;
          }
          visited.add(parent);
          target = parent.primeConversationId;
          parentBindings.set(parent, target);
          const parentSession = await runtime.findSessionByConversation(target, { requireUnique: true });
          if (parentSession?.conversationId && parentSession.chatIds.includes(target)) {
            target = parentSession.conversationId;
            targetSessionId = parentSession.id;
          }
        }

        if (activeEpoch !== epoch) return;
        if (!target || runtime.retiredWorkerForConversation(target) || !runtime.allFamilies().includes(owner) ||
          owner.primeConversationId || runtime.unpublishedRuns.has(owner as Run)) continue;

        const parentSession = await runtime.getSession(targetSessionId);
        if (parentSession?.chatIds.includes(target)) {
          // Repair worker origins before publishing the recovered owner.
          for (const agent of owner.agents.values()) {
            if (activeEpoch !== epoch) return;
            if (!runtime.allFamilies().includes(owner) || owner.primeConversationId) break;
            if (agent.info.role !== 'worker' || !agent.info.conversationId) continue;
            await runtime.recordWorkerOrigin(agent.info.conversationId, {
              kind: 'worker',
              fromSessionId: parentSession.id,
              agentId: agent.info.id,
              task: agent.info.task
            });
          }
        }

        const latest = await runtime.getSession(proof.sessionId);
        if (activeEpoch !== epoch) return;
        if (!latest) continue;
        // Revalidate the source and parent chain after asynchronous reads.
        if (latest.conversationId !== session.conversationId || [...parentBindings].some(([parent, binding]) =>
          !runtime.allFamilies().includes(parent) || parent.primeConversationId !== binding)) {
          pending = true;
          continue;
        }
        if (!runtime.allFamilies().includes(owner) || owner.primeConversationId || runtime.isWorkerConversation(target)) continue;

        const handoff = runtime.continuationForSession(targetSessionId);
        const transferring = handoff && runtime.allFamilies().some(family => family !== owner &&
          family.primeConversationId === handoff.from && family.transfer?.from === handoff.from);
        if (transferring) target = handoff!.from;
        owner.primeConversationId = target;
        owner.agents.get(PRIME_ID)!.info.conversationId = target;
        for (const agent of owner.agents.values()) agent.info.primeConversationId = target;

        const transfer = runtime.allFamilies().find(family =>
          family !== owner && family.primeConversationId === target && family.transfer)?.transfer;
        if (transfer) owner.transfer = { ...transfer };
        else if (handoff?.from === target) {
          owner.transfer = { from: target, at: handoff.openedAt, frozen: handoff.state === 'committing' };
        }
        attached = true;
        runtime.changed();
      }
      if (attached) pending = true;
    } while (pending && activeEpoch === epoch);
  }

  function reconcile(): Promise<void> {
    pending = true;
    if (inFlight) return inFlight;
    const activeEpoch = epoch;
    const work = reconcileOwners(activeEpoch);
    inFlight = work;
    void work.finally(() => {
      if (inFlight === work) inFlight = null;
    }).catch(() => undefined);
    return work;
  }

  function reset(): void {
    epoch += 1;
    inFlight = null;
    pending = false;
  }

  return { reconcile, reset };
}
