import { createDeepseekSessionResolver } from '../deepseek-session.js';

export function createDeepseekPageExecutor({ chrome, activeTabs, call, tabReply, createBrowserTab, queryProviderTabs, restoreDeepseekTab, waitForTabReady, isDeepseekUrl, usableProviderTab, state }) {
  const { stoppedProviderOffers, readDeepseekSent, writeDeepseekSent, readProviderTab, writeProviderTab } = state;
  let deepseekPageFlight = null;
  const DEEPSEEK_SEND_MS = 100_000;
  const DEEPSEEK_READ_MS = 8_000;
  const DEEPSEEK_WATCH_MS = 540_000;
  const DEEPSEEK_POLL_MS = 2_000;
  const DEEPSEEK_TIMEOUT = 'DeepSeek did not finish this reply in time. Sign in at chat.deepseek.com in the same browser as this app, then send again.';
  const sessionPages = createDeepseekSessionResolver({
    chrome, tabReply, createBrowserTab, queryProviderTabs, restoreDeepseekTab,
    waitForTabReady, isDeepseekUrl, usableProviderTab, state
  });
  const { conversationPageUrl, rememberConversationPage, resolveExistingDeepseekTab } = sessionPages;

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

  function isAck(text) {
    return /^(NEURAFLOK_READY|NEURAL_JAM_READY)$/.test(String(text || '').trim());
  }

  function hasToolCall(text) {
    return /```(?:neuraflok-tool|json)\b/i.test(text) || /<(?:exec_command|read|apply_patch)\b/i.test(text);
  }

  function looksLikeThink(text) {
    return /^(Let me|Let's|We need|I will|I'll |The user |Need to |Must not |Pensado|Pensó|Detenido|Voy a |Vamos a |Déjame |Dejame |Necesito |Debo |Hay que )\b/i.test(String(text || '').replace(/\s+/g, ' ').trim());
  }

  function quietNeed(text) {
    if (isAck(text)) return 1;
    if (String(text || '').trim().length < 80) return 6;
    return 3;
  }

  async function watchDeepseekReply(tabId, offer, before, beforeThink, initial) {
    let lastText = typeof initial === 'string' ? initial : '';
    let reportedText = '';
    let emptyIdle = 0;
    let stableText = '';
    let stableIdle = 0;
    let quietText = '';
    let quietIdle = 0;
    let lastProgressAt = 0;
    let completeText = isAck(lastText) && !isAck(before) ? lastText : '';
    let deadline = Date.now() + DEEPSEEK_WATCH_MS;
    while (Date.now() < deadline) {
      if (stoppedProviderOffers.has(offer.id)) {
        stoppedProviderOffers.delete(offer.id);
        await postDeepseekPage(offer, { stopped: true });
        return;
      }
      const snap = await tabReply(tabId, {
        type: 'neuraflok-deepseek-read',
        before,
        beforeThink
      }, undefined, DEEPSEEK_READ_MS);
      const think = snap && typeof snap.think === 'string' ? snap.think : '';
      let publicAnswer = snap && typeof snap.answer === 'string' ? snap.answer : '';
      if (isAck(publicAnswer) && String(before || '').trim()) publicAnswer = '';
      if (looksLikeThink(publicAnswer) && !hasToolCall(publicAnswer)) publicAnswer = '';
      if (think && publicAnswer && publicAnswer.replace(/\s+/g, ' ').trim() === think.replace(/\s+/g, ' ').trim()) publicAnswer = '';
      if (think && publicAnswer && publicAnswer.includes(think.trim()) && publicAnswer.length <= think.trim().length + 40) publicAnswer = '';
      const text = publicAnswer || (snap && typeof snap.text === 'string' ? snap.text : '');
      if (text) lastText = text;
      completeText = publicAnswer || (isAck(lastText) && !isAck(before) ? lastText : '');
      if (completeText && snap && snap.generating !== true) {
        if (completeText === quietText) {
          quietIdle += 1;
          if (quietIdle >= quietNeed(completeText)) {
            const posted = await postDeepseekPage(offer, { text: completeText }, tabId);
            if (posted) return;
          }
        } else {
          quietText = completeText;
          quietIdle = 0;
        }
      } else {
        quietText = completeText;
        quietIdle = 0;
      }
      if (snap && snap.generating === true) {
        deadline = Date.now() + DEEPSEEK_WATCH_MS;
        if (lastText !== reportedText || Date.now() - lastProgressAt > 15_000) {
          reportedText = lastText;
          lastProgressAt = Date.now();
          void call('/provider/page/progress', {
            method: 'POST',
            body: JSON.stringify({ id: offer.id, provider: 'deepseek', conversationId: offer.conversationId, text: lastText, generating: true })
          }).catch(() => undefined);
        }
        if (completeText && completeText === stableText) {
          stableIdle += 1;
          if (stableIdle >= 15) {
            const posted = await postDeepseekPage(offer, { text: completeText }, tabId);
            if (posted) return;
          }
        } else {
          stableText = completeText;
          stableIdle = 0;
        }
      } else if (!completeText && lastText && isAck(lastText) && !isAck(before)) {
        if (lastText === stableText) {
          stableIdle += 1;
          if (stableIdle >= 15) {
            const posted = await postDeepseekPage(offer, { text: lastText }, tabId);
            if (posted) return;
          }
        } else {
          stableText = lastText;
          stableIdle = 0;
        }
      } else {
        stableText = lastText;
        stableIdle = 0;
      }
      if (snap && snap.generating !== true && !lastText) {
        emptyIdle += 1;
        if (emptyIdle >= 4) {
          const fallback = await tabReply(tabId, { type: 'neuraflok-deepseek-snapshot' }, undefined, 4_000).catch(() => null);
          const ans = fallback && typeof fallback.before === 'string' ? fallback.before : '';
          if (ans && ans !== before && !(isAck(ans) && isAck(before))) {
            lastText = ans;
            const posted = await postDeepseekPage(offer, { text: lastText }, tabId);
            if (posted) return;
          }
        }
        if (emptyIdle >= 180) {
          await postDeepseekPage(offer, { error: DEEPSEEK_TIMEOUT });
          return;
        }
      } else emptyIdle = 0;
      await new Promise(resolve => setTimeout(resolve, DEEPSEEK_POLL_MS));
    }
    if (completeText) await postDeepseekPage(offer, { text: completeText }, tabId);
    else await postDeepseekPage(offer, { error: DEEPSEEK_TIMEOUT });
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
            ''
          );
          return;
        }
        let tab = null;
        let binding = null;
        let savedUrl = null;
        if (offer.fresh === true && !offer.stop) {
          tab = await createBrowserTab('https://chat.deepseek.com/', background === true);
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
        await activeTabs?.set(`provider:${offer.id}`, [tab], candidate =>
          candidate.id === tab.id && isDeepseekUrl(candidate.url));
        const status = await tabReply(tab.id, { type: 'neuraflok-deepseek-status' });
        if (!status || typeof status.signedIn !== 'boolean') await restoreDeepseekTab(tab.id);
        const snapshot = await tabReply(tab.id, { type: 'neuraflok-deepseek-snapshot' }, undefined, DEEPSEEK_READ_MS);
        if (!snapshot || snapshot.signedIn !== true) throw new Error('Sign in to DeepSeek in this browser, then try again.');
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
          before: claim.before,
          beforeThink: claim.beforeThink
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
        const ackRepeat = isAck(immediate) && isAck(before);
        const staleAck = isAck(immediate) && String(before || '').trim() !== '';
        const planningOnly = looksLikeThink(immediate) && !hasToolCall(immediate);
        if (immediate && reply.pending !== true && !ackRepeat && !staleAck && !planningOnly) {
          await postDeepseekPage(offer, { text: immediate }, tab.id);
          return;
        }
        if (!reply) {
          await fail('DeepSeek page did not answer.');
          return;
        }
        if (immediate && reply.generating !== true && !ackRepeat && !staleAck && reply.pending !== true && !planningOnly) {
          await postDeepseekPage(offer, { text: immediate }, tab.id);
          return;
        }
        await watchDeepseekReply(tab.id, offer, before, beforeThink, immediate);
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
