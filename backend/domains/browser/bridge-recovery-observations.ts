import { isDeliberateEffort, isProModel } from '../../../contracts/model-capabilities.js';
import { recoveryBusyMs } from '../../../contracts/recovery.js';
import { CHAT_SILENCE_MS } from '../../../contracts/session.js';
import type { ChatObservation } from '../sessions/history/recorder.js';
import type { ActivityGrant } from './session-activity.js';
import type { bridgeRecoveryObservationRuntime } from './bridge.js';

type Runtime = typeof bridgeRecoveryObservationRuntime;

// Applies one accepted observation batch to the recovery episode, after it is durable.
export async function noteRecoveryObservations(
  runtime: Runtime,
  conversationId: string,
  sessionId: string | null,
  observations: readonly ChatObservation[],
  activity: { meaningful: boolean; working: boolean; terminal: boolean; at?: number; endedTurnId?: string }
): Promise<void> {
  const {
    activeUntil,
    armSilenceSweep,
    assistantRepairSource,
    considerAutomaticCompaction,
    deferSilenceGoalReplyNow,
    endActivity,
    expediteCompactionPickup,
    failedTurnQuiet,
    fileSilenceInputTicket,
    getSession,
    goalActiveFor,
    goalPendingReplyFor,
    grantActivity,
    hasQueuedAfterTurnInput,
    inspectSilentChats,
    lastBrowserRecoveryAt,
    liveConversations,
    logInfo,
    loopAfterTurnFor,
    notePickupActivity,
    noteRecoveryActivity,
    pendingContinuations,
    queueBrowserRecovery,
    readCompletedFinal,
    readRecentEvents,
    recoveryInputAllowed,
    repairsInFlight,
    revokeSilenceInputs,
    revokeSilenceLoop,
    silenceWindowMs,
    turnHasMcpCall
  } = runtime;
  const accessLimit = (item: ChatObservation): boolean => item.kind === 'chat_error' &&
    (item.blocking === true ||
      /^too many requests\b.*temporarily limited.*access.*few minutes/i.test((item.text ?? '').replace(/\s+/g, ' ')));
  // The recorder owns idempotency. Raw batches may contain a historical user row or turn_start beside a newly accepted title, so inferring activity from `stored > 0` re-armed completed chats on every recovery reload. Only the recorder's per-event acceptance verdict may move this clock. A just-authored opening row covers the narrow pre-turn_start fresh-chat window; replayed/history rows explicitly do not. The picker reports changes, not one selection per turn or transport batch. Reuse its recorded exact-chat selection and resolve late evidence without renewing the work clock or changing an already known turn's model.
  const recorded = sessionId ? await getSession(sessionId) : null;
  if (recorded?.browserRecoveryDismissedAt !== undefined) {
    // Departure already consumed the old activity. A late page batch cannot erase newer server-side work which arrived while its tab was closed.
    if (repairsInFlight.get(conversationId)?.state !== 'done') repairsInFlight.delete(conversationId);
    return;
  }
  const ended = observations.findLast(item => item.kind === 'turn_end');
  const thinkingFailed = ended?.outcome === 'failed' && ended.reason === 'thinking_failed' &&
    recorded?.lastTurnOutcome === 'failed' && !recorded.activeTurnId;
  // The replacement document can reveal the failure that the silence reload was already repairing. That same source has spent its reload; learning its outcome is not new work and must not restart the browser or its listening clock.
  const repaired = repairsInFlight.get(conversationId);
  const confirmedAt = lastBrowserRecoveryAt.get(conversationId);
  const sameFailedRepair = thinkingFailed && activity.terminal && ended.turnId &&
    repaired?.reason === 'silence' && repaired.sessionId === sessionId &&
    (repaired.silenceGrant?.turnId ?? repaired.progress?.turnId) === ended.turnId ? repaired : null;
  const selected = recorded?.selectedModel;
  const provenModel = selected?.conversationId === conversationId
    ? isProModel(selected.model, selected.reasoningEffort) ? 'pro' as const : 'other' as const
    : 'unknown' as const;
  const provenDeliberate: { deliberate?: true } =
    selected?.conversationId === conversationId && isDeliberateEffort(selected.reasoningEffort) ? { deliberate: true } : {};
  const unresolved = activeUntil.get(conversationId);
  if (!activity.terminal && unresolved?.model === 'unknown' && unresolved.sessionId === sessionId &&
      recorded?.conversationId === conversationId && (recorded.activeTurnId === unresolved.turnId || unresolved.thinkingFailed) && provenModel !== 'unknown') {
    unresolved.model = provenModel;
    if (provenDeliberate.deliberate) unresolved.deliberate = true;
    // Enrich identity, not activity. In particular, a replacement page's picker must not spend or restart the listening window of its acknowledged reload.
    if (!(repaired?.reason === 'silence' && repaired.state === 'done' && repaired.sessionId === sessionId)) {
      unresolved.until = unresolved.evidenceAt + silenceWindowMs(unresolved);
      armSilenceSweep();
    }
  }
  // Access-limit diagnostics are recorded history, not renewed work. Preserve both the existing deadline and repair/Goal pickup custody unless this batch proves work or a terminal boundary. A completed answer must still retire the repair it supersedes.
  if (activity.meaningful && (activity.working || activity.terminal)) {
    if (sessionId && activity.working && !activity.terminal) {
      // Withdraw reload authority before awaiting the serialized input owner.
      noteRecoveryActivity(conversationId);
      await revokeSilenceInputs(sessionId);
      await revokeSilenceLoop(conversationId);
    }
    if (!sameFailedRepair && (!activity.terminal || !observations.some(item => item.kind === 'turn_end' && item.outcome === 'stalled')))
      noteRecoveryActivity(conversationId);
    notePickupActivity(conversationId);
    // A current-turn interim can push an existing deadline; historical transcript/page rows never enter this verdict and therefore cannot keep a confirmed reload alive.
    if (sessionId && !activity.terminal && activity.working) {
      const liveTurn = liveConversations().find(entry => entry.conversationId === conversationId && entry.sessionId === sessionId)?.activeTurnId;
      const previous = activeUntil.get(conversationId);
      const [sourceBoundary] = !previous && !liveTurn && activity.working
        ? await readRecentEvents(sessionId, 1, { kinds: ['turn_start', 'turn_end'] }) : [];
      const workingTurn = liveTurn ?? (sourceBoundary?.kind === 'turn_end' &&
        ['stalled', 'failed', 'unknown'].includes(sourceBoundary.outcome) ? sourceBoundary.turnId : null);
      let selection: ChatObservation | undefined;
      let turn: Pick<ActivityGrant, 'turnId' | 'model' | 'deliberate'> | undefined = !previous && workingTurn
        ? { turnId: workingTurn, model: provenModel, ...provenDeliberate } : undefined;
      for (const item of observations) {
        if (item.kind === 'model_selection') selection = item;
        if (item.kind === 'turn_start' && item.turnId === liveTurn && previous?.turnId !== item.turnId) {
          turn = { turnId: item.turnId ?? null, model: selection?.kind === 'model_selection' && selection.model ?
            isProModel(selection.model, selection.reasoningEffort) ? 'pro' : 'other' : provenModel,
            ...(selection?.kind === 'model_selection' && selection.model
              ? isDeliberateEffort(selection.reasoningEffort) ? { deliberate: true as const } : {}
              : provenDeliberate) };
        }
        // A batch-local selection applies to its next start. Later starts reuse the retained session selection, just as separate transport batches do.
        if (item.kind === 'turn_start') selection = undefined;
      }
      grantActivity(conversationId, sessionId, Math.min(Date.now(), activity.at ?? Date.now()), CHAT_SILENCE_MS, turn);
    }
  }
  const lastEnd = ended?.outcome ?? null;
  let terminalGrant = activeUntil.get(conversationId);
  if (thinkingFailed && ended.turnId && sessionId && activity.terminal) {
    // Keep the exact work owner through an error observation, including a reload already handed to Chrome. Only genuine work can replace it and earn a new reload.
    const previous = terminalGrant?.sessionId === sessionId && terminalGrant.turnId === ended.turnId
      ? terminalGrant : sameFailedRepair?.silenceGrant;
    const [work] = previous ? [] : await readRecentEvents(sessionId, 1, {
      kinds: ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start']
    });
    terminalGrant = previous ?? { sessionId, turnId: ended.turnId, model: provenModel,
      evidenceAt: Math.min(Date.now(), work?.time ?? ended.time), until: 0 };
    terminalGrant.thinkingFailed = true;
    if (terminalGrant.model === 'unknown' && provenModel !== 'unknown') terminalGrant.model = provenModel;
    const confirmed = sameFailedRepair?.state === 'done' && repairsInFlight.get(conversationId) === sameFailedRepair && confirmedAt !== undefined;
    terminalGrant.until = confirmed
      ? confirmedAt + recoveryBusyMs(terminalGrant.model === 'pro')
      : terminalGrant.evidenceAt + silenceWindowMs(terminalGrant);
    activeUntil.set(conversationId, terminalGrant);
    if (confirmed) {
      const pending = goalPendingReplyFor(conversationId);
      if (pending?.silenceSourceTurnId === ended.turnId)
        await deferSilenceGoalReplyNow(conversationId, pending.turnId, terminalGrant.until);
      await fileSilenceInputTicket(conversationId, Date.now());
    }
    await inspectSilentChats(Date.now());
    armSilenceSweep();
  }
  // A failed end is the turn over: nothing is still thinking, so the long window that protects deliberate effort no longer applies. Measured 2026-10-01 on an Extra High prime: the stream died, the error reload found "Resume stream unavailable", the turn ended as failed, and the chat sat toward its twenty-minute window until its owner typed. Two minutes from the failure leaves room for a native retry; the ordinary silence reload and Continue follow.
  if (lastEnd === 'failed' && !thinkingFailed && activity.terminal && sessionId && ended?.turnId &&
      terminalGrant?.deliberate && terminalGrant.sessionId === sessionId && terminalGrant.turnId === ended.turnId &&
      activeUntil.get(conversationId) === terminalGrant) {
    terminalGrant.deliberate = undefined;
    const failedAt = Math.max(terminalGrant.evidenceAt, Math.min(Date.now(), ended.time ?? Date.now()));
    terminalGrant.until = Math.min(terminalGrant.until, failedAt + CHAT_SILENCE_MS);
    armSilenceSweep();
  }
  // Another turn is the chat carrying on, and the only thing that is. Read before the failure below rather than after it: one batch can carry a turn's start and its failed end, and clearing afterwards would file exactly that batch as a chat that kept going.
  if (observations.some((item) => item.kind === 'turn_start')) failedTurnQuiet.delete(conversationId);
  const proTerminal = terminalGrant?.model === 'pro' && (activity.endedTurnId === terminalGrant.turnId ||
    (activity.terminal && !observations.some(item => item.kind === 'turn_end')));
  const awaitingSilenceRefresh = !!lastEnd && !!sessionId &&
    ((lastEnd === 'completed' && recoveryInputAllowed(sessionId, conversationId)) ||
      (['stalled', 'failed', 'unknown', 'interrupted', 'error'].includes(lastEnd) &&
        (recoveryInputAllowed(sessionId, conversationId) || loopAfterTurnFor(conversationId) || await hasQueuedAfterTurnInput(sessionId))));
  const mcpTerminal = !thinkingFailed && !terminalGrant?.thinkingFailed && terminalGrant?.turnId && activity.endedTurnId === terminalGrant.turnId && sessionId && activity.terminal &&
    await turnHasMcpCall(sessionId, conversationId, terminalGrant.turnId);
  const finalTurn = activity.endedTurnId ?? terminalGrant?.turnId;
  // A replacement page can first reveal the exact final after a completed end control. That history backfill is not fresh activity, but its canonical final still consumes the current work grant immediately.
  const observedFinal = observations.some(item => (item.kind === 'assistant_message' &&
    (item.state === 'final' || item.final === true)) || item.kind === 'native_image');
  const completedFinal = (activity.terminal || observedFinal) && sessionId &&
    await readCompletedFinal(sessionId, conversationId, finalTurn);
  // A short native generation can start and end in one accepted batch. That is still owed work when no canonical final arrived; the terminal UI flag must not prevent the same silence grant that a separately delivered start earns.
  if (!completedFinal && !terminalGrant && sessionId && ended?.turnId && lastEnd !== 'stopped' &&
      !thinkingFailed && activity.working && activity.terminal && activity.endedTurnId === ended.turnId &&
      recoveryInputAllowed(sessionId, conversationId)) {
    const [work] = await readRecentEvents(sessionId, 1, { kinds: ['user_message', 'assistant_message', 'tool_call', 'page_tool', 'turn_start'] });
    if (work && (await getSession(sessionId))?.conversationId === conversationId && !activeUntil.has(conversationId)) {
      grantActivity(conversationId, sessionId, Math.min(Date.now(), work.time), CHAT_SILENCE_MS,
        { turnId: ended.turnId, model: provenModel });
      terminalGrant = activeUntil.get(conversationId);
    }
  }
  // The ten-/two-minute budget is silence recovery only. Final response evidence consumes it even if a local call is still draining; runningToolCalls separately guards actual send/compaction. Replayed finals cannot consume newer work.
  if (completedFinal && terminalGrant && activeUntil.get(conversationId) === terminalGrant &&
      terminalGrant.sessionId === sessionId && (terminalGrant.turnId ?? null) === (finalTurn ?? null)) endActivity(conversationId);
  else if (mcpTerminal && terminalGrant && activeUntil.get(conversationId) === terminalGrant) {
    terminalGrant.mcpBacked = true;
    // A completed tool-only response can still acquire its missing final text. Give that accepted completion the ordinary two-minute recovery window; historical replay and the replacement page cannot renew a spent reload.
    if (lastEnd === 'completed' && terminalGrant.model !== 'pro' && ended &&
        !(repaired?.reason === 'silence' && repaired.state === 'done')) {
      terminalGrant.evidenceAt = Math.max(terminalGrant.evidenceAt, Math.min(Date.now(), ended.time));
      terminalGrant.until = terminalGrant.evidenceAt + CHAT_SILENCE_MS;
      armSilenceSweep();
    }
  }
  if (!completedFinal && !thinkingFailed && !mcpTerminal && !awaitingSilenceRefresh && (proTerminal || (activity.terminal && terminalGrant?.model !== 'pro'))) {
    if (proTerminal) endActivity(conversationId);
    else if (lastEnd === 'unknown' && terminalGrant?.model === 'unknown' && terminalGrant.sessionId === sessionId) {
      // Loss of browser completion evidence does not change the last meaningful-work clock.
    } else if ((lastEnd === 'failed' || lastEnd === 'stalled') && sessionId) {
      // Without the mark a `stalled` turn took the `endActivity` branch below instead — it left the silence watch entirely, so nothing reached finishSilentChats, and nothing was said.
      failedTurnQuiet.set(conversationId, { sessionId, outcome: lastEnd });
      grantActivity(conversationId, sessionId, Math.min(Date.now(), activity.at ?? Date.now()));
    }
    else endActivity(conversationId);
  }

  // Recording an alert does not authorize recovery. Older extension documents also publish informational toasts (for example after refreshing connector actions) as chat_error, explicitly marked non-recoverable. Only the DOM transport classifier or an app-owned watchdog may grant recovery authority. The error may precede a page turn, so turn identity, agent binding and recent tool calls are still not prerequisites for a recognized failure.
  const now = Date.now();
  for (const item of observations) {
    if (item.kind !== 'chat_error') continue;
    // A provider access limit is the page saying it will not carry this chat for a few minutes; the notice itself cannot authorize a reload. The DOM classifier identifies that dialog and marks it blocking, so honour its verdict rather than re-deriving one here — this prose only ever matched the English notice, so the same limit in Korean ran the silence watchdog down and asked the browser to recover against a live block. The English match stays for extension documents older than the flag.
    if (accessLimit(item)) {
      // Preserve an active Goal/Loop's existing exact silence owner, without renewing its deadline or creating retry authority from a dismissed dialog. Ordinary chats still retire their watchdog; the normal bounded recovery path owns any later action.
      const grant = activeUntil.get(conversationId);
      const preserveGoalRecovery = !!sessionId && recorded?.conversationId === conversationId &&
        goalActiveFor(conversationId) && grant?.sessionId === sessionId &&
        (!item.turnId || grant.turnId === item.turnId);
      if (!preserveGoalRecovery) endActivity(conversationId);
      continue;
    }
    if (item.recoverable !== true) continue;
    // Resume can legitimately return 404 on an idle page. The recorder's exact current generation (not a stale tab's turn or the newest question chosen below) must own H2.
    if (item.reason === 'stream_gone' && (!sessionId || recorded?.conversationId !== conversationId ||
        !item.turnId || recorded.activeTurnId !== item.turnId ||
        await readCompletedFinal(sessionId, conversationId, item.turnId))) continue;
    // Auto-compaction owns this chat's recovery clock until its ticket commits or is cancelled. A native error inside a handoff is not permission for the ordinary two-minute response watchdog to cut across the compaction's own pickup schedule. The failure is still the page saying its answer is gone, so the ticket's next pickup — the same reload of the same chat, under the same bound — is brought forward to the next sweep instead of waiting out its five minutes. That wait is how the 2026-09-02 prime showed "Connection interrupted" for nine minutes while its model went on calling tools behind the dead page.
    if (pendingContinuations().some((entry) => entry.from === conversationId)) {
      if (expediteCompactionPickup(conversationId)) {
        logInfo(`bridge: assistant transport failure — bringing the compaction pickup for ${conversationId} forward`);
      }
      break;
    }
    const source = sessionId ? await assistantRepairSource(sessionId) : null;
    if (item.reason === 'stream_gone') {
      // Source reads yield. A newer question/turn can arrive after the admission check; never attach the old 404 to that newly read question or reserve its budget.
      const current = await getSession(sessionId!);
      const questionId = current?.timelineTurns?.[item.turnId!]?.questionId;
      if (!source || source.turnId !== item.turnId || source.completed || current?.conversationId !== conversationId ||
          current.activeTurnId !== item.turnId || (questionId && source.key !== `user:${questionId}`)) continue;
    }
    // One authored question owns the transport episode, whether fetch or its DOM card wins.
    const episode = `assistant-error:${source?.key ?? 'page'}`;
    // How many turns this chat will have finished once the broken turn is over. The turn that just failed is still open here - its own end is the very next one to arrive - so counting only the ends already in hand would have the failure retire its own repair a few seconds later. Counting the open turn as spent makes the next end after it the first that means anything: a turn the chat actually got through, which is the one fact that says the page recovered without help.
    const live = liveConversations().find((entry) => entry.conversationId === conversationId);
    const endedTurns = (live?.endedTurns ?? 0) + (live?.activeTurnId ? 1 : 0);
    if (
      sessionId && source &&
      queueBrowserRecovery(conversationId, sessionId, episode, 'assistant-error', endedTurns, now, source)
    ) {
      logInfo(`bridge: assistant transport failure — asking the browser to recover ${conversationId}`);
    }
    if (sessionId && item.turnId && source?.turnId === item.turnId && !source.completed)
      await considerAutomaticCompaction(conversationId, sessionId, item.turnId);
    break;
  }
}
