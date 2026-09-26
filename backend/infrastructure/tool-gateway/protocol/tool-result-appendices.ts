import { backgroundExecRecoveryNotices, executionPrincipal, offerBackgroundExecOutput } from '../../../domains/workspace/execution/ownership.js';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../../../domains/workspace/execution/unified-exec-constants.js';
import { unattributedRepairEta } from '../../../domains/browser/bridge.js';
import { offerMessagesForCaller } from '../../../domains/automation/agents.js';
import type { CallCaller, CallContext } from './call-context.js';
import type { ToolResult } from './tool-contracts.js';
/** Deliver bounded completed output after all other appendices have spent their text budget. */
export async function withBackgroundExecRecovery(
  context: CallContext,
  result: ToolResult
): Promise<ToolResult> {
  const { publication, caller } = context;
  if (!publication || !caller.requestId) return result;
  const principal = executionPrincipal(caller.requestId, caller.sessionId, context.allowUnattributed === true);
  if (!principal) return result;
  const used = result.content.reduce((bytes, part) => bytes + (part.type === 'text' ? Buffer.byteLength(part.text, 'utf8') : 0), 0);
  const budget = Math.min(12_000, DEFAULT_MAX_OUTPUT_TOKENS * 4 - used) - 64;
  if (budget < 1_024) return result;
  const output = await offerBackgroundExecOutput(principal, publication, budget);
  // The page is the priority. Running-terminal reminders can wait for a later response.
  const text = output ?? backgroundExecRecoveryNotices(principal, publication).join('\n');
  if (!text) return result;
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text', text: `\n--- Background command results ---\n${text}` }
    ]
  };
}

/** Reports an attribution gap without inventing the unknown caller's recovery target. A broken request-id join is invisible from inside the conversation. The tools answer, the turn reads normally, and the model has no way to know the app cannot tell who is calling — and recovery may reload an eligible active page. The notice must preserve the distinction between a completed local operation, its unknown attribution, and an undelivered agent message: none of those facts implies that completed work is about to disappear. */
export function withUnattributedNotice(
  conversationId: string | null | undefined,
  result: ToolResult,
  requestId: string | null,
  allowUnattributed: boolean
): ToolResult {
  if (conversationId) return result;
  const eta = unattributedRepairEta(Date.now(), requestId);
  const recovery = eta === null ? '' : `The next attribution recovery check is in about ${eta}s. `;
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: 'text',
        text: allowUnattributed
          ? '\n--- Identity notice ---\n' +
            'This call is filed as Unattributed because its exact provider conversation is not known yet. ' +
            'Unattributed does not switch on Read-only mode or disable tools. Continue using enabled workspace, ' +
            'browser and desktop tools; their existing permissions still apply. ' +
            (requestId
              ? 'This request id owns its workspace, update_plan, terminals and agents/subagents. Use the process and run ids returned to this request; later exact proof attaches that state to its chat. '
              : 'This call has no request id, so request-owned plans and worker families cannot be created until a request id or exact provider conversation proof is available. ') +
            'A refusal about a particular process, worker or chat target applies only to that operation, not to file edits or other tools. ' +
            'Report the actual tool result; do not claim mutation or terminal tools are unavailable because of this notice, and never replay successful work. ' +
            recovery
          : '\n--- Identity notice ---\n' +
            'This app could not tell which provider conversation made this call, so it is filed as ' +
            'Unattributed. ' + recovery +
            'This does not identify this chat as a reload target. The result above still states what ran. ' +
            'Attribution does not change tool permissions or mean Read-only; report a refusal only for the operation that actually failed. ' +
            'Do not repeat a successful mutation to repair attribution. A later exact request-id match can ' +
            'reattach this recorded call. Retry a refused operation once, and preserve any undelivered report in the chat.'
      }
    ]
  };
}

/** Appends the messages waiting for this agent to the tool result. This is the push-like delivery: an agent gets whatever has been said to it since its last call, at the end of every result, with no polling loop. It works for a call this app could place in a conversation, which is most of them and never all of them — so nothing is retired here, and a message the page could not confirm is simply offered again next time. Messages are *offered* here, not retired. They are retired when this agent calls again, because that is the first real evidence this result reached provider client. */
export function withInbox(
  caller: CallCaller,
  agent: string | null,
  result: ToolResult,
  onFinish = false
): ToolResult {
  // Conversation ownership is the durable authority. This matters most for a parked prime: there is deliberately no live `agent:prime` while another history may be active, but its exact conversation still owns final worker reports queued before parking. The finish flag also preserves the one dormant-worker exception: retrying a lost finish result may re-offer rows that rode on that finish, without re-authorising ordinary worker activity.
  const scoped = offerMessagesForCaller(caller, onFinish, onFinish);
  const recipient = scoped?.agentId ?? agent;
  const messages = scoped?.messages ?? [];
  if (messages.length === 0) return result;
  const lines = messages
    .map((message) => {
      const route = message.fromRunId
        ? ` [source_run_id=${message.fromRunId}]${message.runId ? ` [received_on_run_id=${message.runId}]` : ''}`
        : message.runId
          ? ` [run_id=${message.runId}]`
          : '';
      return `• ${message.from}${route}${message.offers > 1 ? ' (delivery retry)' : ''}: ${message.text}`;
    })
    .join('\n');
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text', text: `\n--- ${messages.length} message(s) for ${recipient ?? 'this conversation'} ---\n${lines}` }
    ]
  };
}

