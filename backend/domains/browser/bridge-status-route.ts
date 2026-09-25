import http from 'node:http';
import type { bridgeStatusRouteRuntime } from './bridge.js';

type Runtime = typeof bridgeStatusRouteRuntime;

// Serves extension status and returns the current browser work projection.
export async function handleBridgeStatusRoute(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, url: URL, runtime: Runtime): Promise<boolean> {
  const {
    browserOf,
    browserRecoveryMonitoring,
    browserTabPolicy,
    browserWindowBounds,
    changed,
    commands,
    confirmRepair,
    conversationId,
    currentBrowserWorkArea,
    extensionBuildOf,
    extensionHost,
    extensionUpdateOffer,
    failRepairAttempt,
    getConfig,
    inputHeldElsewhere,
    listInputs,
    liveConversations,
    logInfo,
    noteExtensionUpdateHold,
    noteRepairHeld,
    pendingBrowserInputs,
    pendingBrowserPlacement,
    pendingBrowserPreferenceRequest,
    pendingBrowserRevivals,
    pendingProviderPage,
    pendingStopCommands,
    queueStalledTabRecovery,
    readBody,
    recordWebProviderPresence,
    recordCompanionStatus,
    runningToolCalls,
    scheduleBrowserPresence,
    retireOpeningCustody,
    takePendingRepairs,
    takeReveals
  } = runtime;
  const json = (...args: Parameters<Runtime['json']>): true => { runtime.json(...args); return true; };
  const extensionUpdateReply = (running: string | null) => {
    const offer = extensionUpdateOffer(running);
    return offer ? { ...offer, busy: runningToolCalls() > 0 } : null;
  };

  if (route === '/status') {
    const live = liveConversations();
    let openConversations: string[] = [];
    let stalledConversations: string[] = [];
    let revealRequested = false;
    if (req.method === 'POST') {
      const body = await readBody(req) as { openConversations?: unknown; stalledConversations?: unknown; updateHold?: unknown; canReveal?: unknown; webProviders?: unknown };
      if (!Array.isArray(body?.openConversations) || body.openConversations.length > 10_000 || body.openConversations.some(id => !conversationId(id))) {
        return json(res, 400, { error: 'invalid_open_conversations' }, origin);
      }
      openConversations = body.openConversations as string[];
      if (body.stalledConversations !== undefined &&
          (!Array.isArray(body.stalledConversations) || body.stalledConversations.length > 10_000 || body.stalledConversations.some(id => !conversationId(id)))) {
        return json(res, 400, { error: 'invalid_stalled_conversations' }, origin);
      }
      stalledConversations = (body.stalledConversations ?? []) as string[];
      noteExtensionUpdateHold(body.updateHold);
      revealRequested = body.canReveal === true;
      // Provider status is owned by NEURAFLOK's persistent Chromium profile.
      if (extensionHost(req) === 'integrated' && body.webProviders && typeof body.webProviders === 'object' && !Array.isArray(body.webProviders)) {
        const update = recordWebProviderPresence(body.webProviders);
        scheduleBrowserPresence();
        if (update.changed) changed();
        for (const item of update.labels) logInfo(`bridge: ${item.state}`);
      }
    }
    const openSet = new Set(openConversations);
    const tabPolicy = await browserTabPolicy(openSet);
    // A discarded or frozen tab still answers the extension's tab query, so neither the close path nor the silence sweep ever fires for it — while its page can neither record nor receive. Each stalled report runs the missing-tab decision minus the close side effects, before this same response hands the due repair out.
    for (const stalledId of stalledConversations) {
      if (openSet.has(stalledId)) await queueStalledTabRecovery(stalledId);
    }
    // The extension's maintenance pass, and the whole conversation about repairs: `repaired` reports the one handout it was last given and has now carried out, and `repairs` is every chat now due one — the chats whose local tool calls stopped being attributable to them, see `tickUnattributedIncident`. Reporting first is what makes a pass that says nothing mean the last repair did not happen. Empty, which is almost always, costs one request.
    const repaired = url.searchParams.get('repaired');
    const repairFailed = url.searchParams.get('repairFailed');
    const repairAction = url.searchParams.get('repairAction');
    const action = repairAction === 'reloaded' || repairAction === 'reopened' || repairAction === 'resumed' ||
      repairAction === 'preserved' || repairAction === 'present' ? repairAction : null;
    if (repaired) {
      await confirmRepair(repaired.slice(0, 64), action);
    } else if (repairFailed) {
      await failRepairAttempt(repairFailed.slice(0, 64), action, url.searchParams.get('why'), url.searchParams.get('detail')?.slice(0, 80) ?? null);
    }
    const repairHeld = url.searchParams.get('repairHeld');
    if (repairHeld) noteRepairHeld(repairHeld.slice(0, 64), url.searchParams.get('why'));
    const revivals = pendingBrowserRevivals();
    const revival = revivals[0] ?? null;
    const inputRows = await listInputs();
    const browser = browserOf(req);
    const canReveal = req.method === 'POST' && revealRequested;
    recordCompanionStatus(browser, openSet, req.method === 'POST', canReveal);
    const pendingInputs = await pendingBrowserInputs();
    const pendingIds = new Set(pendingInputs.map(input => input.id));
    retireOpeningCustody(pendingIds);
    return json(
      res,
      200,
      {
        ok: true,
        conversations: live,
        stopTurns: await pendingStopCommands(),
        // One provider page operation belongs to the paired browser extension that executes it.
        providerPage: extensionHost(req) === 'integrated' ? pendingProviderPage() : null,
        browserPreferenceRequest: pendingBrowserPreferenceRequest(),
        inputOpeningIds: inputRows.filter(row => !['sent', 'failed', 'cancelled'].includes(row.state)).map(row => row.id),
        // A message for the running turn keeps the active provider call and its result together.
        inputs: [...pendingInputs.filter(input => (!input.conversationId || input.directTurn || runningToolCalls(input.conversationId) === 0) &&
            !inputHeldElsewhere(input, browser)),
          ...inputRows.filter(row => row.lifetime === 'temporary-planner' && ['sent', 'cancelled', 'failed'].includes(row.state))
            // Retain the exact conversation id so cleanup can find a temporary planner page after its route changes.
            .map(row => ({ id: row.id, owner: row.owner, lifetime: row.lifetime, close: true,
              retire: true, ...(row.conversationId ? { conversationId: row.conversationId } : {}) }))],
        background: getConfig().ui.backgroundChats === true,
        browserOnly: getConfig().ui.browserOnly === true,
        browserWorkArea: currentBrowserWorkArea(),
        browserWindowBounds: browserWindowBounds(),
        commands: commands.length,
        // Rendering custody follows the actual command ledger, including its retirement.
        commandIds: commands.map(command => command.id),
        revival,
        revivals,
        placement: pendingBrowserPlacement(null, browser),
        ...(canReveal ? { reveals: takeReveals(browser) } : {}),
        // A failure report closes this request. Reissuing the repair in the same response would replace the visible failure with "Trying" before a renderer could ever observe it.
        repairs: repairFailed || repairHeld ? [] : await takePendingRepairs(Date.now(), browser),
        ...tabPolicy,
        recoveryMonitoring: browserRecoveryMonitoring(),
        // A newer extension build ships with this app. The extension reloads into it on its own when nothing is running; see `/extension/update`.
        extensionUpdate: extensionUpdateReply(extensionBuildOf(req)),
        // The extension follows the app: its texts in the app's language, and preferences it lost with a reinstall (a new id starts with empty storage) taken back from here.
        language: getConfig().ui.language ?? null,
        browserPreferences: getConfig().ui.browserPreferences ?? null
      },
      origin
    );
  }
  return false;
}
