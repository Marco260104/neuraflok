import { updateSessionPlan } from '../../history/store.js';
import {
  consumePendingRequestPlan,
  pendingRequestPlanIds,
  savePendingRequestPlan
} from './ledger.js';
import type { AgentPlanUpdate } from '../../../../../contracts/agent-plan.js';

interface RequestPlanOwner {
  requestId: string;
  sessionId: string;
  conversationId: string;
}

/** Saves the newest complete plan for one request-scoped model turn. */
export function updateRequestPlan(requestId: string, input: AgentPlanUpdate, startedAt: number): Promise<boolean> {
  return savePendingRequestPlan(requestId, input, startedAt);
}

/** Applies and removes a pending request plan once exact request correlation exists. */
export async function attachRequestPlan(
  owner: RequestPlanOwner
): Promise<'missing' | 'attached' | 'stale'> {
  const result = await consumePendingRequestPlan(owner.requestId, entry => updateSessionPlan(
    owner.sessionId,
    owner.conversationId,
    entry.update,
    entry.startedAt,
    { storedAt: entry.storedAt }
  ));
  if (!result.found) return 'missing';
  return result.value ? 'attached' : 'stale';
}

/** Reattaches durable pending plans after both registries are restored on app startup. */
export async function reconcileRequestPlans(
  resolve: (requestId: string) => RequestPlanOwner | null
): Promise<void> {
  for (const requestId of await pendingRequestPlanIds()) {
    const owner = resolve(requestId);
    if (owner) await attachRequestPlan(owner);
  }
}
