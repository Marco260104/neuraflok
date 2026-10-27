export function createWebProviderPageExecutor({ chrome, activeTabs, call, tabReply, createBrowserTab, queryProviderTabs, restoreProviderTab, waitForTabReady, usableProviderTab, providerPages, state }) {
  const { stoppedProviderOffers, readProviderTab, writeProviderTab, readOtherProviderClaim, writeOtherProviderClaim } = state;
  const providerPageType = (provider, action) => provider === 'deepseek' ? 'neuraflok-deepseek-' + action : 'neuraflok-provider-' + action;
  let otherProviderFlight = null;
  const PROVIDER_REPLY_TIMEOUT = 'The provider did not finish this reply. Check its browser tab and try again.';
  
  async function settleOtherProviderPage(offer, body) {
    const result = await call('/provider/page', {
      method: 'POST',
      body: JSON.stringify({ ...body, id: offer.id, provider: offer.provider, conversationId: offer.conversationId })
    });
    if (result.ok && result.data?.ok === true) {
      const claim = await readOtherProviderClaim();
      if (claim?.id === offer.id) await writeOtherProviderClaim(null);
      return true;
    }
    return false;
  }
  
  async function watchOtherProviderReply(tabId, offer, before, initial = '') {
    let lastText = typeof initial === 'string' ? initial : '';
    let reportedText = '';
    let emptyIdle = 0;
    let stableText = '';
    let stableIdle = 0;
    let lastProgressAt = 0;
    let deadline = Date.now() + 540_000;
    while (Date.now() < deadline) {
      if (stoppedProviderOffers.has(offer.id)) {
        stoppedProviderOffers.delete(offer.id);
        await settleOtherProviderPage(offer, { stopped: true });
        return;
      }
      const snap = await tabReply(tabId, {
        type: providerPageType(offer.provider, 'read'), before, sent: offer.text
      }, undefined, 8_000);
      if (snap && snap.provider === offer.provider && snap.conversationId !== offer.conversationId) {
        await settleOtherProviderPage(offer, { error: 'The provider page changed sessions while answering. The result was discarded.' });
        return;
      }
      const text = snap && typeof snap.text === 'string' ? snap.text : '';
      if (text) lastText = text;
      if (lastText && snap && snap.generating !== true) {
        await settleOtherProviderPage(offer, { text: lastText });
        return;
      }
      if (snap && snap.generating === true) {
        deadline = Date.now() + 540_000;
        if (lastText !== reportedText || Date.now() - lastProgressAt > 15_000) {
          reportedText = lastText;
          lastProgressAt = Date.now();
          void call('/provider/page/progress', {
            method: 'POST',
            body: JSON.stringify({ id: offer.id, provider: offer.provider, conversationId: offer.conversationId, text: lastText, generating: true })
          }).catch(() => undefined);
        }
        if (lastText && lastText === stableText) {
          stableIdle += 1;
          if (stableIdle >= 15) {
            await settleOtherProviderPage(offer, { text: lastText });
            return;
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
        if (++emptyIdle >= 180) {
          await settleOtherProviderPage(offer, { error: PROVIDER_REPLY_TIMEOUT });
          return;
        }
      } else emptyIdle = 0;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    await settleOtherProviderPage(offer, lastText ? { text: lastText } : { error: PROVIDER_REPLY_TIMEOUT });
  }
  
  function inspectOtherProviderPage(offer, background) {
    if (!offer || typeof offer.id !== 'string' || !['kimi', 'qwen', 'glm'].includes(offer.provider) ||
        typeof offer.conversationId !== 'string') return;
    if (otherProviderFlight) {
      if (offer.stop === true) {
        stoppedProviderOffers.add(offer.id);
        void (async () => {
          const claim = await readOtherProviderClaim();
          const binding = await readProviderTab(offer.conversationId, offer.provider);
          const tabId = claim?.id === offer.id && claim.conversationId === offer.conversationId ? claim.tab : binding?.tab;
          if (Number.isInteger(tabId)) await tabReply(tabId, {
            type: providerPageType(offer.provider, 'complete'), provider: offer.provider,
            id: offer.id, conversationId: offer.conversationId, stop: true
          }, undefined, 5_000);
          await settleOtherProviderPage(offer, { stopped: true });
        })().catch(() => undefined);
      }
      return;
    }
    let activeTabId = null;
    otherProviderFlight = (async () => {
      const fail = (error) => settleOtherProviderPage(offer, { error: String(error || 'The provider page did not answer.').slice(0, 500) });
      try {
        let claim = await readOtherProviderClaim();
        if (claim?.id === offer.id && claim.provider === offer.provider && claim.conversationId === offer.conversationId) {
          await watchOtherProviderReply(claim.tab, offer, claim.before || '', '');
          return;
        }
        let tab;
        const candidates = await queryProviderTabs(offer.provider);
        const readyCandidate = candidates.find(usableProviderTab) || candidates[0] || null;
        if (offer.fresh === true && offer.stop !== true) {
          if (readyCandidate) {
            tab = readyCandidate;
            await writeProviderTab(offer.conversationId, tab.id, offer.provider);
            await restoreProviderTab(offer.provider, tab.id);
          } else {
            tab = await createBrowserTab(providerPages[offer.provider].url, background === true);
            if (!Number.isInteger(tab?.id)) throw new Error(`Could not open ${offer.provider.toUpperCase()} in this browser.`);
            if (!await writeProviderTab(offer.conversationId, tab.id, offer.provider)) throw new Error('Could not reserve this provider tab for the local session.');
            await waitForTabReady(tab.id);
            await restoreProviderTab(offer.provider, tab.id);
          }
        } else {
          const binding = await readProviderTab(offer.conversationId, offer.provider);
          if (!binding) throw new Error(`This ${offer.provider.toUpperCase()} session has no verified browser tab. Start a new chat to reconnect safely.`);
          tab = await chrome.tabs.get(binding.tab).catch(() => null);
          if (!tab || providerForPageUrl(tab.url || tab.pendingUrl) !== offer.provider) {
            const candidates = await queryProviderTabs(offer.provider);
            tab = null;
            for (const candidate of candidates) {
              const page = await tabReply(candidate.id, { type: providerPageType(offer.provider, 'status') }).catch(() => null);
              if (page?.provider === offer.provider && page.conversationId === offer.conversationId) { tab = candidate; break; }
            }
            if (!tab) throw new Error(`The ${offer.provider.toUpperCase()} page assigned to this session is no longer available. Start a new chat to reconnect safely.`);
            await writeProviderTab(offer.conversationId, tab.id, offer.provider);
          }
          if (tab.discarded === true || tab.frozen === true || tab.status === 'loading') {
            try { await chrome.tabs.reload(tab.id); } catch {}
            await waitForTabReady(tab.id);
            await restoreProviderTab(offer.provider, tab.id);
          }
        }
        if (offer.fresh !== true && await restoreProviderTab(offer.provider, tab.id) === false) {
          throw new Error(`Could not refresh the ${offer.provider.toUpperCase()} chat controls. Reload the provider page and retry.`);
        }
        const statusType = providerPageType(offer.provider, 'status');
        let status = await tabReply(tab.id, { type: statusType });
        if (!status || status.provider !== offer.provider || typeof status.signedIn !== 'boolean') {
          await restoreProviderTab(offer.provider, tab.id);
          status = await tabReply(tab.id, { type: statusType });
        }
        if (!status || status.provider !== offer.provider || status.signedIn !== true) {
          throw new Error(`Sign in to ${offer.provider.toUpperCase()} in this browser, then send again.`);
        }
        if (offer.fresh !== true && status.conversationId !== offer.conversationId) {
          throw new Error(`This page no longer belongs to the selected ${offer.provider.toUpperCase()} session. Start a new chat to reconnect safely.`);
        }
        const snapshot = await tabReply(tab.id, { type: providerPageType(offer.provider, 'snapshot') }, undefined, 8_000);
        if (!snapshot || snapshot.provider !== offer.provider || snapshot.signedIn !== true) throw new Error('Could not verify the provider composer. No message was sent.');
        const allowedHosts = providerPages[offer.provider]?.hosts || [];
        await activeTabs?.set(`provider:${offer.id}`, [tab], candidate => {
          try { return allowedHosts.includes(new URL(candidate.url).hostname); } catch { return false; }
        });
        activeTabId = tab.id;
        claim = {
          id: offer.id, provider: offer.provider, conversationId: offer.conversationId, tab: tab.id,
          before: typeof snapshot.before === 'string' ? snapshot.before : '', at: Date.now(), phase: 'claimed'
        };
        if (!await writeOtherProviderClaim(claim)) throw new Error('Could not record the send claim. No message was sent.');
        const reply = await tabReply(tab.id, {
          type: providerPageType(offer.provider, 'complete'), provider: offer.provider,
          id: offer.id, conversationId: offer.conversationId,
          text: typeof offer.text === 'string' ? offer.text : '',
          stop: offer.stop === true, fresh: offer.fresh === true,
          before: claim.before, beforeThink: ''
        }, undefined, 100_000);
        if (offer.stop) { await settleOtherProviderPage(offer, { stopped: true }); return; }
        if (reply && typeof reply.error === 'string' && reply.error.trim()) { await fail(reply.error); return; }
        if (!reply) { await fail('Provider page did not answer.'); return; }
        const text = typeof reply.text === 'string' ? reply.text : '';
        if (text && reply.pending !== true && reply.generating !== true) { await settleOtherProviderPage(offer, { text }); return; }
        await watchOtherProviderReply(tab.id, offer, claim.before, text);
      } catch (error) {
        await fail(error && error.message ? error.message : error);
      }
    })().finally(async () => {
      if (Number.isInteger(activeTabId)) await activeTabs?.set(`provider:${offer.id}`, []).catch(() => undefined);
      otherProviderFlight = null;
    });
  }
  return { inspect: inspectOtherProviderPage, busy: () => otherProviderFlight !== null };
}
