import http from 'node:http';
import { automaticCompactionAllowed, conversationWasSuperseded, findSessionByConversation, getSession } from '../sessions/history/store.js';
import { conversationId } from './companion-payload.js';
import { DEFAULT_HANDOFF_PROMPT } from '../../../contracts/sessions/continuity-brief.js';
import { isChatBlocked } from '../sessions/continuity/blocked-chats.js';
import { nativeHandoffPrompt } from '../sessions/continuity/handoff-prompt.js';
import { liveConversations } from '../sessions/history/recorder.js';
import {
  abortContinuationSourceBeforeSendNow,
  beginContinuationDestinationSendNow,
  beginContinuationSourceSendNow,
  bindContinuationDestinationMessageNow,
  bindContinuationSourceMessageNow,
  continuationClaimedBy,
  commitContinuationResult,
  continuationByToken,
  continuationForSession,
  dispatchContinuationDestinationSendNow,
  dispatchContinuationSourceSendNow,
  openContinuationNow,
  releaseContinuationDestinationSendNow,
  sendUnattempted
} from '../sessions/continuity/continuation.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import type { bridgeContinuationRouteRuntime } from './bridge.js';

// Handles the durable Compact & Resume transaction for the browser companion.
type Runtime = typeof bridgeContinuationRouteRuntime;

export async function handleBridgeContinuationRoutes(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, runtime: Runtime): Promise<boolean> {
  const {
    abortRejectedResume, armResumedChat, cancelAutomaticResumesNow, cancelResumeNow,
    captureCompactionBrief, captureRecordedBrief, changed, commands, compactionWatch,
    deliver, fileCompactionTicket, goalWorkerChat, noticeMarkedReplacement, queueResumeCommand,
    readBody, rememberToken, repairsInFlight, resumeJobFor, retire, writeCommandTransition
  } = runtime;
  const json = (response: http.ServerResponse, status: number, body: unknown, responseOrigin: string | null) => {
    runtime.json(response, status, body, responseOrigin);
    return true;
  };
  const tooLarge = (response: http.ServerResponse, responseOrigin: string | null) => {
    runtime.tooLarge(response, responseOrigin);
    return true;
  };
  if (route === '/compact' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const checkpointToken = typeof body['token'] === 'string' ? body['token'] : '';
    const checkpoint = continuationByToken(checkpointToken);
    if (checkpoint?.automatic &&
        (body['sourceAttempt'] === true || body['sourceDispatch'] === true || body['destinationAttempt'] === true || body['destinationDispatch'] === true) &&
        !automaticCompactionAllowed(await getSession(checkpoint.sessionId))) {
      await cancelAutomaticResumesNow(checkpoint.sessionId);
      return json(res, 409, { error: 'automatic_compaction_disabled' }, origin);
    }
    // The destination id is unknown before provider acceptance, so the continuation token owns the irreversible Send fence.
    const destinationCommand = commands.find(command => command.id === body['commandId'] &&
      command.spec.type === 'resume' && command.spec.token === checkpointToken);
    const destinationTransition = async (transition: () => Promise<boolean>): Promise<boolean> => {
      if (!destinationCommand) return false;
      return writeCommandTransition(destinationCommand, async () => {
        if (!commands.includes(destinationCommand) || !destinationCommand.owner || destinationCommand.owner !== body['client'] ||
            !continuationClaimedBy(checkpointToken, destinationCommand.id)) return false;
        return transition();
      });
    };
    if (body['destinationAttempt'] === true) {
      let result: Awaited<ReturnType<typeof beginContinuationDestinationSendNow>> = null;
      await destinationTransition(async () => { result = await beginContinuationDestinationSendNow(checkpointToken); return !!result; });
      const accepted = result as Awaited<ReturnType<typeof beginContinuationDestinationSendNow>>;
      return accepted
        ? json(
            res,
            200,
            { allowed: accepted.allowed, destinationSend: accepted.checkpoint },
            origin
          )
        : json(res, 409, { error: 'destination_send_not_available' }, origin);
    }
    if (body['destinationDispatch'] === true) {
      const armed = await destinationTransition(() => dispatchContinuationDestinationSendNow(checkpointToken));
      return json(
        res,
        armed ? 200 : 409,
        armed ? { armed: true } : { error: 'destination_send_reclaimed' },
        origin
      );
    }
    if (body['destinationLost'] === true) {
      // The page armed the click and then proved the brief never left it. The lease belongs to that page and is retired with it, and the same brief is offered to a fresh chat at once — not after the quarter-hour the lease was measured for, and for a manual Compact & Resume as much as an automatic one: the ticket exists to land the brief, and Cancel is there for a user who meant the Escape.
      const released = await destinationTransition(() => releaseContinuationDestinationSendNow(checkpointToken));
      if (released) {
        const entry = continuationByToken(checkpointToken);
        for (const command of commands.filter(
          (candidate) => candidate.spec.type === 'resume' && candidate.spec.token === checkpointToken
        )) {
          retire(command, 'the page lost the brief before Send; nothing was sent');
        }
        if (entry) {
          queueResumeCommand(entry.sessionId, checkpointToken);
          void deliver();
        }
        logInfo(
          `bridge: the brief for ${entry?.sessionId ?? checkpointToken.slice(0, 8)} was lost before Send — offering it to a fresh chat`
        );
      }
      return json(
        res,
        released ? 200 : 409,
        released ? { released: true } : { error: 'destination_send_not_releasable' },
        origin
      );
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    if (body['sourceLost'] === true) {
      const entry = continuationByToken(checkpointToken);
      if (!entry || entry.from !== id) return json(res, 409, { error: 'no_such_continuation' }, origin);
      let aborted = false;
      try {
        const sourceError = typeof body['sourceError'] === 'string' ? body['sourceError'].trim().slice(0, 500) : '';
        aborted = await abortContinuationSourceBeforeSendNow(checkpointToken, sourceError || 'handoff_never_sent');
      } catch (err) {
        logWarn(
          `bridge: could not durably abandon the unsent source handoff for ${entry.sessionId} — ${err instanceof Error ? err.message : String(err)}`
        );
        return json(
          res,
          503,
          { error: 'source_abort_not_durable', retryable: true, sessionId: entry.sessionId, job: resumeJobFor(entry.sessionId) },
          origin
        );
      }
      if (!aborted) return json(res, 409, { error: 'source_send_not_releasable' }, origin);
      compactionWatch.delete(id);
      if (repairsInFlight.get(id)?.reason === 'compaction') repairsInFlight.delete(id);
      changed();
      return json(res, 200, { aborted: true, sessionId: entry.sessionId, job: resumeJobFor(entry.sessionId) }, origin);
    }
    // The last durable write before the click, quoting the claim handed out above. A false answer means this document was reclaimed while it was composing and must submit nothing.
    if (body['sourceDispatch'] === true) {
      const entry = continuationByToken(checkpointToken);
      if (!entry || entry.from !== id) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const armed = await dispatchContinuationSourceSendNow(checkpointToken);
      return json(res, armed ? 200 : 409, armed ? { armed: true } : { error: 'source_send_reclaimed' }, origin);
    }
    if (body['sourceAttempt'] === true) {
      const entry = continuationByToken(checkpointToken);
      if (!entry || entry.from !== id) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const result = await beginContinuationSourceSendNow(checkpointToken);
      return result
        ? json(
            res,
            200,
            { allowed: result.allowed, sourceSend: result.checkpoint },
            origin
          )
        : json(res, 409, { error: 'source_send_not_available' }, origin);
    }
    if (typeof body['sourceMessageId'] === 'string') {
      const entry = continuationByToken(checkpointToken);
      if (!entry || entry.from !== id) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const anchor = body['sourceMessageId'].slice(0, 200);
      const bound = await bindContinuationSourceMessageNow(checkpointToken, anchor,
        typeof body['sourceProgress'] === 'number' ? body['sourceProgress'] : undefined);
      if (!bound) return json(res, 409, { error: 'source_message_conflict' }, origin);
      // The durable authored anchor lets recorder-backed capture survive provider remounts that replace the visible message id.
      const captured = await captureRecordedBrief(id, checkpointToken, anchor);
      return captured
        ? json(res, captured.status, { ...captured.body, bound: true }, origin)
        : json(res, 200, { bound: true, job: resumeJobFor(entry.sessionId) }, origin);
    }
    if (typeof body['destinationMessageId'] === 'string') {
      const entry = continuationByToken(checkpointToken);
      if (!entry) {
        noticeMarkedReplacement(id, checkpointToken, 'unknown continuation');
        return json(res, 409, { error: 'no_such_continuation' }, origin);
      }
      const bound = await bindContinuationDestinationMessageNow(
        checkpointToken,
        id,
        body['destinationMessageId'].slice(0, 200)
      );
      if (!bound) {
        noticeMarkedReplacement(id, checkpointToken, 'destination message conflict');
        return json(res, 409, { error: 'destination_message_conflict' }, origin);
      }
      const result = await commitContinuationResult(checkpointToken, id);
      if (result.status === 'retryable') {
        noticeMarkedReplacement(id, checkpointToken, 'commit pending after a retryable failure');
        return json(res, 503, { error: 'resume_commit_retryable', retryable: true }, origin);
      }
      if (result.status === 'rejected') {
        noticeMarkedReplacement(id, checkpointToken, 'commit rejected');
        if (await abortRejectedResume(checkpointToken, result.reason)) {
          const refused = commands.find(
            (candidate) => candidate.spec.type === 'resume' && candidate.spec.token === checkpointToken
          );
          if (refused) retire(refused, 'the session layer refused the marked replacement message');
        }
        return json(res, 409, { error: 'resume_commit_rejected', message: result.reason }, origin);
      }
      const command = commands.find(
        (candidate) => candidate.spec.type === 'resume' && candidate.spec.token === checkpointToken
      );
      if (command) retire(command, 'the marked replacement message committed the continuation');
      if (result.status === 'committed') armResumedChat(entry.sessionId, result.conversationId);
      noticeMarkedReplacement(id, checkpointToken, 'committed');
      return json(
        res,
        200,
        {
          committed: true,
          conversationId: result.conversationId,
          commandId: command?.id ?? null
        },
        origin
      );
    }
    if (goalWorkerChat(id)) {
      return json(
        res,
        409,
        {
          error: 'worker_compaction_disabled',
          message: 'Worker chats stay in their existing conversation so the prime can revive them safely.'
        },
        origin
      );
    }
    // A blocked chat is stopped, and Compact & Resume would start it again: the replacement chat is a new conversation the block does not cover, opened on a brief this app typed.
    if (isChatBlocked(id)) {
      return json(
        res,
        409,
        {
          error: 'chat_blocked',
          message: 'This chat is blocked in the app. Release it there before compacting or resuming it.'
        },
        origin
      );
    }
    const live = liveConversations().find((entry) => entry.conversationId === id);
    const known = live ? null : await findSessionByConversation(id, { requireUnique: true });
    const sessionId = live?.sessionId ?? known?.id ?? null;
    if (!sessionId) {
      return json(
        res,
        409,
        {
          error: 'session_not_recorded',
          message: 'This chat has no recorded local session to compact.'
        },
        origin
      );
    }

    if (body['cancel'] === true) {
      let cancelled = false;
      try {
        cancelled = await cancelResumeNow(sessionId);
      } catch (err) {
        logWarn(`bridge: could not durably cancel Compact & Resume for ${sessionId} — ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 503, { error: 'resume_cancel_not_durable', retryable: true, sessionId }, origin);
      }
      return json(res, 200, { cancelled, sessionId, job: resumeJobFor(sessionId) }, origin);
    }

    const autoAllowed = automaticCompactionAllowed(await getSession(sessionId));
    if (!autoAllowed) {
      const pending = continuationForSession(sessionId);
      await cancelAutomaticResumesNow(sessionId);
      if (body['automatic'] === true || (pending?.automatic && body['ticket'] !== true)) {
        return json(res, 409, { error: 'automatic_compaction_disabled', sessionId }, origin);
      }
    }

    // File the ticket before the browser interrupts or settles anything. This endpoint does not hand out the prompt: a page that dies after this durable 202 leaves work to collect, while a page that survives must still pass the existing stop/tool barrier below and ask again. Automatic tickets also obey the current model and Infinite Astra policy.
    if (body['ticket'] === true) {
      let ticket: Awaited<ReturnType<typeof fileCompactionTicket>>;
      try {
        ticket = await fileCompactionTicket(sessionId, id, body['automatic'] === true);
      } catch (err) {
        logWarn(`bridge: could not durably file Compact & Resume for ${sessionId} — ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 503, { error: 'continuation_not_durable', retryable: true, sessionId }, origin);
      }
      const { opened, started } = ticket;
      return json(
        res,
        202,
        {
          started,
          filed: true,
          sessionId,
          token: opened.token,
          sourceSend: opened.sourceSend,
          prompt: null,
          job: resumeJobFor(sessionId)
        },
        origin
      );
    }

    // The page's capture, from its exact Fiber terminal. It says which output belongs to the compaction turn by quoting the token it was given when that turn was marked; binding the sent anchor may already have captured from the recorder (captureRecordedBrief). A brief for a continuation that has moved on is answered with what is already stored rather than written again — see attachSummary.
    if (typeof body['summary'] === 'string') {
      const token = typeof body['token'] === 'string' ? body['token'] : '';
      const entry = continuationByToken(token);
      if (!entry || entry.sessionId !== sessionId) return json(res, 409, { error: 'no_such_continuation' }, origin);
      const captured = await captureCompactionBrief(id, entry, body['summary'], known);
      return json(res, captured.status, captured.body, origin);
    }

    // Repeated presses share one transaction; once dispatch is armed, documents reconcile its durable marker and never submit again.
    if (await conversationWasSuperseded(id)) {
      return json(res, 409, { error: 'conversation_superseded' }, origin);
    }
    const already = continuationForSession(sessionId);
    if (already) {
      const prompt =
        already.state === 'awaiting-summary' && sendUnattempted(already.sourceSend)
          ? nativeHandoffPrompt(
              already.token,
              getConfig().goal.includeToolCalls === true,
              getConfig().compaction.handoffPrompt ?? DEFAULT_HANDOFF_PROMPT,
              getConfig().compaction.handoffLength
            )
          : null;
      return json(
        res,
        prompt ? 202 : 200,
        {
          started: false,
          sessionId,
          token: already.token,
          sourceSend: already.sourceSend,
          prompt,
          job: resumeJobFor(sessionId)
        },
        origin
      );
    }

    let opened;
    try {
      opened = await openContinuationNow(sessionId, id, false);
    } catch (err) {
      logWarn(`bridge: could not durably open Compact & Resume for ${sessionId} — ${err instanceof Error ? err.message : String(err)}`);
      return json(res, 503, { error: 'continuation_not_durable', retryable: true, sessionId }, origin);
    }
    // Remembered from the press, not from the queued chat: a transaction that fails before anything is queued still has to be reportable, or the page polls a button that says nothing about the compaction it just watched fail.
    rememberToken(sessionId, opened.token);
    changed();
    logInfo(`bridge: browser started Compact & Resume for ${sessionId} (${opened.token.slice(0, 8)})`);
    return json(
      res,
      202,
      {
        started: true,
        sessionId,
        token: opened.token,
        sourceSend: opened.sourceSend,
        // The prompt the page injects as the compaction turn. Its answer is the brief.
        prompt: nativeHandoffPrompt(
          opened.token,
          getConfig().goal.includeToolCalls === true,
          getConfig().compaction.handoffPrompt ?? DEFAULT_HANDOFF_PROMPT,
          getConfig().compaction.handoffLength
        ),
        job: resumeJobFor(sessionId)
      },
      origin
    );
  }
  return false;
}
