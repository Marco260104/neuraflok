import { acknowledgeToolInput } from '../../../domains/sessions/input/input.js';
/** Shared tool dispatch, permission checks, and result formatting across surfaces. */

import { beginToolExecutionTiming, currentOutputPublication } from '../request-context.js';
import { fail } from './tool-contracts.js';
import { clearUntrustedRefusalEpisode, failIdentity, recordUntrustedRefusalNotice, resetIdentityNotices } from './identity-notices.js';
import type { SurfaceRegistrar, ToolContext, ToolResult } from './tool-contracts.js';
import { createSurfaceRegistrar, type RegistrarObserver } from './registrar.js';
import { resolveToolAdmission } from './tool-admission.js';
import { callerConversation, resolveDispatchIdentity, setCallerConversation } from './dispatch-identity.js';
export { IDENTITY_EVIDENCE_MS, PRIME_EVIDENCE_MS, SPAWN_EVIDENCE_MS, UNATTRIBUTED_DESKTOP_EVIDENCE_MS } from './identity-windows.js';
export { fail, ok } from './tool-contracts.js';
export { failIdentity } from './identity-notices.js';
export type { SurfaceRegistrar, ToolAnnotations, ToolContent, ToolContext, ToolResult } from './tool-contracts.js';
export { cropArg, imageCoordinateArg, lineNumberArg, mouseButtonArg, pathArg, pointArg, windowIdArg } from './tool-arguments.js';
import { logInfo, logWarn } from '../../settings/logger.js';
import { createToolPathResolver } from '../../../domains/workspace/tool-path-resolution.js';
import type { ResolvedCwd } from '../../../domains/workspace/tool-path-resolution.js';
export type { ResolvedCwd } from '../../../domains/workspace/tool-path-resolution.js';
import { getConfig } from '../../settings/config.js';
import {
  agentForCaller,
  agentForFinishCaller,
  reconcileAgentRequestOwners,
  dormantWorkerNotice,
  silentCeilingWorkerNotice,
  endedWorkerNotice,
  hasDormantWorkerLeases,
  hasRetiredWorkerLeases,
  retiredWorkerForConversation,
  swarmRunning
} from '../../../domains/automation/agents.js';
import type { SurfaceId } from './surfaces.js';
import {
  currentCall,
  emptyEvidence,
  runInCallContext,
  setRequestOwner,
  trackInFlight,
  trackMcpRequest,
  type CallContext
} from './call-context.js';
import { requestCorrelation } from '../../../domains/sessions/history/correlation.js';
import { summarizeRunningCall } from '../../../domains/sessions/history/summarize.js';
import { BLOCKED_CHAT_REFUSAL, isChatBlocked } from '../../../domains/sessions/continuity/blocked-chats.js';
import { STRICT_CHAT_REFUSAL, conversationAccessRefusal, strictChatAllowlistEnabled } from '../../../domains/sessions/continuity/conversation-access.js';
import { compactingConversation } from '../../../domains/sessions/continuity/continuation.js';
import {
  acknowledgeBackgroundExecOutput,
  executionPrincipal
} from '../../../domains/workspace/execution/ownership.js';
import { conversationAttachment } from '../../../domains/sessions/history/store.js';
import { guard as executeToolGuard } from './tool-guard.js';
import { completeToolDispatch } from './dispatch-result.js';
import { maintainAgentLiveness } from './agent-liveness.js';
export { friendlyError } from './tool-guard.js';

/** The page's exact proof of a request id, by which a running call counts for its chat. */
const requestOwner = (requestId: string): string | null => requestCorrelation(requestId)?.conversationId ?? null;

/** Last tool execution time, tracked per surface. */
let toolCallSeenAt: number | null = null;
const surfaceToolCallAt = new Map<SurfaceId, number>();

export function guard(name: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const started = Date.now();
  toolCallSeenAt = started;
  return executeToolGuard(name, fn, started);
}

export function lastToolCallAt(surface?: SurfaceId): number | null {
  if (surface === undefined) return toolCallSeenAt;
  return surfaceToolCallAt.get(surface) ?? null;
}

/** Cleared with the server, so the answer is always about the current session. */
export function resetToolClock(): void {
  resetIdentityNotices();
  toolCallSeenAt = null;
  surfaceToolCallAt.clear();
  transportIdentity = { checked: false, present: false };
}

/** Whether the MCP transport ever gave us a session id, once a real call has arrived. Recorded rather than assumed, because it is the one thing that would let this app know which conversation is calling without asking the browser at all. Until it does, identity comes from page evidence. This is what the Activity log reports on the first tool call of each run. */
let transportIdentity: { checked: boolean; present: boolean } = { checked: false, present: false };

export function transportIdentityStatus(): { checked: boolean; present: boolean } {
  return { ...transportIdentity };
}

function noteTransportIdentity(transportKey: string | null): void {
  if (transportIdentity.checked) return;
  transportIdentity = { checked: true, present: transportKey !== null };
  logInfo(
    transportKey
      ? 'MCP transport supplied a session id — agent identity could be bound to the transport'
      : 'MCP transport supplied no session id (stateless connector) — agent identity comes from page evidence'
  );
}

/** Runs one tool call inside a recording context. Registration is wrapped rather than each handler, so the arguments and the result recorded are exactly the ones that crossed the wire — the recorder never has to reconstruct a call from a log line — and so identity is resolved in one place. `finishing` replaces the old `name === 'finish_agent'` test: with the collapsed `agents` tool the terminal call is an *action* rather than a tool name, and the re-offer rule has to follow the action. */
export async function dispatch(
  name: string,
  args: unknown,
  transportKey: string | null,
  requestId: string | null,
  surface: SurfaceId,
  run: () => Promise<ToolResult>,
  parent?: CallContext
): Promise<ToolResult> {
  // The context spans evidence waiting, handler execution, durable recording, and response delivery.
  const context: CallContext = {
    publication: parent?.publication ?? currentOutputPublication() ?? { completedAt: null, failed: false },
    startedAt: Date.now(),
    activity: summarizeRunningCall(name, args, emptyEvidence()),
    transportKey,
    agent: null,
    allowUnattributed: getConfig().multiAgent.allowUnattributedCalls,
    caller: parent
      ? { ...parent.caller }
      : { transportKey, requestId, conversationId: null, sessionId: null },
    outcome: null,
    evidence: emptyEvidence()
  };
  // Install the request owner before any tool call can begin.
  setRequestOwner(requestOwner);
  try {
    const result = await trackMcpRequest(() =>
      trackInFlight(context, () => dispatchTracked(context, name, args, transportKey, requestId, surface, run, !!parent))
    );
    // Publish completion for in-process callers without an HTTP request.
    if (!parent && !currentOutputPublication()) context.publication!.completedAt = Date.now();
    return result;
  } catch (error) {
    if (!parent) context.publication!.failed = true;
    throw error;
  }
}

/** Refused to a chat whose session is being compacted into a fresh chat. The brief is the whole point of that window and the one thing the model is asked for, so the refusal is written to steer a turn that is still busy with its old task straight into writing it — and to make a chat with an unstoppable turn harmless, since nothing it calls now can change the machine the brief describes. */
export const COMPACTION_IN_PROGRESS_REFUSAL =
  'COMPACTION_IN_PROGRESS: this chat is being compacted into a fresh chat, and no local tool was run. ' +
  'Nothing will run here until the handoff is done. Make no further tool calls of any kind. The latest ' +
  'user message asks for the handoff brief: write that brief now, as plain text, and then stop. ' +
  'Work continues in the replacement chat.';

async function dispatchTracked(
  context: CallContext,
  name: string,
  args: unknown,
  transportKey: string | null,
  requestId: string | null,
  surface: SurfaceId,
  run: () => Promise<ToolResult>,
  nested: boolean
): Promise<ToolResult> {
  noteTransportIdentity(transportKey);
  const markTiming = beginToolExecutionTiming();
  // Recorded here rather than in `guard` because only this layer knows which server Tool-call history is tracked per surface so setup can prove which surface was used. question the setup screen has to answer honestly.
  surfaceToolCallAt.set(surface, Date.now());
  const isFinish = isFinishCall(name, args);
  const startedAt = context.startedAt;
  const allowUnattributed = context.allowUnattributed === true;
  // Cheap, non-blocking ingress identity. When the page has already reported this exact request id, identity-sensitive handlers (workspace/session/agents) see it before they touch state. If the page is one tick late this stays null; only handlers that actually require identity wait for their own exact mate. Ordinary absolute reads/execs never wait.
  if (!nested) setCallerConversation(context, callerConversation(name, startedAt, requestId));
  await reconcileAgentRequestOwners().catch(error => {
    logWarn(`Worker ownership recovery deferred: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!context.caller.conversationId) setCallerConversation(context, callerConversation(name, startedAt, requestId));
  const { identitySensitive } = await resolveDispatchIdentity({
    context,
    name,
    args,
    startedAt,
    requestId,
    surface,
    allowUnattributed
  });
  const supersededConversation = context.caller.conversationId
    ? (await conversationAttachment(context.caller.conversationId, context.caller.sessionId ?? null)) === 'superseded'
    : false;
  // Preserve the pre-strict fast path exactly: when strict mode is off, Block is a synchronous exact-chat lookup and ordinary calls do not acquire extra microtask yields. Interactive PTYs are timing-sensitive enough that needless awaits can change which terminal frame a poll sees.
  const conversationPolicyRefusal = strictChatAllowlistEnabled()
    ? await conversationAccessRefusal(context.caller.conversationId)
    : isChatBlocked(context.caller.conversationId) ? BLOCKED_CHAT_REFUSAL : null;
  const silentFinishAuthorized = await maintainAgentLiveness({
    context,
    isFinish,
    supersededConversation,
    accessRefused: Boolean(conversationPolicyRefusal),
    requestId
  });
  context.agent = isFinish ? agentForFinishCaller(context.caller) : agentForCaller(context.caller);
  const retiredWorker = retiredWorkerForConversation(context.caller.conversationId);
  // A ceiling-silenced worker is deliberately neither reusable nor terminal. The only ordinary call allowed through is one whose request id proved the exact retained turn and therefore cleared the marker above. Conversation identity by itself is not enough: a new user turn in the same chat must remain fenced from local tools.
  const silentCeilingWorker = isFinish && silentFinishAuthorized
    ? null
    : silentCeilingWorkerNotice(context.caller.conversationId);
  // Parking a run releases its global execution claim without retiring its worker chats. Those exact conversations remain workers, though: a stale sleeping/terminal worker tab must not turn into an ordinary unidentified chat and keep running local tools merely because another prime currently owns the active run (or because no run is active at all). Only the owning prime's explicit agents message may wake a sleeping worker.
  const dormantWorker = isFinish ? null : dormantWorkerNotice(context.caller.conversationId);
  // A worker that really is over learns so on its own next call. Without this its calls resolved to nobody and ran anyway, so a chat the user had ended went on writing files in the name of no agent at all. A terminal worker may do exactly one thing: retry its own idempotent finish after a lost result. It still has a tombstone identity for that call so the dispatcher can re-offer the inbox that rode on the missing result. Every other tool call from the same chat is refused by endedWorkerNotice as before.
  const endedWorker = isFinish ? null : endedWorkerNotice(context.caller.conversationId);
  // User blocks apply to every local tool, while an open handoff fences its source chat until the durable commit.
  const compacting = !conversationPolicyRefusal && compactingConversation(context.caller.conversationId) !== null;
  const retiredLeaseAmbiguous =
    !allowUnattributed && hasRetiredWorkerLeases() && !context.caller.conversationId;
  const dormantLeaseAmbiguous =
    !allowUnattributed && hasDormantWorkerLeases() && !context.caller.conversationId;
  // In a swarm, a relative/defaulted filesystem operation is not safe to execute after the exact caller lookup timed out: its workspace is part of the requested operation. Falling back to the first approved root turns an attribution outage into wrong-project mutation. Refuse and let the model retry once page evidence is healthy instead. The arrival of this exact call acknowledges earlier injected input before the handler reads the queue. New queued input is still offered only with its result.
  if (!nested) await acknowledgeToolInput(context.caller.sessionId, context.caller.conversationId, requestId, startedAt)
    .catch(() => logWarn('Prior user input receipt could not be saved; its existing claim is preserved'));
  // Permission can change while the liveness/recovery bookkeeping above awaits disk or browser evidence. A prior refusal is monotonic, while a new revoke must take effect before any background result is acknowledged or the requested handler is entered.
  let preAckPolicyRefusal = conversationPolicyRefusal;
  if (!preAckPolicyRefusal && strictChatAllowlistEnabled()) {
    preAckPolicyRefusal = await conversationAccessRefusal(context.caller.conversationId);
  }
  if (!nested && requestId && !preAckPolicyRefusal && !supersededConversation && !compacting) {
    const explicitPoll = name === 'write_stdin' && args && typeof args === 'object'
      ? (args as { session_id?: number }).session_id : undefined;
    const principal = executionPrincipal(requestId, context.caller.sessionId, allowUnattributed);
    await acknowledgeBackgroundExecOutput(principal, startedAt, explicitPoll);
  }
  let admissionRefusal = preAckPolicyRefusal;
  if (!admissionRefusal && strictChatAllowlistEnabled()) {
    admissionRefusal = await conversationAccessRefusal(context.caller.conversationId);
  }
  if (!admissionRefusal) {
    // Make the final policy decision with no intervening await before the handler is entered. This is the revoke race's last fence. Only a final allow ends a prior refusal episode.
    if (strictChatAllowlistEnabled()) {
      admissionRefusal = await conversationAccessRefusal(context.caller.conversationId);
    }
    if (!admissionRefusal) clearUntrustedRefusalEpisode(context);
  }
  if (admissionRefusal === STRICT_CHAT_REFUSAL) await recordUntrustedRefusalNotice(context);
  let handlerRan = false;
  markTiming('identity');
  const invokeHandler = (): Promise<ToolResult> => {
    handlerRan = true;
    return run();
  };
  const admission = resolveToolAdmission({
    policyRefusal: admissionRefusal,
    compacting,
    compactionRefusal: COMPACTION_IN_PROGRESS_REFUSAL,
    supersededConversation,
    silentCeilingWorker,
    dormantWorker,
    retiredWorker,
    endedWorker,
    retiredLeaseAmbiguous,
    dormantLeaseAmbiguous,
    missingSwarmIdentity: () => !allowUnattributed && swarmRunning() && identitySensitive && !context.caller.conversationId,
    nested,
    name,
    finishCall: isFinish
  });
  const result = await runInCallContext(context, () => {
    if (!admission) return invokeHandler();
    return Promise.resolve(admission.kind === 'identity' ? failIdentity(admission.message) : fail(admission.message));
  });
  markTiming('handler');
  return completeToolDispatch({
    context,
    name,
    args,
    surface,
    result,
    isFinish,
    nested,
    startedAt,
    requestId,
    handlerRan,
    initialDeliveryFenced: Boolean(conversationPolicyRefusal) || compacting || supersededConversation || Boolean(silentCeilingWorker),
    markTiming
  });
}

/** Adopts an identity established *inside* a tool call. The dispatcher can only resolve a caller from what the call carried, which for the prime is nothing at all. The `agents` tool proves who is calling from evidence rendered after that call began, and this is how that answer gets back to the layers that need it: the record this call will be filed under, and the inbox attached to its result. Called only from the one tool that does that work, and only with an id it has just proven. */
export async function adoptAgent(agent: string | null): Promise<void> {
  const context = currentCall();
  if (!context || !agent) return;
  context.agent = agent;
  // Identity adoption is intentionally pure. A handler may prove identity more strongly than ingress could, but it must not also retire inbox state: the dispatcher owns exactly one ACK point after the handler, where it knows whether this call is a finish retry and can apply the finish-specific at-least-once rule correctly.
}

function isFinishCall(name: string, args: unknown): boolean {
  if (name !== 'agents') return false;
  if (!args || typeof args !== 'object') return false;
  return (args as Record<string, unknown>)['action'] === 'finish';
}

const toolPathResolver = createToolPathResolver({
  currentSessionId: () => currentCall()?.caller.sessionId ?? null,
  multiAgentEnabled: swarmRunning
});

export const resolveIn = toolPathResolver.resolveIn;

export async function resolveCwd(ctx: ToolContext, virtualPath: string | undefined): Promise<ResolvedCwd> {
  return toolPathResolver.resolveCwd(ctx.roots, virtualPath);
}

export function createRegistrar(
  server: Parameters<typeof createSurfaceRegistrar>[0],
  ctx: ToolContext,
  surface: SurfaceId,
  observe?: RegistrarObserver
): SurfaceRegistrar {
  return createSurfaceRegistrar(server, ctx, surface, observe, { dispatch, guard });
}

// Provider-neutral output formatting.


