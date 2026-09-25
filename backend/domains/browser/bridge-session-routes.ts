import http from 'node:http';
import type { ChatObservation } from '../sessions/history/recorder.js';
import { handleInputBridgeRoute } from '../sessions/input/bridge-routes.js';
import { noteRecoveryObservations } from './bridge-recovery-observations.js';
import type { bridgeSessionRouteRuntime } from './bridge.js';

// Routes browser evidence, repair claims and session lifecycle updates.
type Runtime = typeof bridgeSessionRouteRuntime;

export async function handleBridgeSessionRoutes(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, runtime: Runtime): Promise<boolean> {
  const {
    PRIME_ID,
    acceptGoalReplyNow,
    activeUntil,
    agentForOwnedConversation,
    agentInfoForOwnedConversation,
    assistantRepairCurrent,
    attributionRepairAllowed,
    awaitingReturn,
    bindLeasedWorkerCommand,
    bridgeRecoveryObservationRuntime,
    browserOf,
    changed,
    chatIsWorkingNow,
    closeConversation,
    collectRecordedBrowserDecision,
    compactionRepairCurrent,
    compactionWatch,
    conversationId,
    conversationWasSuperseded,
    departureAllowsRepairFor,
    endActivity,
    fileSilenceInputTicket,
    findSessionByConversation,
    forgetGoalWatch,
    getSession,
    goalFencedChat,
    isChatBlocked,
    logInfo,
    logWarn,
    noteAgentAlive,
    noteAgentContextTokens,
    noteChatOrigin,
    observationWritesInFlight,
    openingHeldElsewhere,
    parseCallEvidence,
    parseObservations,
    primeConversationGone,
    primeForOwnedConversation,
    queueMissingTab,
    readBody,
    reconcileWorkerFinish,
    recordAgentMessage,
    recordChatObservations,
    recordRequestEvidence,
    recoveryInputAllowed,
    repairNeedsClaim,
    repairsInFlight,
    requestCorrelation,
    revokeSilenceInputs,
    silenceRepairCurrent,
    staleCompanion,
    stopRequestedFor,
    tidyCommands,
    turnRepairSpent,
    wakeBrowserWork,
    workerConversationGone,
    tooLarge: sendTooLarge
  } = runtime;
  const json = (...args: Parameters<Runtime['json']>): true => { runtime.json(...args); return true; };
  const tooLarge = (...args: Parameters<Runtime['tooLarge']>): true => { sendTooLarge(...args); return true; };

  if (await handleInputBridgeRoute(route, req, res, origin, {
    readBody,
    json: runtime.json,
    conversationId,
    recoveryInputAllowed,
    staleCompanion,
    openingHeldElsewhere,
    browserOf,
    changed
  })) return true;

  if (route === '/repairs/claim' && req.method === 'POST') {
    if (staleCompanion(req)) return json(res, 200, { allowed: false }, origin);
    let body: unknown;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad_request' }, origin); }
    const token = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).token : null;
    if (typeof token !== 'string' || token.length > 128) return json(res, 400, { error: 'bad_request' }, origin);
    const found = [...repairsInFlight].find(([, repair]) => repairNeedsClaim(repair) && repair.token === token && repair.state === 'handed');
    if (!found) return json(res, 200, { allowed: false }, origin);
    const [conversationId, repair] = found;
    const session = await getSession(repair.sessionId);
    // A Compact & resume the user pressed may act on the chat they closed: handout and claim agree.
    const current = session?.conversationId === conversationId && departureAllowsRepairFor(session, repair.reason, repair.episode) &&
      !(repair.reason !== 'compaction' && !session.activeTurnId && session.lastTurnOutcome === 'stopped') && !isChatBlocked(conversationId) &&
      !stopRequestedFor(conversationId) && await attributionRepairAllowed(repair, session) &&
      await assistantRepairCurrent(conversationId, repair) && await silenceRepairCurrent(conversationId, repair) &&
      compactionRepairCurrent(conversationId, repair);
    // An observation still publishing can revoke this handout. Refuse this claim transiently; the same unclaimed token remains eligible to be checked.
    const allowed = current && observationWritesInFlight === 0 && repairsInFlight.get(conversationId) === repair && repair.state === 'handed' && !repair.claimed;
    if (allowed) {
      repair.claimed = true;
      if (repair.reason === 'assistant-error' && repair.assistantSource)
        turnRepairSpent.set(conversationId, { sessionId: repair.sessionId, turnKey: repair.assistantSource.key, token, at: Date.now() });
      if (repair.attribution && repair.attribution.incident.firstAttemptAt === null)
        repair.attribution.incident.firstAttemptAt = Date.now();
    }
    return json(res, 200, { allowed }, origin);
  }

  if (route === '/correlations' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    const calls = parseCallEvidence(body['calls'], true).filter((call) => call.requestId !== null);
    if (calls.length === 0) return json(res, 400, { error: 'bad_request_evidence' }, origin);
    const reportedAgent = typeof body['agent'] === 'string' && /^[a-z0-9-]{1,40}$/i.test(body['agent'])
      ? body['agent']
      : null;
    const reportedCommandId = typeof body['agentCommandId'] === 'string' ? body['agentCommandId'] : null;
    bindLeasedWorkerCommand(reportedAgent, reportedCommandId, id);

    // Binds exact request IDs to the verified provider conversation before acknowledging live-turn evidence.
    const requestIds = [...new Set(calls.map((call) => call.requestId).filter((value): value is string => Boolean(value)))];
    const conflicts = requestIds.filter((requestId) => {
      const held = requestCorrelation(requestId);
      return held !== null && held.conversationId !== id;
    });
    const blocked = new Set(conflicts);
    const unresolved = calls.filter((call) => call.requestId && !blocked.has(call.requestId) && requestCorrelation(call.requestId) === null);
    const observations: ChatObservation[] = unresolved.length > 0
      ? [{ kind: 'tool_evidence', time: Date.now(), calls: unresolved }]
      : [];
    // Even an already-confirmed mapping must ensure/reuse the chat session, matching /events' first-observation semantics and making this one atomic operation from the page's view.
    const sessionId = await recordRequestEvidence(id, observations);
    const confirmed = requestIds.filter((requestId) => requestCorrelation(requestId)?.conversationId === id);
    return json(res, 200, {
      ok: true,
      conversationId: id,
      sessionId,
      requestIds,
      confirmed,
      conflicts,
      complete: conflicts.length === 0 && confirmed.length === requestIds.length
    }, origin);
  }
  if (route === '/events' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (!id) return json(res, 400, { error: 'bad_conversation_id' }, origin);
    // Normal worker binding happens on the exact command ACK. `/events` is the lost-ACK recovery path, but the friendly id (`worker-1`) is reused by every later swarm and is therefore not enough authority on its own. A command-opened document also carries the exact random command id it redeemed; only that exact (agent, command) pair may recover a still-leased worker. Old extension builds omit agentCommandId and safely lose recovery rather than guess from the friendly worker label.
    const reportedAgent = typeof body['agent'] === 'string' && /^[a-z0-9-]{1,40}$/i.test(body['agent'])
      ? body['agent']
      : null;
    const reportedCommandId = typeof body['agentCommandId'] === 'string' ? body['agentCommandId'] : null;
    bindLeasedWorkerCommand(reportedAgent, reportedCommandId, id);
    // This reports attachment only. The recorder below owns actual work and replay deduplication.
    const revived = noteAgentAlive(id, 'page');
    if (revived?.report) await recordAgentMessage(revived.report, 'sent', id);
    const observations = parseObservations(body['events']);
    runtime.adjustObservationWritesInFlight(1);
    let committed: { sessionId: string | null; stored: number; wake: boolean } | undefined;
    try {
      const agent = agentForOwnedConversation(id);
      // The command acknowledgement normally supplies this origin before the worker's first observation. Its pending copy lives in recorder memory until a session exists, though, so an app restart in that narrow gap used to create an origin-less worker session even though the broker had durably restored the exact worker binding and task. Reconstitute the same origin from that authoritative binding before the recorder creates the session.
      if (agent && agent !== 'prime') {
        const worker = agentInfoForOwnedConversation(id);
        if (worker?.role === 'worker') {
          const prime = primeForOwnedConversation(id);
          await noteChatOrigin(id, {
            kind: 'worker',
            fromSessionId: prime ? (await findSessionByConversation(prime, { requireUnique: true }))?.id ?? null : null,
            agentId: worker.id,
            task: worker.task
          });
        }
      }
      const result = await recordChatObservations(id, observations, agent);
      const superseded = await conversationWasSuperseded(id);
      if (!superseded && !isChatBlocked(id) && result.activity.working && result.activity.at) {
        const woke = result.activity.startedAt !== undefined
          ? noteAgentAlive(id, 'turn', result.activity.startedAt)
          : noteAgentAlive(id, 'output', result.activity.at);
        if (result.activity.startedAt !== undefined && result.activity.at > result.activity.startedAt)
          noteAgentAlive(id, 'output', result.activity.at);
        if (woke?.report) await recordAgentMessage(woke.report, 'sent', id);
        if (woke?.revived) tidyCommands();
      }
      if (!superseded && result.sessionId) await collectRecordedBrowserDecision(id);
      // The stable assistant message, not the page-local turn id, is the exactly-once Goal checkpoint. Freeze app config/key policy before 200 lets the browser retire this terminal observation from its durable journal.
      try {
        for (const candidate of result.goalCandidates) {
          await acceptGoalReplyNow({
            conversationId: id,
            sessionId: result.sessionId!,
            ...candidate,
            blocked: superseded || goalFencedChat(id)
          });
        }
      } catch (err) {
        logWarn(
          `bridge: Goal reply decision for ${id} is not durable yet — ${err instanceof Error ? err.message : String(err)}`
        );
        return json(res, 503, { error: 'goal_reply_not_durable', retryable: true }, origin);
      }
      if (superseded) {
        endActivity(id);
        repairsInFlight.delete(id);
        forgetGoalWatch(id);
        compactionWatch.delete(id);
      } else {
        await noteRecoveryObservations(bridgeRecoveryObservationRuntime, id, result.sessionId, observations, result.activity);
      }
      // How full this chat is, measured by the app's own session record rather than by anything the model said about itself, and fed in before the finish reconciliation below. That ordering is the whole point: a worker that crossed the context ceiling during the very turn it is now ending has to end for good, and the broker can only know that if the measurement lands first. Restart re-derives it from the same place, because the durable session is what carries the figure across a crash, not the snapshot: the first observation batch from a restored chat puts it back before that worker's next sleep or revival.
      if (agent && result.sessionId) {
        const summary = await getSession(result.sessionId).catch(() => null);
        if (summary) noteAgentContextTokens(id, summary.contextTokens);
      }
      // Workers are one-shot jobs. A settled assistant answer is first-hand page evidence that the worker has completed a turn; waiting for the model to make another MCP call solely to say `finish` leaves normal final answers as zombie workers forever. The browser journal is allowed to split one turn's observations across adjacent HTTP batches, so reconcile against the just-written durable session rather than treating one transport envelope as a lifecycle boundary.
      if (agent && agent !== PRIME_ID && result.sessionId) {
        if (!(await reconcileWorkerFinish(id, result.sessionId, observations))) {
          return json(res, 503, { error: 'worker_state_not_durable', retryable: true }, origin);
        }
        tidyCommands();
      }
      // A committed terminal observation changes outbox eligibility even though no input row changed: finish stages and after-turn sends can now be claimed. Publish that boundary to the existing wake channel instead of waiting for the extension's idle maintenance poll. Claims still recheck exact state.
      committed = { sessionId: result.sessionId, stored: result.stored, wake: !superseded && result.activity.terminal };
    } finally {
      runtime.adjustObservationWritesInFlight(-1);
    }
    // A replacement page may discover Thinking failed after this source's ordinary silence ticket was already filed. Publish its receipt-anchored listening deadline into that same outbox row before acknowledging the observation.
    if (activeUntil.get(id)?.thinkingFailed) await fileSilenceInputTicket(id, Date.now());
    if (committed?.wake) wakeBrowserWork();
    return json(res, 200, { sessionId: committed!.sessionId, stored: committed!.stored }, origin);
  }

  if (route === '/closed' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).message === 'body_too_large') return tooLarge(res, origin);
      return json(res, 400, { error: 'bad_request' }, origin);
    }
    const id = conversationId(body['conversationId']);
    if (id) {
      // Preserve the page's last exact turn verdict before closeConversation removes its live recorder entry. Agent ownership outlives a tab; an open turn is the narrower fact that authorises reopening it. Read before closeConversation() forgets the page: the page's own open turn, or this app's standing definition of a chat that is working — an attributed call or current-turn observation inside the silence window. A bare open turn ages out (chatIsWorkingNow): reopening the tab of a chat whose turn was left open days ago only wakes the ten-minute watchdog (2026-10-09).
      const working = chatIsWorkingNow(id);
      const manual = body['manual'] === true;
      if (manual) {
        // User departure withdraws activity and pending browser actions. Preserve confirmed receipts so returning cannot refund a reload already carried out.
        endActivity(id);
        if (repairsInFlight.get(id)?.state !== 'done') repairsInFlight.delete(id);
        awaitingReturn.delete(id);
        compactionWatch.delete(id);
      }
      await closeConversation(id, manual);
      // Closing a tab does not stop provider generation; retain retired-worker fences until expiry and end orphaned runs unless a continuation owns the prime binding.
      if (primeConversationGone(id)) logInfo(`bridge: the prime chat ${id} closed, so its run ended`);
      else if (workerConversationGone(id)) {
        logInfo(`bridge: worker chat ${id} closed — its slot is detached, not ended, until it also goes quiet`);
      }
      if (manual) {
        const session = await findSessionByConversation(id);
        if (session) await revokeSilenceInputs(session.id);
        if (repairsInFlight.get(id)?.state !== 'done') repairsInFlight.delete(id);
        logInfo(`bridge: ${id} was closed deliberately; automatic browser recovery is paused until its page returns`);
      } else await queueMissingTab(id, working);
    }
    return json(res, 200, { ok: true }, origin);
  }
  return false;
}
