import { isActiveProviderTab, MAX_ACTIVE_PROVIDER_TABS } from './policy.js';

const ACTIVE_TABS_KEY = 'neuraflokActiveTabs';
const LEGACY_ACTIVE_TABS_KEY = 'neuralJamActiveTabs';

export function createActiveTabPersistence(chrome) {
  async function restore() {
    const saved = await chrome.storage.session.get([ACTIVE_TABS_KEY, LEGACY_ACTIVE_TABS_KEY]);
    const stored = Array.isArray(saved[ACTIVE_TABS_KEY]) ? saved[ACTIVE_TABS_KEY] : saved[LEGACY_ACTIVE_TABS_KEY];
    const restored = (Array.isArray(stored) ? stored : []).slice(0, MAX_ACTIVE_PROVIDER_TABS).filter(isActiveProviderTab);
    await chrome.storage.session.set({ [ACTIVE_TABS_KEY]: restored });
    await chrome.storage.session.remove(LEGACY_ACTIVE_TABS_KEY);
    return restored;
  }

  function save(states) {
    const leases = states.filter(state => state.attached || state.failed).map(state => ({
      id: state.id,
      url: state.url,
      attached: state.attached,
      failed: state.failed === true
    }));
    return chrome.storage.session.set({ [ACTIVE_TABS_KEY]: leases });
  }

  return { restore, save };
}
