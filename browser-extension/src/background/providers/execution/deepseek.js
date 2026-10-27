import { createDeepseekSessionResolver } from '../deepseek-session.js';
import { createDeepseekReplyWatcher, hasDeepseekToolCall, isDeepseekAck, looksLikeDeepseekThink } from './deepseek-reply-watch.js';

export function createDeepseekPageExecutor({ chrome, activeTabs, call, tabReply, createBrowserTab, queryProviderTabs, restoreDeepseekTab, waitForTabReady, isDeepseekUrl, usableProviderTab, state, replyWatchTimings = {} }) {
  const { stoppedProviderOffers, readDeepseekSent, writeDeepseekSent, readProviderTab, writeProviderTab } = state;
  let deepseekPageFlight = null;
  const DEEPSEEK_SEND_MS = 100_000;
  const DEEPSEEK_READ_MS = 8_000;
  const DEEPSEEK_READY_MS = 20_000;
  const DEEPSEEK_READY_POLL_MS = 250;
  const sessionPages = createDeepseekSessionResolver({
    chrome, tabReply, createBrowserTab, queryProviderTabs, restoreDeepseekTab,
    waitForTabReady, isDeepseekUrl, usableProviderTab, state
  });
  const { conversationPageUrl, rememberConversationPage, resolveExistingDeepseekTab } = sessionPages;

  async function reusableFreshTab(offer, background) {
    if (background !== true) return null;
    const candidates = (await queryProviderTabs('deepseek'))
      .filter(candidate => usableProviderTab(candidate) && Number.isInteger(candidate?.id))
      .sort((left, right) => (left.lastAccessed ?? 0) - (right.lastAccessed ?? 0));
    let savedBoundTab = null;
    for (const candidate of candidates) {
      const current = await chrome.tabs.get(candidate.id).catch(() => null);
      if (!current || current.pendingUrl || current.status !== 'complete' || !isDeepseekUrl(current.url)) continue;
      if (await restoreDeepseekTab(candidate.id) === false) continue;
      const status = await tabReply(candidate.id, { type: 'neuraflok-deepseek-status' }).catch(() => null);
      if (!status || status.signedIn !== true || status.generating === true) continue;
      const snapshot = await tabReply(candidate.id, { type: 'neuraflok-deepseek-snapshot' }, undefined, DEEPSEEK_READ_MS).catch(() => null);
      if (!snapshot || snapshot.signedIn !== true || snapshot.generating === true) continue;
      const boundConversation = status.conversationId || snapshot.conversationId || null;
      if (!boundConversation) {
        if (snapshot.hasConversation !== true) return { tab: current, rebindSavedConversation: false };
        continue;
      }
      if (boundConversation === offer.conversationId) {
        return { tab: current, rebindSavedConversation: false };
      }
      const prior = await readProviderTab(boundConversation);
      const savedUrl = conversationPageUrl(prior?.url);
      if (!savedUrl || conversationPageUrl(current.url) !== savedUrl || snapshot.hasConversation !== true) continue;
      if (!savedBoundTab) savedBoundTab = { tab: current, rebindSavedConversation: true };
    }
    return savedBoundTab;
  }

  async function postDeepseekPage(offer, body, tabId) {
    if (!offer || typeof offer.id !== 'string' || typeof offer.conversationId !== 'string') return false;
    if (typeof body.text === 'string' && body.text.trim()) await rememberConversationPage(offer, tabId);
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

  const watchDeepseekReply = createDeepseekReplyWatcher({
    stoppedProviderOffers, call, tabReply, postDeepseekPage, timings: replyWatchTimings
  });

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
        let binding = null;
        let savedUrl = null;
        let rebindSavedConversation = false;
        if (offer.fresh === true && !offer.stop) {
          const reusable = await reusableFreshTab(offer, background);
          if (reusable) {
            tab = reusable.tab;
            rebindSavedConversation = reusable.rebindSavedConversation;
          } else {
            tab = await createBrowserTab('https://chat.deepseek.com/', background === true);
          }
          if (Number.isInteger(tab?.id)) {
            if (!await writeProviderTab(offer.conversationId, tab.id)) throw new Error('Could not reserve this DeepSeek tab for the local session.');
            await waitForTabReady(tab.id);
            await restoreDeepseekTab(tab.id);
            tab = await chrome.tabs.get(tab.id);
            if (!isDeepseekUrl(tab.url) || tab.pendingUrl || tab.status !== 'complete') {
              throw new Error('The new DeepSeek page did not finish loading. No message was sent.');
            }
          }
        } else {
          const resolved = await resolveExistingDeepseekTab(offer, background);
          tab = resolved.tab;
          binding = resolved.binding;
          savedUrl = resolved.savedUrl;
          if (tab.discarded === true || tab.frozen === true || tab.status === 'loading') {
            try { await chrome.tabs.reload(tab.id); } catch {}
            await waitForTabReady(tab.id);
            await restoreDeepseekTab(tab.id);
            tab = await chrome.tabs.get(tab.id).catch(() => null);
            if (!tab || !isDeepseekUrl(tab.url || tab.pendingUrl)) {
              throw new Error('The assigned DeepSeek tab changed while waking. No message was sent.');
            }
          }
        }
        if (!Number.isInteger(tab?.id)) {
          await fail('Sign in to DeepSeek at chat.deepseek.com in the same browser as this app, then send again.');
          return;
        }
        if (offer.fresh !== true && await restoreDeepseekTab(tab.id) === false) {
          throw new Error('Could not refresh the DeepSeek chat controls. Reload the provider page and retry.');
        }
        await activeTabs?.set(`provider:${offer.id}`, [tab], candidate =>
          candidate.id === tab.id && isDeepseekUrl(candidate.url));
        const status = await tabReply(tab.id, { type: 'neuraflok-deepseek-status' });
        if (!status || typeof status.signedIn !== 'boolean') await restoreDeepseekTab(tab.id);
        let snapshot = await tabReply(tab.id, { type: 'neuraflok-deepseek-snapshot' }, undefined, DEEPSEEK_READ_MS);
        // `tabs.onUpdated(status: complete)` can fire before DeepSeek finishes
        // restoring its signed-in workspace. Do not turn that short hydration
        // window into a false sign-in error; wait for the page adapter to see
        // the chat controls before deciding that this browser is disconnected.
        if (!snapshot || snapshot.signedIn !== true) {
          const readyUntil = Date.now() + DEEPSEEK_READY_MS;
          while (Date.now() < readyUntil) {
            await new Promise(resolve => setTimeout(resolve, DEEPSEEK_READY_POLL_MS));
            snapshot = await tabReply(tab.id, { type: 'neuraflok-deepseek-snapshot' }, undefined,
              Math.min(DEEPSEEK_READ_MS, 2_000)).catch(() => null);
            if (snapshot?.signedIn === true) break;
          }
        }
        if (!snapshot || snapshot.signedIn !== true) {
          const diagnostics = snapshot?.diagnostics;
          const safeSummary = diagnostics && typeof diagnostics === 'object'
            ? JSON.stringify(diagnostics).slice(0, 350)
            : `status=${String(status?.signedIn ?? 'missing')}; snapshot=${String(snapshot?.signedIn ?? 'missing')}`;
          throw new Error(`Sign in to DeepSeek in this browser, then try again. [diagnostic ${safeSummary}]`);
        }
        if (offer.fresh !== true && snapshot.conversationId && snapshot.conversationId !== offer.conversationId) {
          const savedPageMatches = savedUrl && conversationPageUrl(tab.url || tab.pendingUrl) === savedUrl && snapshot.hasConversation === true;
          if (!savedPageMatches) throw new Error('DEEPSEEK_CONTEXT_UNAVAILABLE: The page no longer belongs to this DeepSeek session. No message was sent.');
        }
        if (offer.fresh !== true) {
          const currentUrl = conversationPageUrl(tab.url || tab.pendingUrl);
          const savedPageMatches = Boolean(savedUrl && currentUrl === savedUrl);
          const legacyMappedPage = !snapshot.conversationId && binding?.tab === tab.id && Boolean(currentUrl);
          const pageIsBoundToChat = snapshot.conversationId === offer.conversationId || savedPageMatches || legacyMappedPage;
          if (!snapshot.hasConversation || !pageIsBoundToChat) {
            throw new Error('DEEPSEEK_CONTEXT_UNAVAILABLE: The saved DeepSeek page no longer contains this chat history. No message was sent.');
          }
          await writeProviderTab(offer.conversationId, tab.id, 'deepseek', currentUrl);
        }
        const claim = {
          id: offer.id, provider: 'deepseek', conversationId: offer.conversationId, tab: tab.id,
          before: typeof snapshot.before === 'string' ? snapshot.before : '',
          beforeThink: typeof snapshot.beforeThink === 'string' ? snapshot.beforeThink : '',
          beforeIdentity: typeof snapshot.beforeIdentity === 'string' ? snapshot.beforeIdentity : '',
          at: Date.now(), phase: 'claimed'
        };
        if (!await writeDeepseekSent(claim)) throw new Error('Could not record the send claim. No message was sent; retry after restarting the extension.');
        const reply = await tabReply(tab.id, {
          type: 'neuraflok-deepseek-complete',
          id: offer.id,
          conversationId: offer.conversationId,
          text: typeof offer.text === 'string' ? offer.text : '',
          stop: offer.stop === true,
          fresh: offer.fresh === true,
          ...(rebindSavedConversation ? { rebindSavedConversation: true } : {}),
          before: claim.before,
          beforeThink: claim.beforeThink,
          beforeIdentity: claim.beforeIdentity
        }, undefined, DEEPSEEK_SEND_MS);
        if (offer.stop) {
          await postDeepseekPage(offer, { stopped: true });
          return;
        }
        if (reply && typeof reply.error === 'string' && reply.error.trim()) {
          await fail(reply.error);
          return;
        }
        const immediate = reply && typeof reply.text === 'string' ? reply.text : '';
        const before = claim.before;
        const beforeThink = claim.beforeThink;
        const beforeIdentity = claim.beforeIdentity;
        const answerIdentity = typeof reply?.answerIdentity === 'string' ? reply.answerIdentity : '';
        const normalized = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const sameAsPrior = normalized(immediate) === normalized(before) || normalized(immediate) === normalized(offer.text);
        const beforePage = /^node:([^:]+):/.exec(beforeIdentity)?.[1] || '';
        const answerPage = /^node:([^:]+):/.exec(answerIdentity)?.[1] || '';
        const newAssistantMessage = Boolean(beforeIdentity && answerIdentity && beforeIdentity !== answerIdentity &&
          (!(beforePage || answerPage) || (beforePage && answerPage && beforePage === answerPage)));
        const staleAnswer = sameAsPrior && !newAssistantMessage;
        const ackRepeat = isDeepseekAck(immediate) && isDeepseekAck(before);
        const staleAck = isDeepseekAck(immediate) && String(before || '').trim() !== '';
        const planningOnly = looksLikeDeepseekThink(immediate) && !hasDeepseekToolCall(immediate);
        if (immediate && reply.pending !== true && reply.continueAvailable !== true && !staleAnswer && !ackRepeat && !staleAck && !planningOnly) {
          await postDeepseekPage(offer, { text: immediate }, tab.id);
          return;
        }
        if (!reply) {
          await fail('DeepSeek page did not answer.');
          return;
        }
        if (immediate && reply.generating !== true && reply.continueAvailable !== true && !staleAnswer && !ackRepeat && !staleAck && reply.pending !== true && !planningOnly) {
          await postDeepseekPage(offer, { text: immediate }, tab.id);
          return;
        }
        await watchDeepseekReply(tab.id, offer, before, beforeThink, immediate, beforeIdentity);
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
