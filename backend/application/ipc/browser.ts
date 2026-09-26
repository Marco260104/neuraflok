import { shell } from 'electron';
import { z } from 'zod';
import { safeExternalLink } from '../../../contracts/navigation/external-url.js';
import { WEB_PROVIDER_IDS, type WebProviderId } from '../../../contracts/web-providers.js';
import { opensInIntegratedBrowser } from '../../../contracts/browser/integrated-site-policy.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { openInPreferredBrowser } from '../../domains/browser/browser.js';
import { requestBrowserPreferences } from '../../domains/browser/preferences/handshake.js';
import { clearWebProviderStatus, startBridge, webProvidersStatus, unpair, companionDiagnostics } from '../../domains/browser/bridge.js';
import { loadIntegratedBrowser } from '../../domains/browser/embedded/selection.js';
import type { IpcRouteContext } from './types.js';

const allowedSettingsLinks = new Set([
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
]);

async function openAppProvider(provider: WebProviderId, mode: 'connect' | 'activate' = 'connect'): Promise<void> {
  if (!await startBridge()) throw new Error('The browser bridge could not start.');
  const connected = webProvidersStatus()[provider]?.signedIn === true;
  await (await loadIntegratedBrowser()).openProvider(provider, {
    reveal: true,
    hideAfterSignIn: mode === 'connect' && !connected
  });
}

export function registerBrowserIpc({ handle, buildState }: Pick<IpcRouteContext, 'handle' | 'buildState'>): void {
  handle('link:open', async payload => {
    const { url, external } = z.object({ url: z.string().max(8192), external: z.boolean().optional() }).parse(payload);
    if (!allowedSettingsLinks.has(url) && !safeExternalLink(url)) throw new Error('That link is not allowed');
    if (!external && getConfig().ui.chatBrowser === 'integrated' && opensInIntegratedBrowser(url)) await openInPreferredBrowser(url, { reveal: true });
    else await shell.openExternal(url);
    return true;
  });
  handle('web-provider:open', async payload => {
    const { provider, mode } = z.object({
      provider: z.enum(WEB_PROVIDER_IDS),
      mode: z.enum(['connect', 'activate']).default('connect')
    }).strict().parse(payload);
    await openAppProvider(provider, mode);
    return true;
  });
  handle('web-provider:disconnect', async payload => {
    const { provider } = z.object({ provider: z.enum(WEB_PROVIDER_IDS) }).strict().parse(payload);
    await (await loadIntegratedBrowser()).disconnectProvider(provider);
    clearWebProviderStatus(provider);
    return buildState();
  });
  handle('integratedBrowser:show', async () => {
    await (await loadIntegratedBrowser()).showSelectedProvider();
    return true;
  });
  handle('browser:preferences', async payload => requestBrowserPreferences(payload));
  handle('bridge:unpair', async () => {
    await unpair();
    return buildState();
  });

  handle('bridge:diagnostics', async () => companionDiagnostics());
}
