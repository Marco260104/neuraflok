export function registerProviderTabLifecycle(chrome, { activeTabs, providerRuntime, maintain = () => undefined }) {
  const onRemoved = tabId => {
    providerRuntime.onTabRemoved(tabId);
    void activeTabs?.navigation(tabId).catch(() => undefined);
  };

  const onUpdated = (tabId, changeInfo, tab) => {
    const documentId = activeTabs?.documentId(tabId);
    if (!documentId || (changeInfo.status !== 'loading' && typeof changeInfo.url !== 'string')) return;
    const sameDocument = typeof changeInfo.url === 'string' && tab.url === changeInfo.url && !tab.pendingUrl
      ? chrome.scripting.executeScript({
        target: { tabId, documentIds: [documentId] },
        injectImmediately: true,
        func: () => location.href
      }).then(results => activeTabs?.documentId(tabId) === documentId &&
        results.some(result => result.frameId === 0 && result.documentId === documentId && result.result === changeInfo.url))
        .catch(() => false)
      : Promise.resolve(false);
    void sameDocument.then(same => activeTabs?.navigation(tabId, same ? tab : null)).catch(() => undefined);
  };

  // Re-check the provider immediately when the user returns to its tab. This
  // makes reconnecting from an already-open DeepSeek page independent of the
  // periodic maintenance alarm and avoids leaving the app in a stale state.
  const onActivated = activeInfo => {
    void chrome.tabs.get(activeInfo?.tabId).then(tab => {
      if (providerRuntime.isProviderUrl(tab?.url || tab?.pendingUrl)) void Promise.resolve(maintain(true)).catch(() => undefined);
    }).catch(() => undefined);
  };

  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onUpdated.addListener(onUpdated);
  chrome.tabs.onActivated.addListener(onActivated);
  return () => {
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    chrome.tabs.onActivated.removeListener(onActivated);
  };
}
