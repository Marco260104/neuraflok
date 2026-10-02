const DEEPSEEK_SENT_KEY = 'deepseekPageSent';
const PROVIDER_TABS_KEY = 'webProviderTabs';
const OTHER_PROVIDER_CLAIM_KEY = 'webProviderPageSent';

export function createProviderPageState(chrome) {
  const stoppedProviderOffers = new Set();
  async function readDeepseekSent() {
    try {
      const stored = (await chrome.storage.session.get(DEEPSEEK_SENT_KEY))[DEEPSEEK_SENT_KEY];
      if (!stored || typeof stored !== 'object') return null;
      if (typeof stored.id !== 'string' || !Number.isInteger(stored.tab)) return null;
      return stored;
    } catch {
      return null;
    }
  }
  
  async function writeDeepseekSent(value) {
    try {
      if (!value) await chrome.storage.session.remove(DEEPSEEK_SENT_KEY);
      else await chrome.storage.session.set({ [DEEPSEEK_SENT_KEY]: value });
      return true;
    } catch { return false; }
  }
  
  async function readProviderTab(conversationId, provider = 'deepseek') {
    if (typeof conversationId !== 'string') return null;
    try {
      const rows = (await chrome.storage.local.get(PROVIDER_TABS_KEY))[PROVIDER_TABS_KEY];
      const row = rows && typeof rows === 'object' ? rows[conversationId] : null;
      return row && row.provider === provider && Number.isInteger(row.tab) ? row : null;
    } catch { return null; }
  }
  
  async function writeProviderTab(conversationId, tabId, provider = 'deepseek') {
    if (typeof conversationId !== 'string' || !Number.isInteger(tabId)) return false;
    try {
      const rows = (await chrome.storage.local.get(PROVIDER_TABS_KEY))[PROVIDER_TABS_KEY];
      const next = rows && typeof rows === 'object' ? { ...rows } : {};
      next[conversationId] = { provider, tab: tabId, at: Date.now() };
      const recent = Object.entries(next).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 2000);
      await chrome.storage.local.set({ [PROVIDER_TABS_KEY]: Object.fromEntries(recent) });
      return true;
    } catch { return false; }
  }
  async function readOtherProviderClaim() {
    try {
      const value = (await chrome.storage.session.get(OTHER_PROVIDER_CLAIM_KEY))[OTHER_PROVIDER_CLAIM_KEY];
      return value && typeof value.id === 'string' && typeof value.conversationId === 'string' &&
        ['kimi', 'qwen', 'glm'].includes(value.provider) && Number.isInteger(value.tab) ? value : null;
    } catch { return null; }
  }
  
  async function writeOtherProviderClaim(value) {
    try {
      if (value) await chrome.storage.session.set({ [OTHER_PROVIDER_CLAIM_KEY]: value });
      else await chrome.storage.session.remove(OTHER_PROVIDER_CLAIM_KEY);
      return true;
    } catch { return false; }
  }
  return {
    stoppedProviderOffers,
    readDeepseekSent,
    writeDeepseekSent,
    readProviderTab,
    writeProviderTab,
    readOtherProviderClaim,
    writeOtherProviderClaim
  };
}
