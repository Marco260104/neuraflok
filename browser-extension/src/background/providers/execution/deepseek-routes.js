export function createDeepseekRouteCoordinator({
  chrome,
  tabReply,
  createBrowserTab,
  restoreDeepseekTab,
  waitForTabReady,
  isDeepseekUrl,
  writeProviderTab,
  snapshotTimings = {}
}) {
  // Open the home screen and let DeepSeek's own New-chat control choose the
  // route. The direct /a/chat/s/new-conversation path can redirect to sign-in
  // and never renders the composer.
  const DEEPSEEK_START_URL = 'https://chat.deepseek.com/';
  // DeepSeek's home screen can look blank for ~40 s before it restores the
  // previous thread. Sending during that window loses the message: the restored
  // thread replaces the composer and the answer never belongs to this turn.
  // Wait long enough for that hydration to finish before declaring the page fresh.
  const FRESH_SNAPSHOT_SETTLE_MS = snapshotTimings.freshSettleMs ?? 12_000;
  const SIGNED_SNAPSHOT_SETTLE_MS = snapshotTimings.signedSettleMs
    ?? (snapshotTimings.pollMs === undefined ? FRESH_SNAPSHOT_SETTLE_MS : 0);
  const SNAPSHOT_POLL_MS = snapshotTimings.pollMs ?? 300;
  const FRESH_CHAT_ROUTE_TIMEOUT_MS = snapshotTimings.freshRouteTimeoutMs ?? 70_000;
  // The restoration is a one-time hydration from the initial page load. Once it
  // has fired, a short stable route is enough for the retry that follows it.
  const FRESH_CHAT_ROUTE_STABLE_MS = snapshotTimings.freshRouteStableMs ?? 50_000;
  const FRESH_CHAT_ROUTE_RESTORED_MS = snapshotTimings.freshRouteRestoredMs ?? 10_000;

  function leftoverPaint(snap) {
    return String(snap && (snap.before || snap.answer) || '').replace(/\s+/g, ' ').trim();
  }

  async function waitForSignedSnapshot(tabId, settleEmptyState) {
    const deadline = Date.now() + 60_000;
    let last = null;
    let lastRestore = 0;
    let emptySince = null;
    let emptyState = '';
    while (Date.now() < deadline) {
      last = await tabReply(tabId, { type: 'neuraflok-deepseek-snapshot' }, undefined, 2_500).catch(() => null);
      if (last?.signedIn === true) {
        if (!settleEmptyState) return last;
        const hasRestoredConversation = last.hasConversation === true || Boolean(leftoverPaint(last));
        if (hasRestoredConversation) return last;

        const state = `${last.newChatRoute === true}:${last.freshConversation === true}:${last.hasConversation === false}`;
        if (state !== emptyState) {
          emptyState = state;
          emptySince = Date.now();
        } else if (emptySince !== null && Date.now() - emptySince >= SIGNED_SNAPSHOT_SETTLE_MS) {
          return last;
        }
      } else {
        emptySince = null;
        emptyState = '';
      }
      if (Date.now() - lastRestore > 4_000) {
        lastRestore = Date.now();
        await restoreDeepseekTab(tabId).catch(() => undefined);
      }
      await new Promise(resolve => setTimeout(resolve, SNAPSHOT_POLL_MS));
    }
    return last;
  }

  async function openDeepseekTab(offer, background, targetUrl = DEEPSEEK_START_URL) {
    const opened = await createBrowserTab(targetUrl, background === true);
    if (!Number.isInteger(opened?.id)) return null;
    if (!await writeProviderTab(offer.conversationId, opened.id, 'deepseek')) {
      throw new Error('Could not reserve this DeepSeek tab for the local session.');
    }
    await waitForTabReady(opened.id);
    await Promise.race([
      restoreDeepseekTab(opened.id),
      new Promise(resolve => setTimeout(resolve, 8_000))
    ]).catch(() => undefined);
    const ready = await chrome.tabs.get(opened.id).catch(() => opened);
    const url = ready?.url || ready?.pendingUrl || opened.url;
    if (!ready || !isDeepseekUrl(url) || ready.pendingUrl) {
      throw new Error('The new DeepSeek page did not finish loading. No message was sent.');
    }
    if (ready.status && ready.status !== 'complete') {
      throw new Error('The new DeepSeek page did not finish loading. No message was sent.');
    }
    return ready;
  }

  async function waitForFreshChatRoute(tabId, stableMs = FRESH_CHAT_ROUTE_STABLE_MS) {
    const startedAt = Date.now();
    const deadline = startedAt + FRESH_CHAT_ROUTE_TIMEOUT_MS;
    let routeSince = null;
    let sawBlank = false;
    let last = null;
    let lastRestore = 0;
    while (Date.now() < deadline) {
      const tabState = await chrome.tabs.get(tabId).catch(() => null);
      const currentUrl = tabState?.url || tabState?.pendingUrl || '';
      if (tabState && isDeepseekUrl(currentUrl) && !tabState.pendingUrl
        && (!tabState.status || tabState.status === 'complete')) {
        last = await tabReply(tabId, { type: 'neuraflok-deepseek-snapshot' }, undefined, 1_500).catch(() => null);
        const blank = last?.signedIn === true
          && last.freshConversation === true
          && last.hasConversation === false
          && !leftoverPaint(last);
        const fresh = blank && last.newChatRoute === true;
        if (fresh) {
          if (routeSince === null) routeSince = Date.now();
          if (Date.now() - routeSince >= stableMs) {
            return {
              ...last,
              freshStateStable: true,
              routeStableMs: stableMs,
              routeWaitMs: Date.now() - startedAt
            };
          }
        } else {
          // If a blank page paints a conversation, the click happened before
          // DeepSeek finished hydrating and was swallowed. Report the restored
          // thread so the caller can reopen New chat right away.
          if (sawBlank && (last?.hasConversation === true || leftoverPaint(last))) {
            return { ...last, routeRestored: true, routeWaitMs: Date.now() - startedAt };
          }
          routeSince = null;
        }
        if (blank) sawBlank = true;
      } else {
        routeSince = null;
      }
      if (!last && Date.now() - lastRestore >= 1_500) {
        lastRestore = Date.now();
        await restoreDeepseekTab(tabId).catch(() => undefined);
      }
      await new Promise(resolve => setTimeout(resolve, SNAPSHOT_POLL_MS));
    }
    return null;
  }

  return {
    leftoverPaint,
    waitForSignedSnapshot,
    openDeepseekTab,
    waitForFreshChatRoute,
    freshRouteRestoredMs: FRESH_CHAT_ROUTE_RESTORED_MS
  };
}
