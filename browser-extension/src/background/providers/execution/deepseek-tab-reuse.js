export function createDeepseekTabReuse({
  chrome, queryProviderTabs, usableProviderTab, restoreDeepseekTab, tabReply,
  isDeepseekUrl, readProviderTab, conversationPageUrl
}) {
  return async function reusableFreshTab(offer, background) {
    const listedTabs = await queryProviderTabs('deepseek');
    const candidates = (Array.isArray(listedTabs) ? listedTabs : [])
      .filter(candidate => usableProviderTab(candidate) && Number.isInteger(candidate?.id))
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));
    let savedBoundTab = null;
    let emptyTab = null;
    for (const candidate of candidates) {
      const current = await chrome.tabs.get(candidate.id).catch(() => null);
      if (!current || current.pendingUrl || current.status !== 'complete' || !isDeepseekUrl(current.url)) continue;
      if (await restoreDeepseekTab(candidate.id) === false) continue;
      const status = await tabReply(candidate.id, { type: 'neuraflok-deepseek-status' }).catch(() => null);
      if (!status || status.signedIn !== true || status.generating === true) continue;
      const snapshot = await tabReply(candidate.id, { type: 'neuraflok-deepseek-snapshot' }, undefined, 8_000).catch(() => null);
      if (!snapshot || snapshot.signedIn !== true || snapshot.generating === true) continue;
      const boundConversation = status.conversationId || snapshot.conversationId || null;
      if (!boundConversation) {
        if (snapshot.hasConversation !== true && !emptyTab) emptyTab = { tab: current, rebindSavedConversation: false };
        continue;
      }
      if (boundConversation === offer.conversationId) {
        if (!savedBoundTab) savedBoundTab = { tab: current, rebindSavedConversation: false };
        continue;
      }
      const prior = await readProviderTab(boundConversation);
      const savedUrl = conversationPageUrl(prior?.url);
      if (!savedUrl || conversationPageUrl(current.url) !== savedUrl || snapshot.hasConversation !== true) continue;
      if (!savedBoundTab) savedBoundTab = { tab: current, rebindSavedConversation: true };
    }
    const reusable = savedBoundTab ?? emptyTab;
    if (!reusable) return null;

    // Reusing one verified page avoids creating another tab for each new chat.
    // Do not close the other provider tabs here: an idle tab can be the only tab
    // in its own browser window, and removing it also closes that window while
    // the user is switching chats. Saved conversation URLs remain reopenable.
    if (background !== true) await chrome.tabs.update(reusable.tab.id, { active: true }).catch(() => undefined);
    return reusable;
  };
}
