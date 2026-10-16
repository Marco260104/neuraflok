import { providerForUrl } from '../../providers/provider-catalog.js';

export const MAX_ACTIVE_PROVIDER_TABS = 64;

export function isActiveProviderTab(tab) {
  return Number.isInteger(tab?.id) && tab.id > 0 && typeof tab.url === 'string' &&
    tab.url.length <= 4096 && providerForUrl(tab.url) !== null && !tab.pendingUrl;
}
