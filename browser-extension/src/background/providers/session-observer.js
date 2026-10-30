export function createProviderSessionObserver({ chrome, providerTabs, deepseekPages, reviveDeepseekTab, restoreDeepseekTab, restoreProviderTab, tabReply }) {
  async function readStatus(tabId, provider, preferred) {
    if (preferred?.provider === provider && preferred.tabId === tabId && preferred.status !== undefined) return preferred.status;
    try {
      return await tabReply(tabId, { type: providerTabs.pageType(provider, 'status') }, undefined, 5000);
    } catch {
      return null;
    }
  }

  async function inspectDeepseek(preferred) {
    let tabs;
    try {
      tabs = await providerTabs.list('deepseek');
    } catch {
      return null;
    }
    let ready = tabs.filter(providerTabs.usable);
    // The active provider tab is the one the user just reopened after a
    // reconnect. Inspect it before older project/chat tabs: an unresponsive
    // background tab must not delay restoring the visible connection state.
    ready.sort((left, right) => {
      const leftPriority = left.id === preferred?.tabId ? 2 : left.active === true ? 1 : 0;
      const rightPriority = right.id === preferred?.tabId ? 2 : right.active === true ? 1 : 0;
      return rightPriority - leftPriority;
    });
    if (!ready.length && tabs.length) {
      try {
        const revived = await reviveDeepseekTab(tabs);
        tabs = await providerTabs.list('deepseek');
        ready = tabs.filter(providerTabs.usable);
        if (!ready.length && revived) ready = [revived];
      } catch {}
    }

    let selected = null;
    let signedIn = null;
    let signedOut = null;
    let unknown = null;
    const statuses = new Map();
    for (const tab of ready) {
      let status = await readStatus(tab.id, 'deepseek', preferred);
      if (typeof status?.signedIn !== 'boolean') {
        try {
          await restoreDeepseekTab(tab.id);
          status = await readStatus(tab.id, 'deepseek', preferred);
        } catch {}
      }
      statuses.set(tab.id, status);
      if (status?.signedIn === true) {
        selected = tab;
        signedIn = true;
        deepseekPages.set(tab.id, { at: Date.now() });
        break;
      }
      if (status?.signedIn === false) signedOut ||= tab;
      else unknown ||= tab;
    }
    selected ||= unknown || signedOut || ready[0] || null;
    const selectedStatus = selected ? statuses.get(selected.id) : null;
    if (signedIn !== true && typeof selectedStatus?.signedIn === 'boolean') signedIn = selectedStatus.signedIn;

    let open = tabs.length > 0;
    if (!selected) {
      const now = Date.now();
      const recent = [...deepseekPages.entries()]
        .filter(([, row]) => now - row.at >= 0 && now - row.at < 120_000)
        .sort((left, right) => right[1].at - left[1].at)[0];
      if (recent) {
        const [announcedTabId] = recent;
        const tab = await chrome.tabs.get(announcedTabId).catch(() => null);
        const valid = providerTabs.usable(tab) && tab.id === announcedTabId &&
          providerTabs.providerForUrl(tab.url || tab.pendingUrl) === 'deepseek';
        if (!valid) {
          deepseekPages.delete(announcedTabId);
        } else {
          selected = tab;
          open = true;
          const status = await readStatus(announcedTabId, 'deepseek', preferred);
          if (typeof status?.signedIn === 'boolean') signedIn = status.signedIn;
        }
      }
    }
    return { open, signedIn, tabId: selected?.id ?? null };
  }

  async function inspectProvider(provider, preferred) {
    let tabs;
    try {
      tabs = await providerTabs.list(provider);
    } catch {
      return { open: false, signedIn: null, tabId: null };
    }
    const candidates = tabs.filter(candidate => !candidate.incognito && providerTabs.usable(candidate));
    candidates.sort((left, right) => {
      const leftPriority = left.id === preferred?.tabId && preferred.provider === provider ? 2 : left.active === true ? 1 : 0;
      const rightPriority = right.id === preferred?.tabId && preferred.provider === provider ? 2 : right.active === true ? 1 : 0;
      return rightPriority - leftPriority;
    });
    const tab = candidates[0] || null;
    let status = tab ? await readStatus(tab.id, provider, preferred) : null;
    if (tab && (status?.provider !== provider || typeof status.signedIn !== 'boolean')) {
      try {
        await restoreProviderTab(provider, tab.id);
        status = await readStatus(tab.id, provider, preferred);
      } catch {}
    }
    const signedIn = status?.provider === provider && typeof status.signedIn === 'boolean'
      ? status.signedIn
      : null;
    return { open: tabs.length > 0, signedIn, tabId: tab?.id ?? null };
  }

  return {
    async inspect(preferred = null) {
      const result = {};
      const deepseek = await inspectDeepseek(preferred);
      if (deepseek) result.deepseek = deepseek;
      for (const provider of ['kimi', 'qwen', 'glm']) result[provider] = await inspectProvider(provider, preferred);
      return result;
    }
  };
}
