import type { AgentPlanUpdate } from '../../../../contracts/agent-plan.js';
import { agentPlanUpdateSchema } from '../../../../contracts/agent-plan.js';
import { attachRequestPlan, updateRequestPlan } from '../../../domains/sessions/input/request-plans/service.js';
import { requestCorrelation } from '../../../domains/sessions/history/correlation.js';
import { updateSessionPlan } from '../../../domains/sessions/history/store.js';
import { getConfig } from '../../settings/config.js';
import { currentCall, currentCaller } from './call-context.js';
import { fail, failIdentity, guard, ok, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { toolDeclaration } from './declaration-cache.js';

const PLAN_TOOL_NAME = 'update_plan';
const PLAN_TOOL_DESCRIPTION = 'Store the complete step list shown beside the active conversation. Include concise titles, useful details, and current statuses; keep at most one step active. Send the full list again after a step finishes or your approach changes. This records progress for the user and does not start work.';

const STALE_CONVERSATION_PLAN = 'This plan update is stale or its chat was replaced. The current plan was preserved.';
const MISSING_PLAN_IDENTITY = 'Exact chat identity or an allowed request-scoped caller is required to update a plan. No plan was changed.';

async function saveConversationPlan(update: AgentPlanUpdate, startedAt: number): Promise<ToolResult> {
  const caller = currentCaller();
  if (caller.sessionId && caller.conversationId) {
    const saved = await updateSessionPlan(caller.sessionId, caller.conversationId, update, startedAt);
    return saved ? ok('Plan updated') : fail(STALE_CONVERSATION_PLAN);
  }

  const call = currentCall();
  const requestId = caller.requestId;
  const mayUseRequestIdentity = call?.allowUnattributed ?? getConfig().multiAgent.allowUnattributedCalls;
  if (!mayUseRequestIdentity || !requestId) return failIdentity(MISSING_PLAN_IDENTITY);

  const saved = await updateRequestPlan(requestId, update, startedAt);
  if (!saved) return fail('This request plan update is stale. The current plan was preserved.');

  const owner = requestCorrelation(requestId);
  if (!owner) return ok('Plan updated for this request and will attach when its chat identity arrives.');

  const attached = await attachRequestPlan(owner);
  return attached === 'stale' ? fail(STALE_CONVERSATION_PLAN) : ok('Plan updated');
}

export function registerPlanTool(registrar: SurfaceRegistrar): void {
  registrar.register(PLAN_TOOL_NAME, toolDeclaration(PLAN_TOOL_NAME, () => ({
    title: 'Update plan',
    description: PLAN_TOOL_DESCRIPTION,
    inputSchema: agentPlanUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  })), update => guard(PLAN_TOOL_NAME, async () => {
    if (!registrar.sessionToolsLive) return registrar.featureDisabled('Session recording', 'Settings → Chat');
    const startedAt = currentCall()?.startedAt ?? Date.now();
    return saveConversationPlan(update, startedAt);
  }));
}
