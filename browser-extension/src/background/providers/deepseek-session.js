export function createDeepseekSessionResolver({
  chrome, tabReply, createBrowserTab, queryProviderTabs, restoreDeepseekTab,
  waitForTabReady, isDeepseekUrl, usableProviderTab, state
}) {
  const { readProviderTab, writeProviderTab } = state;
  const READ_MS = 8_000;

  function conversationPageUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' || url.hostname !== 'chat.deepseek.com' || url.port ||
          !/^\/a\/chat\/s\/[^/]+\/?$/.test(url.pathname)) return null;
      url.search = '';
      url.hash = '';
      return url.href.replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  async function rememberConversationPage(offer, tabId) {
    if (!Number.isInteger(tabId)) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = conversationPageUrl(tab?.url);
    if (url) await writeProviderTab(offer.conversationId, tabId, 'deepseek', url);
  }

  async function readStatus(tabId) {
    return tabReply(tabId, { type: 'neuraflok-deepseek-status' }, undefined, READ_MS).catch(() => null);
  }

  async function findBoundTab(candidates, conversationId) {
    for (const candidate of candidates) {
      if (!usableProviderTab(candidate) || !Number.isInteger(candidate?.id)) continue;
      const status = await readStatus(candidate.id);
      if (status?.conversationId === conversationId) return candidate;
    }
    return null;
  }

  async function openConversationPage(url, background) {
    const created = await createBrowserTab(url, background === true);
    if (!Number.isInteger(created?.id)) throw new Error('Could not reopen the saved DeepSeek conversation. No message was sent.');
    await waitForTabReady(created.id);
    await restoreDeepseekTab(created.id);
    const tab = await chrome.tabs.get(created.id).catch(() => null);
    if (!tab || !isDeepseekUrl(tab.url || tab.pendingUrl) || conversationPageUrl(tab.url || tab.pendingUrl) !== url ||
        tab.pendingUrl || tab.status !== 'complete') {
      throw new Error('The saved DeepSeek conversation did not finish loading. No message was sent.');
    }
    return tab;
  }

  async function navigateConversationPage(tab, url) {
    await chrome.tabs.update(tab.id, { url });
    await waitForTabReady(tab.id);
    await restoreDeepseekTab(tab.id);
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current || !isDeepseekUrl(current.url || current.pendingUrl) || conversationPageUrl(current.url || current.pendingUrl) !== url ||
        current.pendingUrl || current.status !== 'complete') {
      throw new Error('The saved DeepSeek conversation did not finish loading. No message was sent.');
    }
    return current;
  }

  async function resolveExistingDeepseekTab(offer, background) {
    const binding = await readProviderTab(offer.conversationId);
    const savedUrl = binding?.url ? conversationPageUrl(binding.url) : null;
    if (binding?.url && !savedUrl) throw new Error('The saved DeepSeek conversation address is invalid. No message was sent.');

    let tab = Number.isInteger(binding?.tab) ? await chrome.tabs.get(binding.tab).catch(() => null) : null;
    if (tab && !isDeepseekUrl(tab.url || tab.pendingUrl)) tab = null;
    if (tab && savedUrl && conversationPageUrl(tab.url || tab.pendingUrl) !== savedUrl) {
      tab = await navigateConversationPage(tab, savedUrl);
    }
    if (tab && !savedUrl) {
      const status = await readStatus(tab.id);
      if (status?.conversationId && status.conversationId !== offer.conversationId) {
        tab = await findBoundTab(await queryProviderTabs('deepseek'), offer.conversationId);
      }
    }

    if (!tab) {
      const candidates = await queryProviderTabs('deepseek');
      tab = await findBoundTab(candidates, offer.conversationId);
      if (tab) {
        if (savedUrl && conversationPageUrl(tab.url || tab.pendingUrl) !== savedUrl) {
          tab = await navigateConversationPage(tab, savedUrl);
        }
        const url = savedUrl || conversationPageUrl(tab.url || tab.pendingUrl);
        await writeProviderTab(offer.conversationId, tab.id, 'deepseek', url);
      } else if (savedUrl) {
        tab = await openConversationPage(savedUrl, background);
      }
    }

    if (!tab) {
      throw new Error('The saved DeepSeek page for this chat is unavailable. No message was sent, so its context was not replaced.');
    }
    await writeProviderTab(offer.conversationId, tab.id, 'deepseek', savedUrl || conversationPageUrl(tab.url || tab.pendingUrl));
    return { tab, binding, savedUrl };
  }

  return { conversationPageUrl, rememberConversationPage, resolveExistingDeepseekTab };
}
