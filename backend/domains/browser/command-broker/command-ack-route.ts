import type http from 'node:http';
import { conversationId } from '../companion-payload.js';
import { abortContinuationNow, commitContinuationResult, continuationByToken } from '../../sessions/continuity/continuation.js';
import { logInfo, logWarn } from '../../../infrastructure/settings/logger.js';
import { agentConversation, agentInfoForOwnedConversation, bindConversation, failAgent, failWorkerRevival, noteWorkerRevived, persistCriticalSwarmNow, releaseQuiescentRun, swarmRunning, workerRevivalDeliveredSince } from '../../automation/agents.js';
import { findSessionByConversation } from '../../sessions/history/store.js';
import { noteChatOrigin } from '../../sessions/history/recorder.js';
import { bindAgentWorkspace } from '../../workspace/workspace.js';
import type { AckStatus, CommandReceipt } from './model.js';
import type { CommandRouteRuntime } from './routes-runtime.js';
import { createRouteResponders } from './route-responses.js';

export async function handleCommandAckRoute(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, runtime: CommandRouteRuntime): Promise<boolean> {
  if (route !== '/commands/ack' || req.method !== 'POST') return false;
  const { respond, respondTooLarge } = createRouteResponders(runtime, origin);
  let body: Record<string, unknown>;
  try {
    body = (await runtime.readBody(req)) as Record<string, unknown>;
  } catch (err) {
    if ((err as Error).message === 'body_too_large') return respondTooLarge(res, origin);
    return respond(res, 400, { error: 'bad_request' }, origin);
  }
  const id = typeof body['id'] === 'string' ? body['id'] : '';
  // A protocol-1 extension sends no status and only ever acknowledges a success, so a missing status still means "sent".
  const raw = typeof body['status'] === 'string' ? body['status'] : 'sent';
  const status: AckStatus = raw === 'failed' ? 'failed' : 'sent';
  const error = typeof body['error'] === 'string' ? body['error'].slice(0, 200) : null;
  const client = typeof body['client'] === 'string' ? body['client'].slice(0, 64) : '';
  const conversation = conversationId(body['conversationId']);
  const priorReceipt = runtime.receiptFor(id);
  if (priorReceipt) {
    // A receipt is the final answer to an ambiguous/lost ACK response.
    if ((priorReceipt.client ?? '') !== client) {
      return respond(res, 409, { error: 'receipt_client_changed' }, origin);
    }
    if ((priorReceipt.conversationId ?? null) !== conversation) {
      return respond(res, 409, { error: 'receipt_conversation_changed' }, origin);
    }
    return respond(res, 200, runtime.receiptReply(priorReceipt), origin);
  }
  const ownedCommand = runtime.commands.find((command) => command.id === id) ?? null;
  // Every current page echoes its per-document client.
  if (!ownedCommand && client) {
    return respond(res, 404, { error: 'no_such_command' }, origin);
  }
  if (!ownedCommand) {
    // Compatibility for an already-open legacy page that predates document ids: historically an ACK whose command was already gone was an idempotent no-op.
    return respond(res, 200, { ok: true }, origin);
  }
  // The document that redeemed the marker is the only document allowed to finish it.
  if (ownedCommand && client && ownedCommand.owner !== client) {
    return respond(res, 409, { error: 'command_owner_changed' }, origin);
  }
  if (ownedCommand && client && ownedCommand.claimedAt === null) {
    return respond(res, 409, { error: 'command_not_leased' }, origin);
  }
  if (ownedCommand.spec.type === 'stop') {
    if (!client || conversation !== ownedCommand.spec.conversationId || body.turnId !== ownedCommand.spec.turnId)
      return respond(res, 409, { error: 'stop_identity_changed' }, origin);
    const receipt: CommandReceipt = { id, client, conversationId: conversation, outcome: status === 'sent' ? 'committed' : 'terminal-failure',
      committed: status === 'sent', error: status === 'sent' ? null : error || 'native_stop_unavailable', completedAt: Date.now() };
    if (!await runtime.finalizeCommand(ownedCommand, receipt)) return respond(res, 503, { error: 'command_receipt_not_durable' }, origin);
    runtime.changed();
    return respond(res, 200, runtime.receiptReply(receipt), origin);
  }
  const agent = ownedCommand?.spec.type === 'worker' ? ownedCommand.spec.agent : null;
  // The one moment at which the queued command and the conversation it became are both in hand, and so the only chance to name that chat after the work rather than after the bootstrap prompt about to be typed into it.
  const opened = status === 'sent' ? await runtime.commandOrigin(id) : null;
  if (conversation && opened) {
    await noteChatOrigin(conversation, opened).catch((err: Error) =>
      logWarn(`could not record the origin of a fresh chat: ${err.message}`)
    );
  }
  // noteChatOrigin() is an awaited side operation.
  const afterOriginReceipt = runtime.receiptFor(id);
  if (afterOriginReceipt) {
    if ((afterOriginReceipt.client ?? '') !== client || (afterOriginReceipt.conversationId ?? null) !== conversation) {
      return respond(res, 409, { error: 'receipt_identity_changed' }, origin);
    }
    return respond(res, 200, runtime.receiptReply(afterOriginReceipt), origin);
  }
  const command = runtime.commands.find((entry) => entry.id === id) ?? null;
  if (!command || command !== ownedCommand) {
    return respond(res, 404, { error: 'no_such_command' }, origin);
  }
  if (command.spec.type === 'stop') return respond(res, 409, { error: 'command_identity_changed' }, origin);
  if (client && command.owner !== client) {
    return respond(res, 409, { error: 'command_owner_changed' }, origin);
  }

  let receipt: CommandReceipt;
  if (status === 'sent') {
    if (!conversation && command.spec.type !== 'worker') {
      // A successful page send without a concrete chat id is ambiguous, not terminal.
      return respond(res, 503, { error: 'conversation_required', retryable: true }, origin);
    }
    if (command.spec.type === 'revive') {
      // Narrowed above.
      if (!conversation) return respond(res, 503, { error: 'conversation_required', retryable: true }, origin);
      const revive = command.spec;
      const wrongChat = conversation !== revive.conversationId;
      const staleRun = !swarmRunning(revive.runId);
      const revival = wrongChat || staleRun ? null : runtime.revivalFor(revive.agent, revive.runId);
      const alreadySent =
        !wrongChat &&
        !staleRun &&
        command.claimedAt !== null &&
        workerRevivalDeliveredSince(revive.agent, conversation, command.id, command.claimedAt, revive.runId);
      // The send is an *offer*, not an acknowledgement: the words are in the worker's chat, and the worker's own next authenticated call is what retires them from its inbox.
      const woke = alreadySent || (revival ? noteWorkerRevived(revive.agent, conversation, revival.messageIds, command.id, revive.runId) : false);
      if (woke) {
        receipt = {
          id,
          client: client || command.owner,
          conversationId: conversation,
          outcome: 'committed',
          committed: true,
          error: null,
          completedAt: Date.now()
        };
      } else {
        const why = wrongChat
          ? 'the page that was opened for it was showing a different conversation'
          : staleRun
            ? 'the worker run that owns this chat has ended'
            : 'it was no longer waiting to be woken by the time the browser answered';
        // Only the first two are this revival's to undo.
        failWorkerRevival(revive.agent, why, revive.runId);
        receipt = {
          id,
          client: client || command.owner,
          conversationId: conversation,
          outcome: 'terminal-failure',
          committed: false,
          error: why,
          completedAt: Date.now()
        };
      }
    } else if (command.spec.type === 'resume') {
      // Narrowed above.
      if (!conversation) return respond(res, 503, { error: 'conversation_required', retryable: true }, origin);
      const result = await commitContinuationResult(command.spec.token, conversation);
      if (result.status === 'retryable') {
        logWarn(`bridge: resume commit for ${command.spec.sessionId} remains retryable — ${result.reason}`);
        return respond(res, 503, { error: 'resume_commit_retryable', retryable: true }, origin);
      }
      if (result.status === 'rejected') {
        const state = continuationByToken(command.spec.token);
        if (state?.state === 'committing' || state?.state === 'committed') {
          // Once the WAL/session commit is non-abortable, a conflicting/lost ACK cannot turn it into a cancellation just because this HTTP request reached a bad branch.
          return respond(res, 503, { error: 'resume_commit_not_abortable', retryable: true }, origin);
        }
        try {
          const aborted = await abortContinuationNow(command.spec.token, result.reason);
          const afterAbort = continuationByToken(command.spec.token);
          if (!aborted && afterAbort?.state !== 'aborted') {
            if (afterAbort?.state === 'committing' || afterAbort?.state === 'committed') {
              return respond(res, 503, { error: 'resume_commit_not_abortable', retryable: true }, origin);
            }
            return respond(res, 503, { error: 'resume_abort_retryable', retryable: true }, origin);
          }
        } catch (err) {
          logWarn(`bridge: could not durably abort rejected resume ${command.spec.sessionId} — ${err instanceof Error ? err.message : String(err)}`);
          return respond(res, 503, { error: 'resume_abort_not_durable', retryable: true }, origin);
        }
        receipt = {
          id,
          client: client || command.owner,
          conversationId: conversation,
          outcome: 'terminal-failure',
          committed: false,
          error: result.reason,
          completedAt: Date.now()
        };
      } else {
        if (result.status === 'committed') runtime.armResumedChat(command.spec.sessionId, result.conversationId);
        receipt = {
          id,
          client: client || command.owner,
          conversationId: result.conversationId,
          outcome: 'committed',
          committed: true,
          error: null,
          completedAt: Date.now()
        };
      }
    } else {
      if (!conversation) {
        const why = 'the chat this app opened for it never said which conversation it was';
        if (agent) failAgent(agent, why, undefined, {}, command.spec.runId);
        receipt = {
          id,
          client: client || command.owner,
          conversationId: null,
          outcome: 'terminal-failure',
          committed: false,
          error: why,
          completedAt: Date.now()
        };
        if (!(await runtime.finalizeCommand(command, receipt))) {
          return respond(res, 503, { error: 'command_receipt_not_durable', retryable: true }, origin);
        }
        logInfo(`bridge: ${runtime.specKey(command.spec)} completed with ${receipt.outcome}`);
        void runtime.deliver();
        return respond(res, 200, runtime.receiptReply(receipt), origin);
      }
      if (!swarmRunning(command.spec.runId)) {
        // A command id is precise, but it is not immortal.
        receipt = {
          id,
          client: client || command.owner,
          conversationId: conversation,
          outcome: 'terminal-failure',
          committed: false,
          error: 'the worker run that opened this chat has ended',
          completedAt: Date.now()
        };
      } else {
      // This is where a worker starts.
      if (agent && /^[a-z0-9-]{1,40}$/i.test(agent)) {
        const boundNow = bindConversation(agent, conversation, command.spec.runId);
        // The worker inherited a workspace before its chat existed, under the reusable friendly id `agent:worker-N`.
        if (boundNow) bindAgentWorkspace(agent, conversation, command.spec.runId);
      }
      const bound = agent ? agentConversation(agent, command.spec.runId) === conversation : false;
      if (!bound) {
        const why = 'the chat this app opened for the worker could not be bound to that slot';
        if (agent) failAgent(agent, why, undefined, {}, command.spec.runId);
        receipt = {
          id,
          client: client || command.owner,
          conversationId: conversation,
          outcome: 'terminal-failure',
          committed: false,
          error: why,
          completedAt: Date.now()
        };
      } else {
        receipt = {
          id,
          client: client || command.owner,
          conversationId: conversation,
          outcome: 'committed',
          committed: true,
          error: null,
          completedAt: Date.now()
        };
      }
      }
    }
  } else if (command.spec.type === 'resume') {
    const state = continuationByToken(command.spec.token);
    if (state?.state === 'committed') {
      receipt = {
        id,
        client: client || command.owner,
        conversationId: state.to,
        outcome: 'committed',
        committed: true,
        error: null,
        completedAt: Date.now()
      };
    } else {
      const why = error ? `the browser could not start the chat — ${error}` : 'the browser could not start the chat';
      try {
        const aborted = await abortContinuationNow(command.spec.token, why);
        const afterAbort = continuationByToken(command.spec.token);
        if (!aborted && afterAbort?.state !== 'aborted') {
          if (afterAbort?.state === 'committing' || afterAbort?.state === 'committed') {
            return respond(res, 503, { error: 'resume_commit_not_abortable', retryable: true }, origin);
          }
          return respond(res, 503, { error: 'resume_abort_retryable', retryable: true }, origin);
        }
      } catch (err) {
        logWarn(`bridge: could not durably abort failed resume ${command.spec.sessionId} — ${err instanceof Error ? err.message : String(err)}`);
        return respond(res, 503, { error: 'resume_abort_not_durable', retryable: true }, origin);
      }
      receipt = {
        id,
        client: client || command.owner,
        conversationId: conversation,
        outcome: 'terminal-failure',
        committed: false,
        error: why,
        completedAt: Date.now()
      };
    }
  } else if (command.spec.type === 'revive') {
    // An error comes from the worker's own page, so the chat did open: what failed is the message.
    const why = error
      ? `the worker's chat did not take the message — ${error}`
      : "the browser could not reopen the worker's chat";
    failWorkerRevival(command.spec.agent, why, command.spec.runId);
    receipt = {
      id,
      client: client || command.owner,
      conversationId: conversation,
      outcome: 'terminal-failure',
      committed: false,
      error: why,
      completedAt: Date.now()
    };
  } else {
    const why = error ? `the browser could not start the chat — ${error}` : 'the browser could not start the chat';
    if (agent) failAgent(agent, why, undefined, {}, command.spec.runId);
    receipt = {
      id,
      client: client || command.owner,
      conversationId: conversation,
      outcome: 'terminal-failure',
      committed: false,
      error: why,
      completedAt: Date.now()
    };
  }

  if (command.spec.type === 'worker' || command.spec.type === 'revive') {
    // The browser command and the swarm snapshot are two durable files describing one transition.
    try {
      if (!(await persistCriticalSwarmNow())) {
        return respond(res, 503, { error: 'worker_state_not_durable', retryable: true }, origin);
      }
    } catch (err) {
      logWarn(`bridge: worker state for ${runtime.specKey(command.spec)} is not durable yet — ${err instanceof Error ? err.message : String(err)}`);
      return respond(res, 503, { error: 'worker_state_not_durable', retryable: true }, origin);
    }
  }

  if (command.spec.type === 'revive' && receipt.committed) {
    // The native turn can precede this ACK by milliseconds.
    const { spec, claimedAt, owner } = command;
    const sameDelivery = () => command.spec === spec && command.claimedAt === claimedAt && command.owner === owner;
    const session = await findSessionByConversation(spec.conversationId, { requireUnique: true });
    if (!sameDelivery()) return respond(res, 409, { error: 'command_identity_changed' }, origin);
    if (session?.conversationId === spec.conversationId &&
        !(await runtime.reconcileWorkerFinish(spec.conversationId, session.id))) {
      return respond(res, 503, { error: 'worker_state_not_durable', retryable: true }, origin);
    }
    if (!(await persistCriticalSwarmNow())) {
      return respond(res, 503, { error: 'worker_state_not_durable', retryable: true }, origin);
    }
    if (!sameDelivery()) return respond(res, 409, { error: 'command_identity_changed' }, origin);
    if (agentInfoForOwnedConversation(spec.conversationId)?.state !== 'waking') {
      if (!(await runtime.finalizeCommand(command, receipt))) {
        return respond(res, 503, { error: 'command_receipt_not_durable', retryable: true }, origin);
      }
      void runtime.deliver();
      return respond(res, 200, runtime.receiptReply(receipt), origin);
    }
    // Delivery is not worker liveness.
    logInfo(`bridge: ${runtime.specKey(command.spec)} was delivered; waiting for attributed worker activity`);
    runtime.changed();
    void runtime.deliver();
    return respond(res, 200, runtime.receiptReply(receipt), origin);
  }

  if (!(await runtime.finalizeCommand(command, receipt))) {
    // The semantic operation may already be committed.
    return respond(res, 503, { error: 'command_receipt_not_durable', retryable: true }, origin);
  }
  // A failed application/revival can be the transition that frees the final worker slot, and unlike an MCP call there is no dispatcher epilogue after this ACK.
  releaseQuiescentRun();
  logInfo(`bridge: ${runtime.specKey(command.spec)} completed with ${receipt.outcome}`);
  void runtime.deliver();
  return respond(res, 200, runtime.receiptReply(receipt), origin);
}
