import http from 'node:http';
import { activityDisplayOutcome, activityDurationMs, activityStoredPreview, MAX_ACTIVITY_CALL_ID_CHARS } from '../sessions/history/activity-preview.js';
import { agentInfoForOwnedConversation, notePageGenerating, retiredWorkerForConversation } from '../automation/agents.js';
import { astraFinishOnly, goalKeyPresent, goalObjectiveFor, goalPendingReplyFor, goalProgressFor, goalSwitchFor, goalViewFor, loopAfterTurnFor, loopReplyHasAuthority } from '../automation/goal.js';
import { automaticCompactionAllowed, conversationWasSuperseded, findSessionByConversation, getSession, readActivityEvents, readHydratedActivityCall } from '../sessions/history/store.js';
import { continuationMarkerOf, toolCallSummary, unescapeMarkdown, type SessionEvent } from '../../../contracts/session.js';
import { conversationId } from './companion-payload.js';
import { conversationProgress } from '../sessions/history/progress.js';
import { injectedUserMessage } from '../../../contracts/chronology.js';
import { liveConversations, restoreRecordedConversation } from '../sessions/history/recorder.js';
import { logWarn } from '../../infrastructure/settings/logger.js';
import { runningToolCalls, settlingToolCalls } from '../../infrastructure/tool-gateway/protocol/call-context.js';
import { repairPrimeFromResumeShadow, continuationByToken } from '../sessions/continuity/continuation.js';
import { sessionActivityExpiresAt } from './session-activity.js';
import { supportsFinishAutomation } from '../../../contracts/automation/completion-policy.js';
import { userPromptText } from '../../../contracts/messaging/provider-message-envelope.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import type { bridgeActivityRouteRuntime } from './bridge.js';

// Serves browser activity snapshots and reconciles them with durable sessions.
type Runtime = typeof bridgeActivityRouteRuntime;

export async function handleBridgeActivityRoutes(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, url: URL, receivedAt: number, runtime: Runtime): Promise<boolean> {
  const respond = (response: http.ServerResponse, status: number, body: unknown, responseOrigin: string | null) => {
    runtime.json(response, status, body, responseOrigin);
    return true as const;
  };
  const respondTooLarge = (response: http.ServerResponse, responseOrigin: string | null) => {
    runtime.tooLarge(response, responseOrigin);
    return true as const;
  };
  if (route === '/activity/detail' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await runtime.readBody(req);
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return respondTooLarge(res, origin);
      return respond(res, 400, { error: 'bad_request' }, origin);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return respond(res, 400, { error: 'bad_request' }, origin);
    const fields = body as Record<string, unknown>;
    if (Object.keys(fields).some(key => !['conversationId', 'callId', 'detailRevision'].includes(key))) {
      return respond(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(fields.conversationId);
    const callId = typeof fields.callId === 'string' && fields.callId.length > 0 &&
      fields.callId.length <= MAX_ACTIVITY_CALL_ID_CHARS ? fields.callId : null;
    const detailRevision = typeof fields.detailRevision === 'number' && Number.isSafeInteger(fields.detailRevision) &&
      fields.detailRevision > 0 ? fields.detailRevision : null;
    if (!id || !callId || detailRevision === null) return respond(res, 400, { error: 'bad_request' }, origin);

    const owner = await findSessionByConversation(id, { requireUnique: true });
    const event = owner ? await readHydratedActivityCall(owner.id, id, callId, detailRevision) : null;
    if (!event) return respond(res, 200, { ok: false, error: 'call_not_available' }, origin);
    return respond(res, 200, {
      ok: true,
      conversationId: id,
      callId,
      detailRevision,
      tool: event.call.tool.slice(0, 160),
      outcome: activityDisplayOutcome(event.call),
      durationMs: activityDurationMs(event.call),
      args: activityStoredPreview(event.call.args),
      result: activityStoredPreview(event.call.result, true)
    }, origin);
  }

  // The ordinary activity feed contains only summaries of calls this app made — never the argument/result previews exposed by the explicit one-call disclosure route above.
  if (route === '/activity') {
    const id = conversationId(url.searchParams.get('conversationId'));
    const since = Number(url.searchParams.get('since') ?? 0);
    const goalClient = (url.searchParams.get('goalClient') ?? '').slice(0, 100);
    if (!id) return respond(res, 400, { error: 'bad_conversation_id' }, origin);
    // A page asking about this chat is the one thing that disproves the no-page verdict, and it is the only thing that lifts it.
    runtime.pagelessChats.delete(id);
    runtime.noteFiberHealth(id, url.searchParams.get('fiber'));
    // Older extensions omit it; they keep the plain three-minute silence rule.
    const pageGenerating = url.searchParams.get('generating');
    if (pageGenerating === '1' || pageGenerating === '0') notePageGenerating(id, pageGenerating === '1');
    const retiredWorker = retiredWorkerForConversation(id);
    const superseded = await conversationWasSuperseded(id);
    const astraSession = await findSessionByConversation(id, { requireUnique: true });
    const finishOnly = !!astraSession && await astraFinishOnly(astraSession.id, id);
    const silenceSuppressed = finishOnly || await runtime.suppressProSilence(id);
    const goalView = async () => {
      const hasKey = await goalKeyPresent(runtime.goalModeFor(id));
      let draft = superseded || silenceSuppressed ? null : goalViewFor(id, goalClient);
      if (draft && loopAfterTurnFor(id) && astraSession && await runtime.chatStillWorking(id, draft.turnId, astraSession.id)) draft = null;
      let pending = goalPendingReplyFor(id);
      const sourceTurn = pending?.turnId ?? draft?.turnId;
      if (sourceTurn && (!astraSession || !await loopReplyHasAuthority(astraSession.id, id, sourceTurn))) {
        pending = null;
        draft = null;
      }
      const queuePending = !!astraSession && !!await runtime.goalInputPriority(id, astraSession.id, pending?.turnId ?? draft?.turnId);
      if (queuePending) draft = null;
      const wait = !superseded && !silenceSuppressed && !queuePending && !draft && astraSession && runtime.goalActiveFor(id)
        ? await runtime.goalWaitFor(id, astraSession.id) : null;
      // Authority/history reads yield.
      const currentDraft = goalViewFor(id, goalClient);
      if (draft && (currentDraft?.token !== draft.token || currentDraft.stage !== draft.stage || currentDraft.reply !== draft.reply)) draft = null;
      const currentPending = goalPendingReplyFor(id);
      if (pending && (currentPending?.replyId !== pending.replyId || currentPending.turnId !== pending.turnId ||
          currentPending.acceptedAt !== pending.acceptedAt)) pending = null;
      return ({
      enabled: !superseded && !finishOnly && runtime.goalEnabledFor(id),
      configuredEnabled: !superseded && runtime.goalEnabledFor(id),
      afterTurn: loopAfterTurnFor(id),
      proLoopDelivery: runtime.goalEnabledFor(id) && getConfig().ui.finishTool === true && astraSession?.selectedModel?.conversationId === id &&
        supportsFinishAutomation(runtime.goalModeFor(id), astraSession.selectedModel.model, astraSession.selectedModel.reasoningEffort),
      // Has this chat answered for itself?
      own: superseded || finishOnly || runtime.goalFencedChat(id) || goalSwitchFor(id).own,
      mode: runtime.goalModeFor(id),
      ...goalProgressFor(runtime.goalModeFor(id), draft),
      hasKey,
      queuePending,
      wait,
      objective: superseded || runtime.goalWorkerChat(id) ? '' : goalObjectiveFor(id),
      blocked: superseded ? 'continued' : runtime.goalBlockReason(id),
      // This chat's own goal, and never a worker's: the loop is off there whatever is stored, and reporting one would let the page offer to drive a chat the prime owns.
      pending: superseded || runtime.goalFencedChat(id) || silenceSuppressed || queuePending ? null : pending,
      draft
    });
    };
    // Provider tabs poll this route for exact conversation presence.
    let live = liveConversations().find((entry) => entry.conversationId === id);
    if (!live || astraSession?.browserRecoveryDismissedAt !== undefined) {
      // An activity poll proves that the provider page is still open.
      await restoreRecordedConversation(id, receivedAt);
      live = liveConversations().find((entry) => entry.conversationId === id);
      if (live && astraSession?.browserRecoveryDismissedAt !== undefined)
        await runtime.restoreReturnedPageActivity(id, live.sessionId);
    }
    if (!live) {
      return respond(
        res,
        200,
        {
          sessionId: null,
          entries: [],
          stream: [],
          userAnchors: [],
          bootstrapMessageId: null,
          nextSince: Number.isFinite(since) ? Math.max(0, since) : 0,
          job: null,
          progress: conversationProgress(id),
          goal: await goalView(),
          ...(runtime.goalFencedChat(id) || superseded
            ? {
                // Worker conversations are never Compact & Resume sources.
                context: runtime.contextView(false)
              }
            : {}),
          ...(retiredWorker ? { retiredWorker } : {})
        },
        origin
      );
    }
    // Old builds could let the recorder create replacement chat B before the resume ACK moved A's durable projections.
    if (!runtime.goalWorkerChat(id) && !goalObjectiveFor(id)) {
      try {
        await repairPrimeFromResumeShadow(id);
      } catch (err) {
        // Presentation polling must stay available when a historical repair cannot be read.
        logWarn(`bridge: resume-shadow repair for ${id} failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const summary = await getSession(live.sessionId);
    const activityExpiry = summary ? sessionActivityExpiresAt(summary) : undefined;
    const hasActivityDeadline = activityExpiry !== undefined;
    const activityCurrent = runningToolCalls(id) > 0 || (activityExpiry !== null && activityExpiry !== undefined && activityExpiry > Date.now());
    // A worker this app put to sleep for silence has no turn to hand back.
    const sleptWorker = agentInfoForOwnedConversation(id);
    const sleptOverTurn = sleptWorker?.role === 'worker' &&
      (sleptWorker.state === 'sleeping' || sleptWorker.state === 'waking') &&
      sleptWorker.sleptAt !== null && live.activeTurnStartedAt !== null && live.activeTurnStartedAt <= sleptWorker.sleptAt;
    const pendingStop = !superseded && summary?.conversationId === id && summary.activeTurnId === live.activeTurnId && runtime.stopRequestedFor(id, live.activeTurnId)
      ? runtime.commands.find(command => command.spec.type === 'stop' && command.spec.sessionId === live!.sessionId && command.spec.turnId === live!.activeTurnId) : undefined;
    if (!automaticCompactionAllowed(summary)) await runtime.cancelAutomaticResumesNow(live.sessionId);
    // Worker chats and user-blocked chats alike: neither may auto-compact — see goalBlockReason.
    const workerBlocked = runtime.goalFencedChat(id);
    const requestedSince = Number.isFinite(since) ? Math.max(0, since) : 0;
    // A page reload begins at cursor zero.
    const { events, reset: resetActivity, resumeBoundary, openingUserMessage, resumeUserMessage } = await readActivityEvents(live.sessionId, requestedSince);
    let bootstrapMessageId: string | null = null;
    if (summary?.conversationId === id && summary.lastCommittedResumeHandoffId && resumeUserMessage?.messageId) {
      const token = continuationMarkerOf(resumeUserMessage.message.text)?.token;
      const receipt = token ? continuationByToken(token) : null;
      if (receipt?.state === 'committed' && receipt.sessionId === live.sessionId && receipt.to === id &&
          receipt.handoffId === summary.lastCommittedResumeHandoffId && receipt.destinationSend.state === 'sent' &&
          receipt.destinationSend.conversationId === id && receipt.destinationSend.messageId === resumeUserMessage.messageId) {
        bootstrapMessageId = resumeUserMessage.messageId;
      }
    } else if (summary?.conversationId === id && summary.origin?.kind === 'worker' && summary.origin.agentId && openingUserMessage?.messageId) {
      const original = openingUserMessage.message.text.trimStart();
      const authored = userPromptText(original) ?? original;
      // Decode page presentation before extracting its possibly escaped prompt frame.
      const asTyped = unescapeMarkdown(original);
      const authoredAsTyped = userPromptText(asTyped) ?? asTyped;
      const expected = runtime.bootstrapText({ type: 'worker', agent: summary.origin.agentId, task: summary.origin.task,
        model: null, reasoningEffort: null, runId: '' }, '');
      if (!openingUserMessage.message.truncated &&
          (authored === expected || authoredAsTyped === expected)) bootstrapMessageId = openingUserMessage.messageId;
    }
    // Where this conversation begins inside a session that has been compacted and resumed.
    const earlierChatRepair = (event: SessionEvent): boolean =>
      event.kind === 'progress' &&
      typeof event.progressId === 'string' &&
      event.progressId.startsWith('browser-repair:') &&
      (event.origin ?? event.seq) < resumeBoundary;
    // App-owned transcript feed.
    const stream = events.flatMap((event) => {
      if (earlierChatRepair(event)) return [];
      const base = { seq: event.seq, time: event.time, turnId: event.turnId ?? null, agent: event.agent ?? null,
        ...(event.turnOrigin !== undefined ? { turnOrigin: event.turnOrigin } : {}),
        ...(event.authoredAt !== undefined ? { authoredAt: event.authoredAt } : {}) };
      switch (event.kind) {
        case 'tool_call':
          return [{ ...base, seq: event.origin ?? event.seq, kind: 'tool_call', tool: event.call.tool, callId: event.call.callId,
            detailRevision: event.seq,
            process: event.call.process,
            requestId: event.call.requestId ?? null,
            attribution: event.call.attribution, outcome: event.call.outcome,
            displayOutcome: activityDisplayOutcome(event.call), durationMs: activityDurationMs(event.call),
            summary: toolCallSummary(event.call), changes: event.call.changes ?? [] }];
        case 'progress':
          // One caption, at the position it first appeared.
          return [
            {
              ...base,
              seq: event.origin ?? event.seq,
              kind: 'progress',
              text: event.message.text,
              progressId: event.progressId ?? null
            }
          ];
        case 'page_tool':
          // Provider pages may revise a step label; retain the first sequence so the update replaces the same event.
          return [
            {
              ...base,
              seq: event.origin ?? event.seq,
              kind: 'page_tool',
              label: event.label,
              messageId: event.messageId
            }
          ];
        case 'assistant_message':
          return [
            {
              ...base,
              kind: 'assistant_message',
              text: event.message.text,
              state: event.state ?? (event.final ? 'final' : 'streaming'),
              final: event.final,
              messageId: event.messageId ?? null,
              providerMessageId: event.providerMessageId ?? null,
              origin: event.origin ?? event.seq
            }
          ];
        case 'agent_message':
          return [
            {
              ...base,
              kind: 'agent_message',
              from: event.from,
              to: event.to,
              text: event.message.text,
              delivery: event.delivery,
              messageId: event.messageId
            }
          ];
        case 'chat_error':
          return [{ ...base, kind: 'chat_error', text: event.message.text }];
        case 'turn_start':
          return [{ ...base, kind: 'turn_start' }];
        case 'turn_end':
          return [
            {
              ...base,
              kind: 'turn_end',
              outcome: event.outcome,
              detail: event.detail ?? ''
            }
          ];
        default:
          return [];
      }
    });
    // Stable page-authored boundaries for presentation reconciliation.
    const userAnchors = events.flatMap((event) =>
      event.kind === 'user_message' && event.messageId && !injectedUserMessage(event, summary?.timelineTurns)
        ? [
            {
              seq: event.origin ?? event.seq,
              time: event.time,
              messageId: event.messageId
            }
          ]
        : []
    );

    // Legacy tool-only view, kept only while the old native-row relabeller is still a fallback.
    const nextSince = events.reduce((next, event) => Math.max(next, event.seq + 1), requestedSince);

    const entries = events.flatMap((event) =>
      event.kind === 'tool_call'
        ? [
            {
              seq: event.origin ?? event.seq,
              time: event.time,
              tool: event.call.tool,
              callId: event.call.callId,
              detailRevision: event.seq,
              turnId: event.turnId ?? null,
              // The extension matches its DOM blocks against this, and refuses to relabel anything when it is missing.
              requestId: event.call.requestId ?? null,
              attribution: event.call.attribution,
              outcome: event.call.outcome,
              displayOutcome: activityDisplayOutcome(event.call),
              durationMs: activityDurationMs(event.call),
              summary: toolCallSummary(event.call),
              changes: event.call.changes ?? [],
              // Raw arguments stay in the local session store; browser rendering needs only the summary.


              agent: event.agent ?? null
            }
          ]
        : []
    );
    return respond(
      res,
      200,
      {
        sessionId: live.sessionId,
        generating: hasActivityDeadline ? activityCurrent && live.generating : live.generating,
        tokens: summary?.contextTokens ?? 0,
        context: runtime.contextView(!workerBlocked && !superseded && automaticCompactionAllowed(summary)),
        // What the *currently attached* chat is carrying, not what the local session has accumulated over its whole life.
        followOutput: getConfig().ui.followOutput !== false,
        mentionCore: getConfig().ui.mentionCore !== false,
        // This chat was opened by the app, so its first user message is not the user's — it is the handoff brief or the worker bootstrap this app typed.
        bootstrap: summary?.conversationId === id && summary.lastCommittedResumeHandoffId
          ? 'resume' : summary?.origin?.kind ?? null,
        // Which worker this chat is, for the page's fold of the bootstrap.
        bootstrapAgent: summary?.origin?.kind === 'worker' ? summary.origin.agentId ?? null : null,
        bootstrapMessageId,
        entries,
        stream,
        userAnchors,
        resetActivity,
        truncatedFrom: resetActivity && events.length ? events.reduce((first, event) => Math.min(first, event.seq), Number.MAX_SAFE_INTEGER) : null,
        nextSince,
        job: runtime.resumeJobFor(live.sessionId),
        goal: await goalView(),
        // How this chat's own Compact & Resume is going, so the page can say what is happening instead of spinning.
        pendingTools: runningToolCalls(live.conversationId),
        settlingTools: settlingToolCalls(live.conversationId),
        progress: conversationProgress(live.conversationId),
        activeTurnId: sleptOverTurn || (hasActivityDeadline && !activityCurrent && !pendingStop) ? null : live.activeTurnId ?? null,
        // Diagnostic only.
        recordedTurnId: sleptOverTurn ? null : live.activeTurnId ?? null,
        recordedQuestionId: live.activeTurnId && !sleptOverTurn ? summary?.timelineTurns?.[live.activeTurnId]?.questionId ?? null : null,
        // The question whose turn this app has already ended, while nothing is running.
        settledQuestionId: live.activeTurnId ? null : runtime.settledQuestionOf(summary?.timelineTurns),
        ...(pendingStop?.spec.type === 'stop' ? { stopTurn: { turnId: pendingStop.spec.turnId, userMessageId: pendingStop.spec.userMessageId ?? null } } : {}),
        // A revival names an existing worker conversation.
        revival: runtime.pendingBrowserRevival(),
        revivals: runtime.pendingBrowserRevivals(),
        placement: runtime.pendingBrowserPlacement(id),
        // Recovery only.
        ...(retiredWorker ? { retiredWorker } : {})
      },
      origin
    );
  }

  // Compact and Resume requests are handled by the next route.

  return false;
}
