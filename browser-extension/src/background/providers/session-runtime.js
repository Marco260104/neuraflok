import { createProviderPageExecutor } from './execution/router.js';
import { createProviderTabs } from './provider-catalog.js';
import { deepseekConversationPageUrl } from './deepseek-session.js';
import { createProviderSessionObserver } from './session-observer.js';

export function createProviderRuntime({ chrome, activeTabs, call, tabReply, maintain }) {
  const providerTabs = createProviderTabs(chrome);
  const deepseekPages = new Map();

  const isDeepseekUrl = value => providerTabs.providerForUrl(value) === 'deepseek';
  const restoreProviderTab = (provider, tabId) => providerTabs.restore(provider, tabId);
  const queryProviderTabs = provider => providerTabs.list(provider);
  const waitForTabReady = tabId => providerTabs.waitUntilReady(tabId);

  async function createProviderTab(url, background) {
    return chrome.tabs.create({ url, active: background !== true });
  }

  async function restoreDeepseekTab(tabId) {
    return providerTabs.restore('deepseek', tabId);
  }

  async function reviveDeepseekTab(tabs) {
    const tabId = tabs?.[0]?.id;
    if (!Number.isInteger(tabId)) return null;
    try { await chrome.tabs.reload(tabId); } catch {}
    await waitForTabReady(tabId);
    await restoreDeepseekTab(tabId);
    const current = await queryProviderTabs('deepseek');
    return current.find(providerTabs.usable) || current.find(tab => Number.isInteger(tab?.id)) || null;
  }

  const executor = createProviderPageExecutor({
    chrome,
    activeTabs,
    call,
    tabReply,
    createBrowserTab: createProviderTab,
    queryProviderTabs,
    restoreDeepseekTab,
    restoreProviderTab,
    waitForTabReady,
    isDeepseekUrl,
    usableProviderTab: providerTabs.usable,
    providerPages: providerTabs.catalog
  });

  const observer = createProviderSessionObserver({
    chrome,
    providerTabs,
    deepseekPages,
    reviveDeepseekTab,
    restoreDeepseekTab,
    restoreProviderTab,
    tabReply
  });

  let latestPresence = null;
  let latestPresenceAt = 0;

  async function inspect(preferred = null) {
    latestPresence = await observer.inspect(preferred);
    latestPresenceAt = Date.now();
    return latestPresence;
  }

  async function tabStatus() {
    let active = null;
    try {
      active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;
    } catch {}

    const provider = providerTabs.providerForUrl(active?.url || active?.pendingUrl);
    let page = null;
    let preferred = null;
    if (provider && Number.isInteger(active?.id)) {
      const reply = await tabReply(active.id, { type: providerTabs.pageType(provider, 'status') }).catch(() => null);
      const valid = provider === 'deepseek'
        ? reply && typeof reply.signedIn === 'boolean'
        : reply?.provider === provider && typeof reply.signedIn === 'boolean';
      if (valid) {
        preferred = { provider, tabId: active.id, status: reply };
        page = {
          ...(provider === 'deepseek' ? {} : { provider }),
          signedIn: reply.signedIn,
          generating: reply.generating === true,
          conversationId: providerTabs.conversationId(reply.conversationId, provider)
        };
      }
    }
    const presence = preferred
      ? await inspect(preferred)
      : latestPresence && Date.now() - latestPresenceAt < 2500
        ? latestPresence
        : await inspect();

    return {
      tab: Number.isInteger(active?.id) ? active.id : null,
      isChat: false,
      provider,
      isDeepseek: provider === 'deepseek',
      webProviders: presence,
      url: provider ? String(active?.url || '') : null,
      conversationId: page?.conversationId || null,
      page,
      pending: 0,
      pendingAll: 0,
      pendingCloses: 0,
      pendingCommandAcks: 0
    };
  }

  async function revealConversation(conversationId) {
    const providers = Object.keys(providerTabs.catalog);
    const provider = providers.find(id => providerTabs.conversationId(conversationId, id));
    if (!provider) return false;

    const candidates = await queryProviderTabs(provider);
    let savedTabId = null;
    let savedUrl = null;
    try {
      const rows = (await chrome.storage.local.get('webProviderTabs')).webProviderTabs;
      const row = rows && typeof rows === 'object' ? rows[conversationId] : null;
      if (row?.provider === provider && Number.isInteger(row.tab)) savedTabId = row.tab;
      if (provider === 'deepseek' && row?.provider === provider && typeof row.url === 'string') {
        savedUrl = deepseekConversationPageUrl(row.url);
        if (!savedUrl) return false;
      }
    } catch {}
    if (savedTabId !== null) {
      candidates.sort((left, right) => Number(right.id === savedTabId) - Number(left.id === savedTabId));
    }

    for (const candidate of candidates) {
      if (!providerTabs.usable(candidate)) continue;
      const documentId = activeTabs?.documentId(candidate.id) ?? null;
      const type = providerTabs.pageType(provider, 'status');
      let page = await tabReply(candidate.id, { type }, documentId ? { documentId } : undefined).catch(() => null);
      const providerPage = result => result && typeof result.signedIn === 'boolean' &&
        (provider === 'deepseek' || result.provider === provider);
      if (!providerPage(page) && await restoreProviderTab(provider, candidate.id)) {
        page = await tabReply(candidate.id, { type }, documentId ? { documentId } : undefined).catch(() => null);
      }
      if (!providerPage(page) || page.signedIn !== true || page.conversationId !== conversationId ||
          (activeTabs && activeTabs.documentId(candidate.id) !== documentId)) continue;

      const current = await chrome.tabs.get(candidate.id).catch(() => null);
      if (!current || !providerTabs.usable(current) || !providerTabs.matches(current, provider)) continue;
      try {
        await chrome.tabs.update(candidate.id, { active: true });
        if (Number.isInteger(current.windowId)) await chrome.windows.update(current.windowId, { focused: true });
        return true;
      } catch {}
    }

    // The app can restart while its persistent browser profile still retains
    // the provider's local conversation address. Recreate that exact page
    // instead of leaving the user on the provider home page or reporting a
    // missing session. Never navigate an unrelated live tab to this address.
    if (provider === 'deepseek' && savedUrl) {
      let tab = candidates.find(candidate =>
        providerTabs.usable(candidate) && deepseekConversationPageUrl(candidate.url || candidate.pendingUrl) === savedUrl);
      if (!tab) {
        try {
          tab = await createProviderTab(savedUrl, false);
          if (!Number.isInteger(tab?.id)) return false;
          if (!await waitForTabReady(tab.id)) return false;
          if (!await restoreDeepseekTab(tab.id)) return false;
          tab = await chrome.tabs.get(tab.id).catch(() => null);
        } catch {
          return false;
        }
      }
      if (!tab || !providerTabs.usable(tab) || deepseekConversationPageUrl(tab.url || tab.pendingUrl) !== savedUrl) return false;
      const snapshot = await tabReply(tab.id, { type: 'neuraflok-deepseek-snapshot' }).catch(() => null);
      if (!snapshot || snapshot.signedIn !== true || snapshot.hasConversation !== true ||
          (snapshot.conversationId && snapshot.conversationId !== conversationId)) return false;
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!current || !providerTabs.usable(current) || deepseekConversationPageUrl(current.url || current.pendingUrl) !== savedUrl) return false;
      try {
        const rows = (await chrome.storage.local.get('webProviderTabs')).webProviderTabs;
        await chrome.storage.local.set({ webProviderTabs: {
          ...(rows && typeof rows === 'object' ? rows : {}),
          [conversationId]: { provider, tab: current.id, url: savedUrl, at: Date.now() }
        } });
        await chrome.tabs.update(current.id, { active: true });
        if (Number.isInteger(current.windowId)) await chrome.windows.update(current.windowId, { focused: true });
        return true;
      } catch {}
    }
    return false;
  }

  async function revealConversations(conversationIds) {
    if (!Array.isArray(conversationIds)) return [];
    const results = [];
    for (const conversationId of conversationIds.slice(0, 16)) {
      results.push(await revealConversation(conversationId).catch(() => false));
    }
    return results;
  }

  function onTabRemoved(tabId) {
    deepseekPages.delete(tabId);
  }

  async function restoreOpenPages() {
    for (const provider of Object.keys(providerTabs.catalog)) {
      for (const tab of await providerTabs.list(provider)) {
        if (Number.isInteger(tab.id)) await providerTabs.restore(provider, tab.id);
      }
    }
  }

  const handlers = {
    async open_provider(message) {
      return providerTabs.open(message?.provider);
    },
    tabStatus,
    async 'neuraflok-deepseek-worker-hello'() {
      return { ok: true, version: 1 };
    },
    async 'neuraflok-deepseek-present'(_message, sender) {
      const tab = sender?.tab;
      if (!Number.isInteger(tab?.id) || !isDeepseekUrl(tab.url || tab.pendingUrl)) return { ok: false };
      deepseekPages.set(tab.id, { at: Date.now() });
      void maintain(true).catch(() => undefined);
      return { ok: true };
    },
    async 'neuraflok-provider-present'(message, sender) {
      const tab = sender?.tab;
      const provider = message?.provider;
      if (!Number.isInteger(tab?.id) || !['kimi', 'qwen', 'glm'].includes(provider) ||
          providerTabs.providerForUrl(tab.url || tab.pendingUrl) !== provider) return { ok: false };
      void maintain(true).catch(() => undefined);
      return { ok: true };
    }
  };

  return {
    handlers,
    inspect,
    inspectOffer: (offer, background) => executor.inspect(offer, background),
    isBusy: () => executor.busy(),
    isProviderUrl: value => providerTabs.providerForUrl(value) !== null,
    onTabRemoved,
    restoreOpenPages,
    revealConversations,
    providerForUrl: providerTabs.providerForUrl
  };
}
