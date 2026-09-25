export type SessionControlsView = {
  sessionId: string;
  recovery?: import('../../../contracts/recovery.js').RecoveryCountdown[];
  plan: import('../../../contracts/agent-plan.js').AgentPlan | null;
  conversationId: string;
  automation: 'off' | 'goal' | 'loop';
  loopAfterTurn?: boolean;
  proLoopDelivery?: boolean;
  objective: string;
  activeTurnId: string | null;
  finishHeld: boolean;
  queueAtFinish?: boolean;
  canInject?: boolean;
  canSendDirectly?: boolean;
  finishWaiting?: boolean;
  stopPending?: boolean;
  goalDraft?: Pick<import('../automation/goal.js').GoalDraftView, 'stage' | 'model' | 'text' | 'error'> | null;
  goalWait?: import('../../../contracts/automation/goal-progress.js').GoalWait | null;
  finishGoalDraft?: Pick<import('../automation/goal.js').GoalDraftView, 'stage' | 'model' | 'text' | 'error'> | null;
  blocked: 'worker' | 'blocked' | '';
  job: ResumeJobView | null;
};
import type { ResumeJobView } from './bridge-resume-types.js';
import type { BridgeSessionControlsRuntime } from './bridge-session-controls-runtime.js';
import { createBridgeStopControls } from './bridge-stop-controls.js';

// Owns session-level Stop, Goal, Loop, and compaction controls.
type Runtime = BridgeSessionControlsRuntime;

export function createBridgeSessionControls(runtime: Runtime) {
  const {
    activeUntil,
    apiChatFlightTurnId,
    automaticCompactionAllowed,
    cancelResumeNow,
    getCommands,
    compactionPhaseOf,
    continuationForSession,
    forgetGoalWatch,
    getConfig,
    getSession,
    getSessionFinishDraft,
    goalArmedFor,
    goalKeyPresent,
    goalObjectiveFor,
    goalOutcomeFor,
    goalPendingReplyFor,
    goalSwitchFor,
    goalViewFor,
    goalWaitFor,
    isApiConversationId,
    isChatBlocked,
    isGoalDecisionChat,
    isWorkerConversation,
    liveConversations,
    loopAfterTurnFor,
    openContinuationNow,
    queueBrowserRecovery,
    readSessionPlan,
    rememberToken,
    resumeJobFor,
    retiredWorkerForConversation,
    revokeSilenceLoop,
    runningToolCalls,
    chatIsWorking,
    observationWritesInFlight,
    sessionActivityExpiresAt,
    sessionFinishHeld,
    sessionFinishWaiting,
    sessionInputActivity,
    sessionInputPolicy,
    sessionRecoveryCountdowns,
    setGoalObjectiveNow,
    setGoalReplyActiveNow,
    setGoalSwitchNow,
    supportsFinishAutomation,
    webProviderFlightTurnId,
    changed
  } = runtime;
  const conversationWasSuperseded = (conversationId: string): Promise<boolean> => runtime.conversationWasSuperseded(conversationId);
  // May the goal loop write the next message in this chat? The switch is one setting, but it is the *prime's* setting. A spawned worker already has an author for its user turns — the prime, through the agents tool — and its brief is the whole of the objective it was given. Letting the loop type into it too puts two hands on one wheel: the worker answers a question its prime never asked, finishes against that instead, and reports back work nobody ordered. Worse, every worker in a run would be spending OpenRouter credit in parallel on drafts the prime is about to override anyway. So: on for the prime, on for an ordinary solo chat that has never been a worker, and off for every active, dormant or explicitly retired worker, whatever the global switch says. Worker identity outlives the scarce active-run claim, so this check uses durable ownership/fences rather than treating `run === null` as proof that a chat is solo.
  function goalWorkerChat(id: string): boolean {
    // Membership in any state, not the owner lookup: a worker chat remains a worker forever — parked with its run, finished at the context ceiling, or retired after the run — and the loop must never author user turns in it, nor a Compact & Resume be typed into it. The owner lookup deliberately forgets a worker that is over, which is how two ceiling-finished workers were compacted like plain chats on 2026-09-03.
    return isGoalDecisionChat(id) || isWorkerConversation(id) || retiredWorkerForConversation(id) !== null;
  }

  // A worker belongs to its prime, and a blocked chat cannot safely run automated follow-up; the block keeps its goal settings but suspends their effect until access returns.
  function goalBlockReason(id: string): 'worker' | 'blocked' | '' {
    if (goalWorkerChat(id)) return 'worker';
    if (isChatBlocked(id)) return 'blocked';
    return '';
  }


  // Renderer authority is a durable session, never a caller-supplied browser identity.
  async function controlledConversation(sessionId: string): Promise<string> {
    const session = await getSession(sessionId);
    const id = session?.conversationId;
    if (!id) throw new Error('session_not_recorded');
    if (await conversationWasSuperseded(id)) throw new Error('conversation_superseded');
    if ((await getSession(sessionId))?.conversationId !== id) throw new Error('conversation_changed');
    return id;
  }
  async function sessionControlsFor(sessionId: string): Promise<SessionControlsView> {
    const id = await controlledConversation(sessionId);
    const control = goalSwitchFor(id);
    const blocked = goalBlockReason(id);
    const session = await getSession(sessionId);
    if (session?.conversationId !== id) throw new Error('conversation_changed');
    // A persisted start is history, not proof that the provider is still generating. Reuse the recorder's process-local observation (or an exact attributed running tool) so opening old recordings after restart cannot resurrect Stop/Working.
    const live = liveConversations().find(entry => entry.conversationId === id && entry.sessionId === sessionId);
    const activityExpiry = sessionActivityExpiresAt(session);
    const flightTurn = webProviderFlightTurnId(sessionId) ?? apiChatFlightTurnId(sessionId);
    const stopping = getCommands().some(c => c.spec.type === 'stop' && c.spec.sessionId === sessionId && c.spec.turnId === (session.activeTurnId ?? flightTurn));
    const activeTurnId = session.browserRecoveryDismissedAt === undefined && (session.activeTurnId || flightTurn) &&
      (stopping || runningToolCalls(id) > 0 || Boolean(flightTurn) ||
       (activityExpiry !== undefined ? activityExpiry !== null && activityExpiry > Date.now() :
        live?.activeTurnId === session.activeTurnId)) ? (flightTurn ?? session.activeTurnId ?? null) : null;
    const finishHeld = !blocked && await sessionFinishHeld(sessionId, activeTurnId, id);
    const draft = goalViewFor(id) ?? goalOutcomeFor(id);
    const inputPolicy = await sessionInputPolicy(sessionId, sessionInputActivity(session));
    const plan = await readSessionPlan(sessionId);
    const finishWaiting = await sessionFinishWaiting(sessionId, activeTurnId, id);
    const recovery = await sessionRecoveryCountdowns(sessionId, id);
    return { sessionId, plan, conversationId: id, activeTurnId, finishHeld,
      recovery,
      queueAtFinish: !blocked && inputPolicy.queueAtFinish, canInject: !blocked && inputPolicy.canInject,
      canSendDirectly: !blocked && !!inputPolicy.directTurn,
      finishGoalDraft: getSessionFinishDraft(sessionId, activeTurnId),
      finishWaiting,
      goalDraft: draft ? { stage: draft.stage, model: draft.model, text: draft.text.slice(-8000), error: draft.error } : null,
      goalWait: !blocked && !draft && goalActiveFor(id)
        ? await goalWaitFor(id, sessionId, Date.now(), session.browserRecoveryDismissedAt !== undefined) : null,
      stopPending: getCommands().some(c => c.spec.type === 'stop' && c.spec.sessionId === sessionId && c.spec.turnId === activeTurnId),
      objective: goalObjectiveFor(id),
      loopAfterTurn: control.afterTurn,
      proLoopDelivery: control.enabled && getConfig().ui.finishTool === true && session.selectedModel?.conversationId === id &&
        supportsFinishAutomation(control.mode, session.selectedModel.model, session.selectedModel.reasoningEffort),
      automation: goalArmedFor(id) && !blocked ? control.enabled ? control.mode : 'goal' : 'off',
      blocked, job: resumeJobFor(sessionId) };
  }
  // Switch activation cannot spend a live generation or silence-recovery window.
  function activateConversationGoalReply(id: string, active: boolean): Promise<boolean> {
    const grant = activeUntil.get(id);
    const idle = (silenceSourceTurnId?: string) => {
      const live = liveConversations().find(row => row.conversationId === id);
      return activeUntil.get(id) === grant && runningToolCalls(id) === 0 &&
        (!chatIsWorking(id) || (!!silenceSourceTurnId && live?.activeTurnId === silenceSourceTurnId)) &&
        observationWritesInFlight === 0 && (!grant || grant.until <= Date.now());
    };
    return setGoalReplyActiveNow(id, active, idle);
  }

  // Both UIs write the existing objective/switch/ticket authorities in the same order.
  async function saveConversationObjective(id: string, text: string, named: 'goal' | 'loop' | null,
    assertCurrent: () => Promise<void> = async () => undefined) {
    await assertCurrent();
    if (goalWorkerChat(id)) throw new Error('goal_worker_chat');
    if (text.trim() && await conversationWasSuperseded(id)) throw new Error('conversation_superseded');
    if (text.trim() && isChatBlocked(id)) throw new Error('chat_blocked');
    let chatSwitch: { enabled: boolean; mode: 'goal' | 'loop' } | null = null;
    if (named) {
      const held = goalSwitchFor(id);
      const on = text.trim().length > 0;
      const which = on ? named : held.enabled ? held.mode : named;
      await assertCurrent();
      try { chatSwitch = await setGoalSwitchNow(id, which, on); }
      catch { throw new Error('goal_switch_not_durable'); }
    }
    await assertCurrent();
    const objective = await setGoalObjectiveNow(id, text);
    await assertCurrent();
    try {
      await activateConversationGoalReply(id,
        goalActiveFor(id) && getConfig().sessions.record && await goalKeyPresent(goalModeFor(id)));
      forgetGoalWatch(id);
    } catch { throw new Error('goal_ticket_not_durable'); }
    changed();
    return { objective, ...(chatSwitch ? { enabled: chatSwitch.enabled, own: true, mode: chatSwitch.mode } : {}) };
  }
  async function setSessionObjective(sessionId: string, text: string, mode: 'goal' | 'loop'): Promise<SessionControlsView> {
    const id = await controlledConversation(sessionId);
    await saveConversationObjective(id, text, mode, async () => {
      if (await controlledConversation(sessionId) !== id) throw new Error('conversation_changed');
    });
    return sessionControlsFor(sessionId);
  }
  async function setSessionAutomation(sessionId: string, automation: SessionControlsView['automation'], afterTurn?: boolean): Promise<SessionControlsView> {
    const id = await controlledConversation(sessionId);
    if (automation !== 'off' && goalBlockReason(id)) throw new Error(goalWorkerChat(id) ? 'worker_goal_disabled' : 'chat_blocked');
    const mode = automation === 'off' ? goalSwitchFor(id).mode : automation;
    // The existing reply setter retires drafts and durably closes the pickup for Off.
    const held = await setGoalSwitchNow(id, mode, automation !== 'off', afterTurn);
    if (!loopAfterTurnFor(id) && goalPendingReplyFor(id)?.silencePro) await revokeSilenceLoop(id);
    const keyPresent = held.enabled && await goalKeyPresent(mode);
    if (await controlledConversation(sessionId) !== id) throw new Error('conversation_changed');
    const live = goalSwitchFor(id);
    await activateConversationGoalReply(id, held.enabled && live.enabled && live.mode === held.mode && !goalBlockReason(id)
      && getConfig().sessions.record && keyPresent);
    forgetGoalWatch(id);
    changed();
    return sessionControlsFor(sessionId);
  }
  // One ticket publication boundary shared by browser and app controls.
  async function fileCompactionTicket(sessionId: string, id: string, automatic = false) {
    if (await controlledConversation(sessionId) !== id) throw new Error('conversation_changed');
    if (isApiConversationId(id)) throw new Error('api_compaction_not_supported');
    if (goalWorkerChat(id)) throw new Error('worker_compaction_disabled');
    if (isChatBlocked(id)) throw new Error('chat_blocked');
    if (automatic && !automaticCompactionAllowed(await getSession(sessionId))) throw new Error('automatic_compaction_disabled');
    const existing = continuationForSession(sessionId);
    const opened = existing ?? await openContinuationNow(sessionId, id, automatic);
    rememberToken(sessionId, opened.token);
    changed();
    return { opened, started: !existing };
  }
  async function compactSession(sessionId: string): Promise<SessionControlsView> {
    const { opened } = await fileCompactionTicket(sessionId, await controlledConversation(sessionId));
    if (opened.state === 'awaiting-summary') {
      // The companion owns exact-tab discovery/opening even when Chrome is already running. A cold process start alone cannot deliver a manual desktop request.
      queueBrowserRecovery(opened.from, sessionId,
        `compaction:${opened.token}:${compactionPhaseOf(opened)}:manual`, 'compaction');
    }
    return sessionControlsFor(sessionId);
  }
  async function cancelSessionCompaction(sessionId: string): Promise<SessionControlsView> {
    await controlledConversation(sessionId);
    await cancelResumeNow(sessionId);
    changed();
    return sessionControlsFor(sessionId);
  }

  // A chat the loop may not drive — by role, or by the user's block.
  function goalFencedChat(id: string): boolean {
    return goalBlockReason(id) !== '';
  }

  function goalEnabledFor(id: string): boolean {
    if (goalFencedChat(id)) return false;
    return goalSwitchFor(id).enabled;
  }

  // Which of the two standing modes this chat's switch is in. Sent beside `enabled` rather than as a second boolean, because that is what makes the pair mutually exclusive everywhere they are drawn: one field with one value, so no page and no poll can ever paint both switches on. A chat where the loop may not act reports the mode it *would* run, which the page never draws — `enabled: false` already answered the question.
  function goalModeFor(id?: string): 'goal' | 'loop' {
    return id ? goalSwitchFor(id).mode : getConfig().goal.mode;
  }

  // A standing switch or this chat's own objective can continue unfinished work; Off disables both, and worker chats remain controlled by their prime.
  function goalActiveFor(id: string): boolean {
    if (goalFencedChat(id)) return false;
    return goalArmedFor(id);
  }

  const stopControls = createBridgeStopControls(runtime, { controlledConversation, sessionControlsFor, setSessionAutomation });

  // Policy gate only: the live silence grant files the outbox's exact recovery claim.
  function recoveryInputAllowed(sessionId: string, id: string): boolean {
    return (goalActiveFor(id) || getConfig().ui.autoContinue !== false) && !goalFencedChat(id) &&
      !isChatBlocked(id) && !stopControls.stopRequestedFor(id) && !continuationForSession(sessionId);
  }

  return {
    activateConversationGoalReply,
    cancelSessionCompaction,
    compactSession,
    fileCompactionTicket,
    goalActiveFor,
    goalBlockReason,
    goalEnabledFor,
    goalFencedChat,
    goalModeFor,
    goalWorkerChat,
    ...stopControls,
    recoveryInputAllowed,
    saveConversationObjective,
    sessionControlsFor,
    setSessionAutomation,
    setSessionObjective,
  };
}
