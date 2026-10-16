import { offerToolInput, TOOL_INPUT_HEADER } from '../../../domains/sessions/input/input.js';
import {
  acknowledgeOffersForCaller,
  agentFamiliesForCaller,
  agentForCaller,
  agentForFinishCaller,
  agentForOwnedConversation,
  currentRunForCaller,
  reconcileAgentRequestOwners,
  releaseQuiescentRun
} from '../../../domains/automation/agents.js';
import { logInfo, logWarn } from '../../settings/logger.js';
import {
  isIdentityRefusal,
  rememberIdentityRefusal,
  withIdentityRecoveredNotice
} from './identity-notices.js';
import { holdWhileSettling, type CallContext } from './call-context.js';
import { withBackgroundExecRecovery, withInbox, withUnattributedNotice } from './tool-result-appendices.js';
import { recordAgentMessage, recordToolCall } from '../../../domains/sessions/history/recorder.js';
import { BLOCKED_CHAT_REFUSAL, isChatBlocked } from '../../../domains/sessions/continuity/blocked-chats.js';
import { conversationAccessRefusal, strictChatAllowlistEnabled } from '../../../domains/sessions/continuity/conversation-access.js';
import { compactingConversation } from '../../../domains/sessions/continuity/continuation.js';
import { conversationAttachment } from '../../../domains/sessions/history/store.js';
import { callerConversation, setCallerConversation } from './dispatch-identity.js';
import type { ToolExecutionPhase } from '../request-context.js';
import type { SurfaceId } from './surfaces.js';
import type { ToolContent, ToolResult } from './tool-contracts.js';

type DispatchResultInput = {
  context: CallContext;
  name: string;
  args: unknown;
  surface: SurfaceId;
  result: ToolResult;
  isFinish: boolean;
  nested: boolean;
  startedAt: number;
  requestId: string | null;
  handlerRan: boolean;
  initialDeliveryFenced: boolean;
  markTiming: (phase: ToolExecutionPhase, complete?: boolean) => void;
};

export async function completeToolDispatch(input: DispatchResultInput): Promise<ToolResult> {
  const {
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
    initialDeliveryFenced,
    markTiming
  } = input;
  if (isIdentityRefusal(result)) rememberIdentityRefusal(requestId, name);
  // Keep identity already proven by the handler; a second lookup could discard stronger evidence.
  if (!context.caller.conversationId) {
    const resolved = callerConversation(name, startedAt, requestId);
    if (resolved) setCallerConversation(context, resolved);
  }
  await reconcileAgentRequestOwners().catch(error => {
    logWarn(`Worker ownership recovery deferred after tool completion: ${error instanceof Error ? error.message : String(error)}`);
  });
  const deliveryPolicyRefusal = strictChatAllowlistEnabled()
    ? await conversationAccessRefusal(context.caller.conversationId)
    : isChatBlocked(context.caller.conversationId) ? BLOCKED_CHAT_REFUSAL : null;
  const deliveryFenced = initialDeliveryFenced || Boolean(deliveryPolicyRefusal) ||
    compactingConversation(context.caller.conversationId) !== null || Boolean(context.caller.conversationId &&
      (await conversationAttachment(context.caller.conversationId, context.caller.sessionId ?? null)) === 'superseded');
  // Preserve handler-proven identity so recovered worker calls keep the correct ownership and inbox.
  const exactRole = context.caller.conversationId ? agentForOwnedConversation(context.caller.conversationId) : null;
  const recoveredWorkerRole = context.agent === 'prime' && exactRole && exactRole !== 'prime' ? exactRole : null;
  if (recoveredWorkerRole) {
    // Keep the worker's original role when late proof identifies a provisional spawn as an existing worker.
    context.caller.runId = undefined;
    context.agent = recoveredWorkerRole;
  }
  const provenAgent = isFinish ? agentForFinishCaller(context.caller) : agentForCaller(context.caller);
  if (!context.agent || (context.caller.conversationId && provenAgent)) context.agent = provenAgent;
  // A later call proves the prior result was seen; finish retries remain at-least-once because retries use new request IDs.
  const acknowledgedForConversation = deliveryFenced || nested
    ? null
    : acknowledgeOffersForCaller(
        context.caller,
        isFinish,
        startedAt,
        isFinish
      );
  const acknowledged = acknowledgedForConversation?.messages ?? [];
  for (const message of acknowledged) {
    // Record acknowledged messages against the exact caller conversation, not a stale recipient label.
    await recordAgentMessage(message, 'delivered', context.caller.conversationId);
  }
  // Record the delivered result after notices; apply redaction only to dispatcher refusals.
  const baseResult = result;
  let delivered = nested ? baseResult : withUnattributedNotice(
    context.caller.conversationId,
    deliveryFenced ? baseResult : withInbox(context.caller, context.agent, baseResult, isFinish),
    context.caller.requestId,
    context.allowUnattributed === true
  );
  if (!nested && recoveredWorkerRole && !deliveryFenced) delivered = {
    ...delivered,
    content: [...delivered.content, { type: 'text', text: '\n--- Worker ownership recovered ---\n' +
      `Exact request proof identifies this caller as ${recoveredWorkerRole}. Any provisional fleet created by this request is attached to its real prime. ` +
      'Keep your worker role and continue using enabled tools for your assignment; do not repeat completed work.' }]
  };
  // Only an explicit finish signal advances a planned stage.
  const userInput = nested || deliveryFenced ? { messages: [], reminder: '' } : await offerToolInput(context.caller.sessionId, context.caller.conversationId, context.caller.requestId, startedAt, name === 'session_finish' && !result.isError).catch(() => {
    logWarn('User input could not be attached; the completed tool result is preserved');
    return { messages: [], reminder: '' };
  });
  if (userInput.messages.length) {
    const attachments: ToolResult['content'] = [];
    for (const [index, message] of userInput.messages.entries()) {
      attachments.push({ type: 'text', text: (index === 0 ? TOOL_INPUT_HEADER : '\n\n') + message.text });
      for (const image of message.images) attachments.push({ type: 'image', mimeType: 'image/webp', data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1) });
    }
    if (userInput.reminder) attachments.push({ type: 'text', text: '\n\n' + userInput.reminder });
    delivered = { ...delivered, content: [...delivered.content, ...attachments] };
  }
  if (!nested && handlerRan && !deliveryFenced) {
    delivered = await withBackgroundExecRecovery(context, delivered);
  }
  if (!nested) delivered = await withIdentityRecoveredNotice(context, delivered);
  // Project final app appendices once for hosts that consume structured results.
  if (surface === 'core' && delivered.structuredContent) {
    const supplemental = delivered.content.slice(baseResult.content.length)
      .filter((part): part is Extract<ToolContent, { type: 'text' }> => part.type === 'text')
      .map(part => part.text).join('\n');
    if (supplemental) delivered = { ...delivered, structuredContent: { ...delivered.structuredContent, supplemental_context: supplemental } };
  }
  const recorderStartedAt = Date.now();
  // Measure the full dispatch; recorder and HTTP completion use separate timings because they finish later.
  const durationMs = recorderStartedAt - startedAt;
  markTiming('delivery');
  const recording = recordToolCall({
    nested,
    tool: name,
    args,
    content: delivered.content,
    // Unexpected defects are already logged; an unclassified error result is an expected rejection.
    outcome: context.outcome ?? (result.isError ? 'tool_rejected' : 'ok'),
    durationMs,
    startedAt,
    evidence: context.evidence,
    agent: context.agent,
    bind: context.bindOnAttribution ?? null,
    requestId: context.caller.requestId,
    conversationId: context.caller.conversationId,
    sessionId: context.caller.sessionId ?? null,
    endsActivity: isFinish && !result.isError
  });
  // Append exact-request receipts before returning; unidentified receipts may still wait for page evidence.
  if (context.caller.conversationId) {
    await recording;
  } else {
    void recording.then(() => logInfo(`mcp recording surface=${surface} recorder_async_ms=${Date.now() - recorderStartedAt}`));
    holdWhileSettling(context, recording);
  }
  // Retire a completed run after its acknowledgement and inbox delivery are complete.
  const callerRunId = currentRunForCaller(context.caller);
  if (!deliveryFenced && callerRunId) releaseQuiescentRun({}, callerRunId);
  else if (!deliveryFenced && !context.caller.runId) {
    for (const family of agentFamiliesForCaller(context.caller)) if (family.running) releaseQuiescentRun({}, family.run_id);
  }
  markTiming('recorder', true);
  return delivered;
}
