import http from 'node:http';
import type { bridgeAutomationRouteRuntime } from './bridge.js';

// Handles Goal drafting and browser-owned automation settings.
type Runtime = typeof bridgeAutomationRouteRuntime;

export async function handleBridgeGoalDraftRoute(
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string | null,
  runtime: Runtime
): Promise<boolean> {
  const {
    acceptGoalReplyNow,
    astraFinishOnly,
    beginGoalDraft,
    changed,
    chatStillWorking,
    claimGoalRecoveryStopNow,
    conversationId,
    conversationWasSuperseded,
    continuationForSession,
    deferSilenceGoalReplyNow,
    discardPreparedGoalDraft,
    extendedSilenceWindowFor,
    findSessionByConversation,
    goalActiveFor,
    goalInputPriority,
    goalKeyPresent,
    goalModeFor,
    goalPendingReplyFor,
    goalViewFor,
    isChatBlocked,
    liveConversations,
    loopReplyHasAuthority,
    logWarn,
    notePickupActivity,
    readBody,
    readCompletedFinal,
    recoveryBusyMs,
    runningToolCalls,
    silenceContinuationAllowed,
    startGoalDraft,
    stopRequestedFor,
    suppressProSilence
  } = runtime;
  const json = (...args: Parameters<Runtime['json']>): true => {
    runtime.json(...args);
    return true;
  };
  const goalJson = (...args: Parameters<Runtime['goalJson']>): true => {
    runtime.goalJson(...args);
    return true;
  };
  const tooLarge = (...args: Parameters<Runtime['tooLarge']>): true => {
    runtime.tooLarge(...args);
    return true;
  };

  // The page requests one draft after confirming completion; the turn ID makes retries idempotent.
  if (route === '/goal/draft' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return goalJson(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    const turnId = typeof body['turnId'] === 'string' ? body['turnId'].slice(0, 200) : '';
    const terminalRequired = body['terminalRequired'] === true;
    // A draft request proves the page is alive, so extend its pickup deadline unless generation is still active.
    if (id && body['nativeBusy'] !== true) notePickupActivity(id);
    const clientId = typeof body['clientId'] === 'string' ? body['clientId'].slice(0, 100) : '';
    if (!id) return goalJson(res, 400, { error: 'bad_conversation_id' }, origin);
    if (!turnId) return goalJson(res, 400, { error: 'bad_turn_id' }, origin);
    const astraSession = await findSessionByConversation(id, { requireUnique: true });
    if (astraSession && await astraFinishOnly(astraSession.id, id)) return goalJson(res, 409, { error: 'astra_finish_only', retryable: false }, origin);
    if (turnId.startsWith('g-silence-') && goalPendingReplyFor(id)?.turnId !== turnId) {
      return goalJson(res, 409, { error: 'goal_reply_not_pending', retryable: false }, origin);
    }
    if ((turnId.startsWith('g-silence-') && !await silenceContinuationAllowed(id)) || await suppressProSilence(id)) {
      return goalJson(res, 409, { error: 'goal_final_not_confirmed', retryable: false }, origin);
    }
    if (await conversationWasSuperseded(id)) {
      return goalJson(res, 409, { error: 'conversation_superseded' }, origin);
    }
    if (
      terminalRequired &&
      goalPendingReplyFor(id)?.turnId !== turnId &&
      goalViewFor(id, clientId)?.turnId !== turnId
    ) {
      return goalJson(res, 409, { error: 'goal_reply_not_pending', retryable: true }, origin);
    }
    // Recheck key availability because settings may change after the page's last poll.
    if (!goalActiveFor(id)) return goalJson(res, 409, { error: 'goal_disabled' }, origin);
    if (!(await goalKeyPresent(goalModeFor(id)))) return goalJson(res, 409, { error: 'no_api_key' }, origin);
    const live = liveConversations().find((entry) => entry.conversationId === id);
    const known = live ? null : await findSessionByConversation(id, { requireUnique: true });
    const sessionId = live?.sessionId ?? known?.id ?? null;
    if (!sessionId) {
      return json(
        res,
        409,
        { error: 'session_not_recorded', message: 'This chat has no recorded local session to continue from.' },
        origin
      );
    }
    if (await goalInputPriority(id, sessionId, turnId))
      return goalJson(res, 409, { error: 'user_input_pending', retryable: true }, origin);
    if (body['nativeBusy'] === true) {
      const pro = await extendedSilenceWindowFor(id, sessionId);
      const pending = goalPendingReplyFor(id);
      const final = await readCompletedFinal(sessionId, id, turnId);
      const current = () => goalPendingReplyFor(id)?.replyId === pending?.replyId &&
        goalPendingReplyFor(id)?.acceptedAt === pending?.acceptedAt && goalActiveFor(id) &&
        !isChatBlocked(id) && !stopRequestedFor(id) && runningToolCalls(id) === 0 && !continuationForSession(sessionId);
      if (!pending || pending.turnId !== turnId || !final || !await loopReplyHasAuthority(sessionId, id, turnId) || !current())
        return goalJson(res, 409, { error: 'goal_final_not_confirmed', retryable: false }, origin);
      if (!pending.listenUntil) {
        await deferSilenceGoalReplyNow(id, turnId, Date.now() + recoveryBusyMs(pro));
        changed();
      }
      const stop = current() && await claimGoalRecoveryStopNow(id, pending.replyId, pending.acceptedAt) &&
        !!await readCompletedFinal(sessionId, id, turnId) && current();
      return goalJson(res, 200, { recovery: { stop, listenUntil: goalPendingReplyFor(id)?.listenUntil } }, origin);
    }
    if (await chatStillWorking(id, turnId, sessionId)) {
      // An unfinished turn belongs to Continue. Only canonical completion files an automatic Goal/Loop obligation; a page request cannot invent one.
      return json(
        res,
        409,
        { error: 'chat_still_working', retryable: true, message: 'This chat is still working on its answer; the app will draft once it has finished.' },
        origin
      );
    }
    let draft;
    try {
      // Reserve the browser owner before provider work so duplicate tabs cannot start the same draft.
      draft = startGoalDraft({
        sessionId,
        conversationId: id,
        turnId,
        clientId,
        deferStart: true
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'goal_owned_elsewhere') {
        return json(
          res,
          409,
          {
            error: 'goal_owned_elsewhere',
            message: 'Another tab is already handling Goal Mode for this chat.'
          },
          origin
        );
      }
      throw err;
    }
    // This completed provider turn now owes one durable Goal decision; retries may discard attempts but not the obligation.
    try {
      await acceptGoalReplyNow({
        conversationId: id,
        sessionId,
        replyId: `turn:${turnId}`.slice(0, 200),
        turnId,
        eventSeq: 0,
        blocked: false
      });
    } catch (err) {
      discardPreparedGoalDraft(id, draft.token);
      logWarn(`bridge: Goal turn ${turnId} for ${id} is not durable yet — ${err instanceof Error ? err.message : String(err)}`);
      return goalJson(res, 503, { error: 'goal_reply_not_durable', retryable: true }, origin);
    }
    if (await goalInputPriority(id, sessionId, turnId)) {
      discardPreparedGoalDraft(id, draft.token);
      return goalJson(res, 409, { error: 'user_input_pending', retryable: true }, origin);
    }
    const pendingBeforeAuthority = goalPendingReplyFor(id);
    if (pendingBeforeAuthority && pendingBeforeAuthority.turnId !== turnId) {
      discardPreparedGoalDraft(id, draft.token);
      return goalJson(res, 409, { error: 'goal_reply_not_pending', retryable: false }, origin);
    }
    const hasAuthority = await loopReplyHasAuthority(sessionId, id, turnId);
    const pendingAfterAuthority = goalPendingReplyFor(id);
    if (pendingAfterAuthority?.turnId !== pendingBeforeAuthority?.turnId ||
        pendingAfterAuthority?.replyId !== pendingBeforeAuthority?.replyId ||
        pendingAfterAuthority?.acceptedAt !== pendingBeforeAuthority?.acceptedAt) {
      discardPreparedGoalDraft(id, draft.token);
      return goalJson(res, 409, { error: 'goal_reply_not_pending', retryable: false }, origin);
    }
    // A no-MCP automatic row is deliberately handled, so absence alone must not replace its useful refusal with the generic pending-reply error.
    if (!hasAuthority) {
      discardPreparedGoalDraft(id, draft.token);
      return goalJson(res, 409, { error: 'loop_mcp_call_missing', retryable: false }, origin);
    }
    if (pendingAfterAuthority?.turnId !== turnId) {
      discardPreparedGoalDraft(id, draft.token);
      return goalJson(res, 409, { error: 'goal_reply_not_pending', retryable: false }, origin);
    }
    beginGoalDraft(id, draft.token);
    return goalJson(res, 200, { goal: draft, sessionId }, origin);
  }
  return false;
}

export async function handleBridgeSettingsRoutes(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, runtime: Runtime): Promise<boolean> {
  const { activateConversationGoalReply, applyGoalSwitch, cancelAutomaticResumesNow, changed, contextView, conversationId, conversationWasSuperseded, findSessionByConversation, forgetGoalWatch, getConfig, goalKeyPresent, goalModeFor, goalProgressFor, goalSwitchFor, goalWorkerChat, isChatBlocked, logInfo, logWarn, readBody, retireGoalDrafts, setGoalSwitchNow, setSessionAutomation, updateConfig } = runtime;
  const json = (...args: Parameters<Runtime['json']>): true => { runtime.json(...args); return true; };
  const tooLarge = (...args: Parameters<Runtime['tooLarge']>): true => { runtime.tooLarge(...args); return true; };

  // Browser settings expose only the supported chat automation controls and output preferences. Settings can be read before a new conversation has an ID.
  if (route === '/settings' && req.method === 'GET') {
    return json(
      res,
      200,
      {
        context: contextView(),
        followOutput: getConfig().ui.followOutput !== false,
        mentionCore: getConfig().ui.mentionCore !== false,
        goal: {
          enabled: getConfig().goal.enabled,
          // The app-wide setting is nobody's own answer, by definition: it is what a chat that has never said anything inherits.
          own: false,
          mode: goalModeFor(),
          ...goalProgressFor(goalModeFor()),
          hasKey: await goalKeyPresent(),
          objective: '',
          blocked: ''
        }
      },
      origin
    );
  }

  if (route === '/settings' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const auto = typeof body['autoCompact'] === 'boolean' ? (body['autoCompact'] as boolean) : null;
    const goal = typeof body['goal'] === 'boolean' ? (body['goal'] as boolean) : null;
    const loop = typeof body['loop'] === 'boolean' ? (body['loop'] as boolean) : null;
    const settingsConversation = conversationId(body['conversationId']);
    if (typeof body['loopAfterTurn'] === 'boolean') {
      if (!settingsConversation || auto !== null || goal !== null || loop !== null) return json(res, 400, { error: 'bad_loop_delivery' }, origin);
      const session = await findSessionByConversation(settingsConversation, { requireUnique: true });
      if (!session) return json(res, 409, { error: 'session_not_recorded' }, origin);
      const control = goalSwitchFor(settingsConversation);
      await setSessionAutomation(session.id, control.enabled ? control.mode : 'off', body['loopAfterTurn']);
      return json(res, 200, { goal: { afterTurn: goalSwitchFor(settingsConversation).afterTurn } }, origin);
    }
    // One switch per request. Goal and Loop are one setting drawn as two controls, so a body carrying both is a page describing a state that does not exist rather than a change.
    if (goal !== null && loop !== null) return json(res, 400, { error: 'goal_and_loop_exclusive' }, origin);
    if (auto === null && goal === null && loop === null) {
      return json(res, 400, { error: 'nothing_to_change' }, origin);
    }
    if (
      settingsConversation &&
      (auto === true || goal === true || loop === true) &&
      (await conversationWasSuperseded(settingsConversation))
    ) {
      return json(res, 409, { error: 'conversation_superseded' }, origin);
    }
    // Turning anything *on* from a blocked chat's composer is refused; turning it off is still the user's to do. The block itself is lifted in the app, not here.
    if (
      settingsConversation &&
      (auto === true || goal === true || loop === true) &&
      isChatBlocked(settingsConversation)
    ) {
      return json(
        res,
        409,
        {
          error: 'chat_blocked',
          message: 'This chat is blocked in the app. Release it there before turning Goal, Loop or auto-compaction on.'
        },
        origin
      );
    }
    if (auto !== null && settingsConversation && goalWorkerChat(settingsConversation)) {
      return json(
        res,
        409,
        {
          error: 'worker_compaction_disabled',
          message: 'Worker chats never auto-compact and cannot change Compact & Resume from their composer.'
        },
        origin
      );
    }
    const which = goal !== null ? 'goal' : loop !== null ? 'loop' : null;
    // Which switch this request is actually turning. A composer always knows its own chat, so a switch it sends is that chat's: the sheet is drawn beside one conversation and the person flipping it is answering about that conversation, not about every chat they have ever opened. Only a New Chat — no id yet, nothing to store an override against — still moves the app-wide setting, which is exactly where it should be set: it is the default every chat with no answer of its own inherits.
    const scoped = which !== null && settingsConversation !== null;
    // Read inside the queued update rather than before it, so a settings change racing this one cannot leave the comparison below looking at a config neither request ever wrote.
    let driving: 'goal' | 'loop' | null = null;
    const before = scoped
      ? (() => {
          const held = goalSwitchFor(settingsConversation as string);
          return held.enabled ? held.mode : null;
        })()
      : null;
    const next = await updateConfig((config) => {
      driving = config.goal.enabled ? config.goal.mode : null;
      return {
        ...config,
        compaction: auto === null ? config.compaction : { ...config.compaction, auto },
        goal: scoped ? config.goal : applyGoalSwitch(config.goal, which, goal ?? loop)
      };
    });
    const chatSwitch = scoped
      ? await setGoalSwitchNow(settingsConversation as string, which as 'goal' | 'loop', (goal ?? loop) as boolean)
      : null;
    if (auto === false) {
      try {
        await cancelAutomaticResumesNow();
      } catch (err) {
        logWarn(`bridge: Auto Off could not durably cancel its compaction ticket(s) — ${err instanceof Error ? err.message : String(err)}`);
        return json(res, 503, { error: 'auto_compaction_cancel_not_durable', retryable: true }, origin);
      }
    }
    // Every change that takes authority away from work already in flight, not only switching off: a draft started as a gate must not be typed after the user asked for a loop, and a loop draft must not be typed after the user asked for a gate. Both are the same fact — the instruction this request was made under is no longer the one in force. A chat-scoped change retires that chat's draft and nobody else's, because nobody else's instruction moved.
    if (chatSwitch) {
      // `chatSwitch.mode === which` also covers retrying the same POST after the ticket write failed but the separate switch file landed. The second request must repair the ticket instead of deciding there is no transition left to perform.
      if (before !== (chatSwitch.enabled ? chatSwitch.mode : null) || chatSwitch.mode === which) {
        const chatId = settingsConversation as string;
        try {
          // The switch and the ticket are one user decision. Off durably closes the pickup; On (including Goal <-> Loop) re-arms the latest stable final under the new mode.
          await activateConversationGoalReply(
            chatId,
            chatSwitch.enabled && getConfig().sessions.record && (await goalKeyPresent(chatSwitch.mode))
          );
          forgetGoalWatch(chatId);
        } catch (err) {
          logWarn(`bridge: Goal ticket for ${chatId} did not follow its switch — ${err instanceof Error ? err.message : String(err)}`);
          return json(res, 503, { error: 'goal_ticket_not_durable', retryable: true }, origin);
        }
      }
    } else if (driving !== (next.goal.enabled ? next.goal.mode : null)) {
      retireGoalDrafts(!next.goal.enabled);
    }
    // The app's own settings screen is showing these two switches as well.
    changed();
    logInfo(
      `bridge: browser set ${[
        auto === null ? '' : `automatic compaction ${auto ? 'on' : 'off'}`,
        goal === null ? '' : `Goal ${goal ? 'on' : 'off'}`,
        loop === null ? '' : `Loop ${loop ? 'on' : 'off'}`
      ]
        .filter(Boolean)
        .join(' and ')}${scoped ? ` for chat ${settingsConversation}` : ''}`
    );
    return json(
      res,
      200,
      {
        context: contextView(),
        goal: {
          // What this chat's switch now says, which is the only answer its composer can draw.
          enabled: chatSwitch ? chatSwitch.enabled : next.goal.enabled,
          // A chat-scoped write is this chat answering for itself, and the sheet must draw that on the same frame — the next poll is a second away and the Off it just chose would read as an inherited one until then.
          own: chatSwitch !== null,
          mode: chatSwitch ? chatSwitch.mode : next.goal.mode,
          ...goalProgressFor(chatSwitch ? chatSwitch.mode : next.goal.mode),
          hasKey: await goalKeyPresent(chatSwitch ? chatSwitch.mode : next.goal.mode)
        }
      },
      origin
    );
  }
  return false;
}
