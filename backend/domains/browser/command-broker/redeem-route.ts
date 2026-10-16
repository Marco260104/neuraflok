import type http from 'node:http';
import { claimContinuationNow, continuationByToken, sendUnattempted } from '../../sessions/continuity/continuation.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';
import { primeConversation } from '../../automation/agents.js';
import { findSessionByConversation } from '../../sessions/history/store.js';
import { prepareSessionPrompt } from '../../sessions/input/prompt.js';
import { MAX_PROVIDER_MESSAGE_CHARS } from '../../../../contracts/messaging/provider-message-envelope.js';
import { conversationId } from '../companion-payload.js';
import type { CommandRouteRuntime } from './routes-runtime.js';
import { createRouteResponders } from './route-responses.js';

export async function handleCommandRedeemRoute(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, runtime: CommandRouteRuntime): Promise<boolean> {
  if (route !== '/commands/redeem' || req.method !== 'POST') return false;
  const { respond, respondTooLarge } = createRouteResponders(runtime, origin);
  if (runtime.staleCompanion(req)) return respond(res, 409, { error: 'stale_extension_build' }, origin);
  let body: Record<string, unknown>;
  try {
    body = (await runtime.readBody(req)) as Record<string, unknown>;
  } catch (err) {
    if ((err as Error).message === 'body_too_large') return respondTooLarge(res, origin);
    return respond(res, 400, { error: 'bad_request' }, origin);
  }
  runtime.tidyCommands();
  const wanted = typeof body['id'] === 'string' ? body['id'] : '';
  const client = typeof body['client'] === 'string' ? body['client'].slice(0, 64) : '';
  const reportedConversation = body['conversationId'] === undefined ? null : conversationId(body['conversationId']);
  if (body['conversationId'] !== undefined && !reportedConversation) {
    return respond(res, 400, { error: 'bad_conversation_id' }, origin);
  }
  const command = runtime.commands.find((entry) => entry.id === wanted);
  if (!command) {
    // Cancelled, superseded, already sent, or from a previous run of the app.
    return respond(res, 404, { error: 'no_such_command' }, origin);
  }
  if (command.spec.type === 'stop') {
    if (!client || Date.now() - command.createdAt >= runtime.STOP_COMMAND_TIMEOUT_MS || reportedConversation !== command.spec.conversationId || !await runtime.stopCommandCurrent(command.spec))
      return respond(res, 409, { error: 'stop_turn_changed' }, origin);
    if (!await runtime.persistCommandLease(command, client, Date.now(), false)) return respond(res, 409, { error: 'stop_not_owned' }, origin);
    if (!runtime.commands.includes(command) || Date.now() - command.createdAt >= runtime.STOP_COMMAND_TIMEOUT_MS || !await runtime.stopCommandCurrent(command.spec)) return respond(res, 409, { error: 'stop_turn_changed' }, origin);
    return respond(res, 200, { command: runtime.describe(command, client) }, origin);
  }
  if (runtime.revivalDeliveryProven(command)) {
    // The browser send already crossed its semantic boundary.
    return respond(res, 409, { error: 'command_already_sent', final: true }, origin);
  }
  const resumeFence = command.spec.type === 'resume' ? continuationByToken(command.spec.token) : null;
  if (command.spec.type === 'resume' && !(resumeFence && sendUnattempted(resumeFence.destinationSend))) {
    return respond(res, 409, { error: 'command_already_sent', final: true }, origin);
  }
  if (command.spec.type === 'revive' && !runtime.revivalFor(command.spec.agent, command.spec.runId)) {
    // tidyCommands() above normally retires these.
    return respond(res, 404, { error: 'no_such_command' }, origin);
  }
  if (
    reportedConversation &&
    (command.spec.type !== 'revive' || command.spec.conversationId !== reportedConversation)
  ) {
    // Existing pages may claim only an exact revival, never a fresh-chat command.
    return respond(res, 409, { error: 'command_wrong_conversation' }, origin);
  }
  // One command, one page.
  const resumeTakeover = Boolean(resumeFence && sendUnattempted(resumeFence.destinationSend));
  if (command.owner && command.owner !== client && !resumeTakeover) {
    return respond(res, 409, { error: 'command_taken' }, origin);
  }
  // Renew rather than count another attempt: the app already spent one opening this page, and this is that same attempt arriving.
  const claimedAt = Date.now();
  if (command.spec.type === 'revive') {
    const claimed = await runtime.persistRevivalRedeem(command, client, claimedAt);
    if (claimed === 'stale') {
      // A proven MCP call won `waking -> active` before this browser claimed the wake.
      runtime.retire(command, 'its worker became active before the browser claimed the wake');
      return respond(res, 404, { error: 'no_such_command' }, origin);
    }
    if (claimed === 'taken') return respond(res, 409, { error: 'command_taken' }, origin);
    if (claimed === 'broker-not-durable') {
      return respond(res, 503, { error: 'worker_revival_claim_not_durable', retryable: true }, origin);
    }
    if (claimed === 'lease-not-durable') {
      return respond(res, 503, { error: 'command_lease_not_durable', retryable: true }, origin);
    }
  } else if (!(await runtime.persistCommandLease(command, client, claimedAt, resumeTakeover))) {
    if (command.owner && command.owner !== client && !resumeTakeover) {
      return respond(res, 409, { error: 'command_taken' }, origin);
    }
    return respond(res, 503, { error: 'command_lease_not_durable', retryable: true }, origin);
  }
  // `claim()` armed the original browser-open deadline.
  runtime.armDeadline(command);
  runtime.changed();
  let claimedSummary: string | undefined;
  if (command.spec.type === 'resume') {
    try {
      // The command, not one browser document, is the semantic claimant.
      const token = command.spec.token;
      const claimed = await runtime.writeCommandTransition(command, async () => {
        if (!runtime.commands.includes(command) || command.owner !== client) return false;
        const result = await claimContinuationNow(token, command.id);
        claimedSummary = result?.summary;
        return !!result;
      });
      if (!claimed) return respond(res, 409, { error: 'continuation_not_claimable' }, origin);
      // Replace the short page-open timer with the continuation's existing outer lifetime.
      runtime.armDeadline(command);
    } catch (err) {
      logWarn(`bridge: could not durably claim ${runtime.specKey(command.spec)} — ${err instanceof Error ? err.message : String(err)}`);
      return respond(res, 503, { error: 'continuation_claim_not_durable', retryable: true }, origin);
    }
  }
  const described = runtime.describe(command, client, claimedSummary);
  if (described.text && command.spec.type === 'worker') {
    // A newly spawned worker gets setup once.
    const sourceConversation = primeConversation(command.spec.runId);
    const source = sourceConversation ? await findSessionByConversation(sourceConversation, { requireUnique: true }) : null;
    const sessionId = source?.conversationId === sourceConversation ? source?.id : undefined;
    described.text = await prepareSessionPrompt(described.text, { sessionId });
  }
  if (!runtime.commands.includes(command) || command.owner !== client) return respond(res, 409, { error: 'command_taken' }, origin);
  const liveResume = command.spec.type === 'resume' ? continuationByToken(command.spec.token) : null;
  if (command.spec.type === 'resume' && (!liveResume || !sendUnattempted(liveResume.destinationSend)))
    return respond(res, 409, { error: 'command_already_sent', final: true }, origin);
  if (described.text.length > MAX_PROVIDER_MESSAGE_CHARS) return respond(res, 409, { error: 'command_text_too_large', message: 'The complete prompt and task exceed the browser message limit.' }, origin);
  return respond(res, 200, { command: described }, origin);
}
