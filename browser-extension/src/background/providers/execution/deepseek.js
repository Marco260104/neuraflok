import { createDeepseekReplyWatcher } from './deepseek-watch.js';
import { createDeepseekRouteCoordinator } from './deepseek-routes.js';

export function createDeepseekPageExecutor({ chrome, activeTabs, call, tabReply, createBrowserTab, restoreDeepseekTab, waitForTabReady, isDeepseekUrl, state, snapshotTimings = {}, watchTimings = {} }) {
  const { stoppedProviderOffers, readDeepseekSent, writeDeepseekSent, readProviderTab, writeProviderTab } = state;
  let deepseekPageFlight = null;
  const DEEPSEEK_SEND_MS = 100_000;
  const DEEPSEEK_READ_MS = 8_000;

  function isPageTimeout(error) {
    return /provider_page_timeout/i.test(String(error && error.message ? error.message : error || ''));
  }

  async function postDeepseekPage(offer, body) {
    if (!offer || typeof offer.id !== 'string' || typeof offer.conversationId !== 'string') return false;
    const reply = await call('/provider/page', {
      method: 'POST',
      body: JSON.stringify({ ...body, id: offer.id, provider: 'deepseek', conversationId: offer.conversationId })
    });
    if (reply.ok && reply.data?.ok === true) {
      const sent = await readDeepseekSent();
      if (sent?.id === offer.id) await writeDeepseekSent(null);
      return true;
    }
    return false;
  }

  const { watchDeepseekReply, isAck, looksLikeThink, hasToolCall } = createDeepseekReplyWatcher({
    tabReply, call, postDeepseekPage, stoppedProviderOffers, timings: watchTimings
  });

  const {
    leftoverPaint,
    waitForSignedSnapshot,
    openDeepseekTab,
    waitForFreshChatRoute,
    freshRouteRestoredMs
  } = createDeepseekRouteCoordinator({
    chrome,
    tabReply,
    createBrowserTab,
    restoreDeepseekTab,
    waitForTabReady,
    isDeepseekUrl,
    writeProviderTab,
    snapshotTimings
  });

  const FRESH_CHAT_ERROR = 'DeepSeek did not confirm a stable new chat. No message was sent; open a new chat and try again.';

  async function confirmFreshChatRoute(tabId) {
    let lastError = '';
    let stableMs;
    let handledRestore = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = await tabReply(tabId, { type: 'neuraflok-deepseek-open-new-chat' }, undefined, 8_000).catch(() => null);
      const started = reply?.started === true || reply?.alreadyOpen === true;
      if (!started) {
        lastError = reply && typeof reply.error === 'string' && reply.error.trim()
          ? reply.error.trim()
          : 'DeepSeek did not acknowledge the new-chat command. No message was sent; retry.';
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      const fresh = await waitForFreshChatRoute(tabId, stableMs);
      if (fresh && fresh.routeRestored !== true) {
        return handledRestore ? { ...fresh, freshRouteRestored: true } : fresh;
      }
      if (fresh?.routeRestored === true) {
        stableMs = freshRouteRestoredMs;
        handledRestore = true;
      }
      lastError = FRESH_CHAT_ERROR;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(lastError || FRESH_CHAT_ERROR);
  }

  function inspectDeepseekPage(offer, background) {
    if (!offer || typeof offer.id !== 'string' || typeof offer.conversationId !== 'string') return;
    if (deepseekPageFlight) {
      if (offer.stop === true) {
        stoppedProviderOffers.add(offer.id);
        void (async () => {
          const sent = await readDeepseekSent();
          const binding = await readProviderTab(offer.conversationId);
          const tabId = sent?.id === offer.id && sent.conversationId === offer.conversationId
            ? sent.tab : binding?.tab;
          if (Number.isInteger(tabId)) {
            await tabReply(tabId, { type: 'neuraflok-deepseek-complete', id: offer.id, conversationId: offer.conversationId, stop: true, text: '' }, undefined, 5_000);
          }
          await postDeepseekPage(offer, { stopped: true });
        })().catch(() => undefined);
      }
      return;
    }
    deepseekPageFlight = (async () => {
      const fail = async (error) => {
        await postDeepseekPage(offer, { error: String(error || 'DeepSeek page did not answer.').slice(0, 500) });
      };
      try {
        const sent = await readDeepseekSent();
        if (sent && sent.id === offer.id && sent.conversationId === offer.conversationId && Number.isInteger(sent.tab) && !offer.stop) {
          await watchDeepseekReply(
            sent.tab,
            offer,
            typeof sent.before === 'string' ? sent.before : '',
            typeof sent.beforeThink === 'string' ? sent.beforeThink : '',
            '',
            typeof sent.beforeIdentity === 'string' ? sent.beforeIdentity : ''
          );
          return;
        }
        let tab = null;
        let reconnectFresh = false;
        // Never search existing DeepSeek tabs by title. A user message always opens a new
        // tab; only tool rounds on this same turn reuse the tab we just opened.
        const binding = await readProviderTab(offer.conversationId);
        const boundTab = !offer.fresh && binding && Number.isInteger(binding.tab)
          ? await chrome.tabs.get(binding.tab).catch(() => null)
          : null;
        const boundLive = boundTab && Number.isInteger(boundTab.id) && isDeepseekUrl(boundTab.url || boundTab.pendingUrl)
          ? boundTab
          : null;
        if (boundLive) {
          tab = boundLive;
          await writeProviderTab(offer.conversationId, tab.id, 'deepseek');
        } else {
          tab = await openDeepseekTab(offer, background);
          reconnectFresh = true;
        }
        if (!Number.isInteger(tab?.id)) {
          await fail('Sign in to DeepSeek at chat.deepseek.com in the same browser as this app, then send again.');
          return;
        }
        await activeTabs?.set(`provider:${offer.id}`, [tab], candidate =>
          candidate.id === tab.id && isDeepseekUrl(candidate.url));
        let status = await tabReply(tab.id, { type: 'neuraflok-deepseek-status' }, undefined, 8_000).catch(() => null);
        if (!status || typeof status.signedIn !== 'boolean') {
          await restoreDeepseekTab(tab.id);
          status = await tabReply(tab.id, { type: 'neuraflok-deepseek-status' }, undefined, 8_000).catch(() => null);
        }
        const needsFreshChat = offer.fresh === true || reconnectFresh;
        const signed = await waitForSignedSnapshot(tab.id, false);
        if (!signed) throw new Error('DeepSeek did not finish restoring a stable chat. No message was sent.');
        if (signed.signedIn !== true) throw new Error('Sign in to DeepSeek in this browser, then try again.');
        // A blank home screen can still be restoring yesterday's thread and will
        // replace the composer after the send. Open New chat from the page (the
        // content script acknowledges before navigating) and only send once a
        // fresh route has stayed stable long enough for that restoration to end.
        const snapshot = needsFreshChat ? await confirmFreshChatRoute(tab.id) : signed;
        const freshRouteStableMs = Number.isFinite(snapshot?.routeStableMs) ? snapshot.routeStableMs : 0;
        const freshRouteWaitMs = Number.isFinite(snapshot?.routeWaitMs) ? snapshot.routeWaitMs : 0;
        const freshRouteRestored = snapshot?.freshRouteRestored === true;
        const claim = {
          id: offer.id, provider: 'deepseek', conversationId: offer.conversationId, tab: tab.id,
          before: leftoverPaint(signed),
          beforeThink: typeof signed.beforeThink === 'string' ? signed.beforeThink : '',
          beforeIdentity: typeof signed.beforeIdentity === 'string' ? signed.beforeIdentity : '',
          at: Date.now(), phase: 'claimed'
        };
        if (!await writeDeepseekSent(claim)) throw new Error('Could not record the send claim. No message was sent; retry after restarting the extension.');
        let reply;
        try {
          reply = await tabReply(tab.id, {
            type: 'neuraflok-deepseek-complete',
            id: offer.id,
            conversationId: offer.conversationId,
            text: typeof offer.text === 'string' ? offer.text : '',
            stop: offer.stop === true,
            fresh: offer.fresh === true || reconnectFresh,
            openedNewChat: needsFreshChat,
            freshRouteStableMs,
            freshRouteWaitMs,
            freshRouteRestored,
            before: claim.before,
            beforeThink: claim.beforeThink,
            beforeIdentity: claim.beforeIdentity
          }, undefined, DEEPSEEK_SEND_MS);
        } catch (error) {
          if (!isPageTimeout(error)) throw error;
          reply = { pending: true, text: '', generating: false, timedOut: true };
        }
        if (reply?.openedNewChat === true) {
          const fresh = await waitForFreshChatRoute(tab.id);
          if (!fresh || fresh.routeRestored === true) {
            await fail(FRESH_CHAT_ERROR);
            return;
          }
          try {
            reply = await tabReply(tab.id, {
              type: 'neuraflok-deepseek-complete',
              id: offer.id,
              conversationId: offer.conversationId,
              text: typeof offer.text === 'string' ? offer.text : '',
              stop: offer.stop === true,
              fresh: false,
              before: claim.before,
              beforeThink: claim.beforeThink,
              beforeIdentity: claim.beforeIdentity
            }, undefined, DEEPSEEK_SEND_MS);
          } catch (error) {
            if (!isPageTimeout(error)) throw error;
            reply = { pending: true, text: '', generating: false, timedOut: true };
          }
          if (reply?.openedNewChat === true) {
            await fail(FRESH_CHAT_ERROR);
            return;
          }
        }
        const preSendError = reply && typeof reply.error === 'string' ? reply.error.trim() : '';
        if (preSendError && !(typeof reply.text === 'string' && reply.text.trim())
          && reply.pending !== true && reply.generating !== true) {
          // The page agent only returns a plain error when it rejected the send before
          // clicking DeepSeek's Send control. Surface it immediately; waiting for a reply
          // watcher here leaves NeuraFlok in Thinking even though nothing was submitted.
          await fail(preSendError);
          return;
        }
        if (offer.stop) {
          await postDeepseekPage(offer, { stopped: true });
          return;
        }
        const isBootstrap = /Initialize this NEURAFLOK conversation|NEURAFLOK_READY/i.test(String(offer.text || ''));
        const immediate = reply && typeof reply.text === 'string' ? reply.text : '';
        const before = reply && typeof reply.before === 'string' && reply.before ? reply.before : claim.before;
        const beforeThink = reply && typeof reply.beforeThink === 'string' ? reply.beforeThink : claim.beforeThink;
        const folded = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const leftoverRepeat = Boolean(folded(immediate) && folded(immediate) === folded(before));
        const leftoverConversation = /still showed a previous conversation/i.test(String(reply?.error || ''));
        const leftoverRecap = /ya qued[oó] implementado|esto es lo que cambi[oó]|c[oó]mo probarlo|npm run (dev|build)/i.test(immediate)
          && /\.(js|ts|tsx|css|html)\b/i.test(immediate)
          && (
            /This is a conversation only/i.test(String(offer.text || ''))
            || (offer.fresh === true && !folded(before))
          );
        const ackRepeat = isAck(immediate) && isAck(before);
        const staleAck = isAck(immediate) && (!isBootstrap || String(before || '').trim() !== '');
        const planningOnly = looksLikeThink(immediate) && !hasToolCall(immediate) && reply?.generating === true;
        if (leftoverConversation) {
          await fail(reply.error);
          return;
        }
        if (leftoverRecap) {
          await watchDeepseekReply(tab.id, offer, immediate || before, beforeThink, '', claim.beforeIdentity);
          return;
        }
        if (immediate && reply?.pending !== true && reply?.generating !== true && !ackRepeat && !staleAck && !planningOnly && !leftoverRepeat) {
          await postDeepseekPage(offer, { text: immediate });
          return;
        }
        if (reply && typeof reply.error === 'string' && reply.error.trim() && !immediate) {
          await fail(reply.error);
          return;
        }
        await watchDeepseekReply(
          tab.id,
          offer,
          leftoverRepeat ? (before || immediate) : before,
          beforeThink,
          leftoverRepeat ? '' : immediate,
          claim.beforeIdentity
        );
      } catch (error) {
        await fail(error && error.message ? error.message : error);
      }
    })().finally(async () => {
      await activeTabs?.set(`provider:${offer.id}`, []).catch(() => undefined);
      deepseekPageFlight = null;
    });
  }

  return { inspect: inspectDeepseekPage, busy: () => deepseekPageFlight !== null };
}
