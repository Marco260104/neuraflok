export function registerProviderTabLifecycle(chrome, { activeTabs, providerRuntime }) {
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

  chrome.tabs.onRemoved.addListener(onRemoved);
  chrome.tabs.onUpdated.addListener(onUpdated);
  return () => {
    chrome.tabs.onRemoved.removeListener(onRemoved);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
}
