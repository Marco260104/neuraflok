import type { BrowserPreferences } from "../../../contracts/browser/preferences.js";
import type { AppState, CompanionDiagnostics } from "../../../contracts/types.js";
import type { WebProviderId } from "../../../contracts/web-providers.js";
import { call } from "./shared.js";

export function createBrowserApi() {
  return {
    openLink: (url: string, options: { external?: boolean } = {}) => call<boolean>('link:open', { url, ...(options.external ? { external: true } : {}) }),
    showIntegratedBrowser: () => call<boolean>('integratedBrowser:show'),
    openWebProvider: (provider: WebProviderId, mode: 'connect' | 'activate' = 'connect') =>
      call<boolean>('web-provider:open', { provider, mode }),
    disconnectWebProvider: (provider: WebProviderId) =>
      call<AppState>('web-provider:disconnect', { provider }),
    browserPreferences: (patch: Partial<BrowserPreferences> = {}) => call<BrowserPreferences>('browser:preferences', patch),
    companionDiagnostics: () => call<CompanionDiagnostics | null>('bridge:diagnostics'),
    unpairExtension: () => call<AppState>('bridge:unpair')
  };
}
