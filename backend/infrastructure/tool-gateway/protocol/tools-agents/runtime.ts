import {
  agentFamiliesForCaller,
  agentForCaller,
  noteAgentContextTokens,
  persistCriticalSwarmNow,
  reconcileAgentRequestOwners,
  swarmStateForCaller,
  type Caller
} from '../../../../domains/automation/agents.js';
import { repairPrimeFromResumeShadow } from '../../../../domains/sessions/continuity/continuation.js';
import { awaitFreshCallOrigin } from '../../../../domains/sessions/history/recorder.js';
import { requestCorrelation } from '../../../../domains/sessions/history/correlation.js';
import { findSessionByConversation } from '../../../../domains/sessions/history/store.js';
import { getConfig } from '../../../settings/config.js';
import { logWarn } from '../../../settings/logger.js';
import { currentCall, currentCaller } from '../call-context.js';
import { adoptAgent, IDENTITY_EVIDENCE_MS, PRIME_EVIDENCE_MS, SPAWN_EVIDENCE_MS } from '../kernel.js';
// agents Register spawn, message, status, and finish actions for worker families. Re-measure a sleeping worker's stored context before waking it.
export async function measureSleepingWorkers(caller: Caller): Promise<void> {
  const state = swarmStateForCaller(caller);
  if (state.agents.length === 0) return;
  for (const info of state.agents) {
    if (info.role !== 'worker' || info.state !== 'sleeping' || !info.conversationId) continue;
    const summary = await findSessionByConversation(info.conversationId, { requireUnique: true }).catch(() => null);
    if (summary) noteAgentContextTokens(info.conversationId, summary.contextTokens);
  }
  // Measurement is usually telemetry, but crossing the worker ceiling revokes durable revival authority and can terminalize a parked worker. `status` also calls this helper, so there is no later message/spawn acceptance barrier we can rely on: make every critical revision seen through the end of measurement durable before publishing the resulting state to the model.
  try {
    if (!(await persistCriticalSwarmNow())) {
      throw new Error('the broker has no immediate durable persistence sink');
    }
  } catch (error) {
    throw new Error(
      `Worker context/revival state could not cross its durable barrier. Retry the agents call. (${error instanceof Error ? error.message : String(error)})`
    );
  }
}


// Publish staged worker changes only after persistence succeeds.
export async function acceptAgentMutation(
  staged: { commit(): void | boolean; rollback(): void },
  failure: string,
  commitFailure: string = failure
): Promise<void> {
  try {
    let durable: boolean;
    try {
      durable = await persistCriticalSwarmNow();
    } catch (error) {
      throw new Error(`${failure} (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!durable) throw new Error(failure);
    if (staged.commit() === false) throw new Error(commitFailure);
  } catch (error) {
    staged.rollback();
    throw error;
  }
}

// Resolve exact caller identity for each worker control call.
export async function callerNow(startedAt: number, options: { exact?: boolean; runId?: string; member?: boolean } = {}): Promise<Caller> {
  const base = currentCaller();
  // `exact` marks the one action that binds a run: spawn. It is the call whose refusal the model cannot absorb, so it gets the longer ceiling; every other `agents` action can be declined and asked again on the next tool call.
  const window = base.requestId ? (options.exact ? SPAWN_EVIDENCE_MS : IDENTITY_EVIDENCE_MS) : PRIME_EVIDENCE_MS;
  const allowRequest = Boolean(base.requestId && (currentCall()?.allowUnattributed ?? getConfig().multiAgent.allowUnattributedCalls));
  const requestOwnsTarget = !options.member || agentFamiliesForCaller(base).length > 0;
  const resolved =
    base.conversationId ??
    requestCorrelation(base.requestId)?.conversationId ??
    (allowRequest && requestOwnsTarget ? null : await awaitFreshCallOrigin('agents', startedAt, window, {
      ...options,
      // provider's own id for this request, when it sent one. It names the conversation outright, so two workers calling at the same moment are no longer a hard case.
      requestId: base.requestId
    }));
  const caller: Caller = {
    ...base,
    conversationId: resolved,
    runId: options.runId
  };
  const call = currentCall();
  if (call) call.caller.runId = options.runId;
  if (resolved) {
    const call = currentCall();
    if (call) call.caller.conversationId = resolved;
    const proof = requestCorrelation(base.requestId);
    if (proof?.conversationId === resolved) {
      caller.sessionId = proof.sessionId;
      if (call) call.caller.sessionId = proof.sessionId;
    }
    // A pre-fix Compact & Resume can leave this exact app-opened replacement chat with its own shadow session while the reusable-worker run is still bound to the source chat. Repair only that durably-proven historical failure before membership is evaluated; unrelated conversations still hit AGENTS_BUSY exactly as before.
    await repairPrimeFromResumeShadow(resolved);
  }
  if (!resolved && !allowRequest) {
    logWarn(
      base.requestId
        ? `agents caller not identified: no page evidence matched HTTP request ${base.requestId.slice(0, 20)}…`
        : 'agents caller not identified: this MCP request carried no request id and page evidence was insufficient'
    );
  }
  await reconcileAgentRequestOwners();
  await adoptAgent(agentForCaller(caller));
  return caller;
}
