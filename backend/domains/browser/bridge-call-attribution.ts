import { isProModel } from '../../../contracts/model-capabilities.js';
import { recordedRequestTurn, responseTurnId } from '../../../contracts/chronology.js';
import { CHAT_SILENCE_MS, type SessionSummary } from '../../../contracts/session.js';
import { sessionActivityExpiresAt } from './session-activity.js';
import type { bridgeRecoveryObservationRuntime } from './bridge.js';

type Runtime = typeof bridgeRecoveryObservationRuntime;
// Exact call attribution updates recovery from the recorder's committed session evidence.
export function noteCallAttribution(
  runtime: Runtime,
  conversationId: string | null,
  sessionId: string,
  currentConversation: boolean,
  startedAt: number,
  endsActivity = false,
  completedFinalAt: number | null = null,
  requestId: string | null = null,
  reopenedTurnId: string | null = null,
  filedSession: SessionSummary | null = null
): void {
  const {
    activeUntil,
    armSilenceSweep,
    armUnattributedTick,
    attributionRepairCurrent,
    changed,
    compactionWatch,
    endActivity,
    forgetGoalWatch,
    getSession,
    goalPendingReplyFor,
    grantActivity,
    isChatBlocked,
    lastAttributedCallAt,
    logInfo,
    logWarn,
    noteAgentAlive,
    noteAgentContextTokens,
    notePickupActivity,
    noteRecoveryActivity,
    recordAgentMessage,
    requestCorrelation,
    retireGoalDraftsFor,
    retireSpentRepairs,
    repairCandidates,
    repairsInFlight,
    revokeSilenceInputs,
    revokeSilenceLoop,
    sessionWorkingAt,
    turnHasMcpCall,
    unattributedCandidateCurrent,
    unattributedIncidents,
    UNATTRIBUTED_FIRST_WINDOW_MS,
    UNATTRIBUTED_REQUEST_MEMORY,
    UNATTRIBUTED_SINGLE_WINDOW_MS
  } = runtime;
  if (conversationId) {
    // MCP truth can grow while a Pro page emits no new observation. The just-filed canonical summary, not a later browser poll, owns the worker's context meter.
    if (currentConversation && filedSession?.id === sessionId && filedSession.conversationId === conversationId)
      noteAgentContextTokens(conversationId, filedSession.contextTokens);
    if (currentConversation && !endsActivity) lastAttributedCallAt.set(conversationId, Date.now());
    // The recorder has just withdrawn a completed end the page reported: the same server turn went on calling tools. Whatever Goal was drafting for that end — or had filed as owed — was a reply to an answer that has not been given. The real end, when the page sees it, files its own obligation.
    if (reopenedTurnId && retireGoalDraftsFor(conversationId)) {
      forgetGoalWatch(conversationId);
      logInfo(`goal: withdrew the decision owed for turn ${reopenedTurnId} of ${conversationId} — the turn is still running`);
    }
    for (const incident of unattributedIncidents.values()) {
      const candidate = incident.candidates.find(entry => entry.conversationId === conversationId && entry.sessionId === sessionId);
      if (currentConversation && candidate && filedSession?.conversationId === conversationId &&
          filedSession.id === sessionId && startedAt >= incident.startedAt &&
          (filedSession.activeTurnId ?? null) === candidate.turnId) {
        incident.proven.add(conversationId);
      }
    }
    armUnattributedTick();
    // Exact recording authority follows the durable lineage, but recovery authority does not. A late request from handoff source A is still filed in the A->B session above; once that session says B is current, the same request must not put A back on the silence/Goal clock.
    if (!currentConversation) {
      const grant = activeUntil.get(conversationId);
      if (grant?.sessionId === sessionId) activeUntil.delete(conversationId);
      const repair = repairsInFlight.get(conversationId);
      if (repair?.sessionId === sessionId) repairsInFlight.delete(conversationId);
      forgetGoalWatch(conversationId);
      compactionWatch.delete(conversationId);
      armSilenceSweep();
      return;
    }
    if (endsActivity) {
      endActivity(conversationId);
      repairsInFlight.delete(conversationId);
      return;
    }
    const callOwner = recordedRequestTurn(filedSession?.requestTurns, requestId, conversationId);
    if (callOwner && filedSession?.activeTurnId && responseTurnId(filedSession.timelineTurns, callOwner.turnId) !==
        responseTurnId(filedSession.timelineTurns, filedSession.activeTurnId)) return;
    // The canonical completion reader has checked the newly committed call too. Do not override its verdict with another timestamp rule: a native final may settle an exact request that still delivers trailing connector work.
    const previous = activeUntil.get(conversationId);
    const continuingMcp = previous?.sessionId === sessionId && previous.mcpBacked && !previous.thinkingFailed &&
      (!!filedSession?.activeTurnId ? filedSession.activeTurnId === previous.turnId :
        filedSession?.lastTurnOutcome !== 'stopped' && previous.until > Date.now());
    if (completedFinalAt !== null) {
      if (previous?.sessionId === sessionId && !filedSession?.activeTurnId) endActivity(conversationId);
      const repair = repairsInFlight.get(conversationId);
      if (repair?.reason === 'unattributed' && !attributionRepairCurrent(repair, filedSession)) repairsInFlight.delete(conversationId);
      return;
    }
    const selection = filedSession?.selectedModel;
    const pro = previous?.model === 'pro' || ((!previous || previous.model === 'unknown') && selection?.conversationId === conversationId && isProModel(selection.model, selection.reasoningEffort));
    if (isChatBlocked(conversationId) ||
        (!continuingMcp && !filedSession?.activeTurnId && filedSession?.lastTurnEndAt != null && startedAt <= filedSession.lastTurnEndAt)) return;
    // The exact call is stronger than browser lifecycle state: the model is still working even when Chrome, the tab or a reload destroyed the page's local turn projection.
    const sourceTurnId = filedSession?.activeTurnId ?? previous?.turnId ??
      goalPendingReplyFor(conversationId)?.silenceSourceTurnId ?? filedSession?.finishTurn?.turnId ?? null;
    grantActivity(conversationId, sessionId, continuingMcp ? Date.now() : pro ? Math.min(Date.now(), startedAt) : Date.now(), CHAT_SILENCE_MS,
      { turnId: sourceTurnId, model: pro ? 'pro' : previous?.model ?? 'unknown', mcpBacked: true });
    // Exact calls are visible work even without a page. They cannot turn that display into a worker wake, browser repair or continuation after departure.
    if (filedSession?.browserRecoveryDismissedAt !== undefined || filedSession?.endedAt !== null) return;
    // A completed tool is real work too. Long-running calls must leave a full quiet window for the model to process their result, without reviving historical finals.
    if (!isChatBlocked(conversationId)) {
      const alive = noteAgentAlive(conversationId, 'call');
      if (alive?.report) void recordAgentMessage(alive.report, 'sent', conversationId)
        .catch(error => logWarn(`agent: could not record resumed work: ${String(error)}`));
    }
    void revokeSilenceInputs(sessionId).catch(error => logWarn(`input: could not withdraw silence pickup: ${String(error)}`));
    void revokeSilenceLoop(conversationId).catch(error => logWarn(`goal: could not withdraw silence pickup: ${String(error)}`));
    noteRecoveryActivity(conversationId);
    notePickupActivity(conversationId);
    // Scoped to the repair this fact is evidence about. An attributed call proves the request-id join, which is the whole of what an `unattributed` repair exists to restore. It proves nothing about the answer stream a page lost, and the live trace is why that distinction is load-bearing: fifteen attributed calls arrived while the page sat on "Connection interrupted. Waiting for the complete answer", each one deleting the reload that notice had just asked for. That repair is retired by its own turn ending - see `retireSpentRepairs`.
    const repair = repairsInFlight.get(conversationId);
    if (repair?.reason !== 'assistant-error' && (!repair?.attribution || !attributionRepairCurrent(repair, filedSession)))
      repairsInFlight.delete(conversationId);
    return;
  }
  if (requestId && requestCorrelation(requestId)) return;
  retireSpentRepairs();
  const opening = repairCandidates().filter(unattributedCandidateCurrent);
  const key = requestId ?? `headerless:${opening.map(entry => `${entry.sessionId}:${entry.turnId}`).sort().join(',')}`;
  const heldIncident = unattributedIncidents.get(key);
  if (heldIncident) {
    heldIncident.lastUnknownStartedAt = Math.max(heldIncident.lastUnknownStartedAt, startedAt);
    return;
  }
  if (opening.length === 0 && !requestId) return;
  if (unattributedIncidents.size >= UNATTRIBUTED_REQUEST_MEMORY) {
    const spent = [...unattributedIncidents].find(([, incident]) => incident.pass === 2);
    if (!spent) return;
    for (const [id, repair] of repairsInFlight) if (repair.attribution?.incident === spent[1]) repairsInFlight.delete(id);
    unattributedIncidents.delete(spent[0]);
  }
  const openedAt = Date.now();
    const incident = {
    startedAt: openedAt, firstDueAt: openedAt, pass: opening.length ? 0 as const : 2 as const,
    firstAttemptAt: null, lastUnknownStartedAt: startedAt, ready: Promise.resolve(), requestId,
    candidates: opening, proven: new Set<string>(), dismissed: new Set<string>()
  };
  unattributedIncidents.set(key, incident);
  // Freeze the identities synchronously; read their existing activity projection at T0. Later arrivals cannot become candidates while this asynchronous read completes.
  incident.ready = Promise.all(opening.map(async candidate => {
    const summary = await getSession(candidate.sessionId);
    if (!summary || summary.conversationId !== candidate.conversationId ||
        (summary.activeTurnId ?? null) !== candidate.turnId ||
        !sessionWorkingAt({ ...summary, activityExpiresAt: sessionActivityExpiresAt(summary) }, openedAt)) {
      incident.dismissed.add(candidate.conversationId);
      return;
    }
    // An exactly attributed call earlier in this same turn already shows the chat's join works, so the unknown request is not its own. Reloading it anyway interrupted working chats whenever a conversation with no NEURAFLOK page at all called a tool.
    if (candidate.turnId && await turnHasMcpCall(candidate.sessionId, candidate.conversationId, candidate.turnId))
      incident.proven.add(candidate.conversationId);
  })).then(() => {
    const open = incident.candidates.filter(candidate =>
      !incident.dismissed.has(candidate.conversationId) && !incident.proven.has(candidate.conversationId));
    incident.firstDueAt = openedAt + (open.length === 1 ? UNATTRIBUTED_SINGLE_WINDOW_MS : UNATTRIBUTED_FIRST_WINDOW_MS);
    armUnattributedTick();
    changed();
  });
}
