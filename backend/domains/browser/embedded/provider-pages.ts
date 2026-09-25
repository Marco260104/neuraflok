import type { Session, WebContentsView } from 'electron';
import { WEB_PROVIDERS, providerForConversationId, webProviderForUrl, type WebProviderId, type WebProviderPresenceMap } from '../../../../contracts/web-providers.js';
import type { BrowserControl } from './chrome-api/index.js';
import type { IntegratedBrowserFrame } from './browser-control.js';
import type { TabModel } from './tabs/model.js';

interface Runtime {
  model: TabModel;
  frames: Map<number, IntegratedBrowserFrame>;
  views: Map<number, WebContentsView>;
  control: BrowserControl;
  start(): Promise<void>;
  showWindow(id: number, focus: boolean): void;
  hideWindow(id: number): void;
  storageSession(): Session;
  selectedProvider(): WebProviderId;
  notify(): void;
}

// Owns provider sign-in windows and reveals only pages bound to their provider conversation.
export function createIntegratedBrowserProviderPages(runtime: Runtime) {
  const providerSignInWindows = new Map<WebProviderId, number>();

  async function openProvider(provider: WebProviderId, options: { reveal: boolean; hideAfterSignIn?: boolean }): Promise<void> {
    await runtime.start();
    const tab = runtime.model.query({}).find(candidate =>
      webProviderForUrl(candidate.url || candidate.pendingUrl || '') === provider);
    let windowId: number;
    if (tab) {
      windowId = tab.windowId;
      runtime.model.activate(tab.id);
      if (options.reveal) runtime.showWindow(windowId, true);
    } else {
      windowId = runtime.control.createWindow({
        url: WEB_PROVIDERS[provider].chatUrl,
        focused: options.reveal,
        state: options.reveal ? 'normal' : 'minimized',
        type: 'normal'
      });
    }
    if (options.hideAfterSignIn === true) providerSignInWindows.set(provider, windowId);
    else providerSignInWindows.delete(provider);
  }

  async function revealProviderConversation(provider: WebProviderId, conversationId: string): Promise<boolean> {
    if (providerForConversationId(conversationId) !== provider) return false;
    await runtime.start();
    const sessionKey = provider === 'deepseek' ? 'neuraflok.providerSession' : `neuraflok.session.${provider}`;
    const legacyKey = provider === 'deepseek' ? 'neuraljam.providerSession' : `neuraljam.session.${provider}`;
    const readBinding = `(() => { try { const value = sessionStorage.getItem(${JSON.stringify(sessionKey)}); return value === null ? sessionStorage.getItem(${JSON.stringify(legacyKey)}) : value; } catch { return null; } })()`;
    for (const tab of runtime.model.query({})) {
      if (tab.pendingUrl || tab.status !== 'complete' || webProviderForUrl(tab.url) !== provider) continue;
      const contents = runtime.views.get(tab.id)?.webContents;
      if (!contents || contents.isDestroyed()) continue;
      let binding: unknown;
      try { binding = await contents.executeJavaScript(readBinding, true); } catch { continue; }
      if (binding !== conversationId) continue;
      const current = runtime.model.tab(tab.id);
      if (!current || current.pendingUrl || current.status !== 'complete' || webProviderForUrl(current.url) !== provider) continue;
      runtime.model.activate(tab.id);
      runtime.showWindow(current.windowId, true);
      return true;
    }
    return false;
  }

  async function disconnectProvider(provider: WebProviderId): Promise<void> {
    const tabs = runtime.model.query({}).filter(tab =>
      webProviderForUrl(tab.url || tab.pendingUrl || '') === provider);
    for (const tab of tabs) runtime.control.closeTab(tab.id);
    providerSignInWindows.delete(provider);
    const ses = runtime.storageSession();
    await Promise.all(WEB_PROVIDERS[provider].hostnames.map(host =>
      ses.clearStorageData({ origin: `https://${host}` })));
    runtime.notify();
  }

  function setWebProviderPresence(presence: WebProviderPresenceMap): void {
    for (const [provider, windowId] of providerSignInWindows) {
      if (presence[provider]?.signedIn !== true) continue;
      providerSignInWindows.delete(provider);
      runtime.hideWindow(windowId);
    }
  }

  async function show(): Promise<void> {
    await runtime.start();
    const focused = runtime.model.lastFocusedWindow();
    const windowId = runtime.frames.has(focused) ? focused : [...runtime.frames.keys()].at(-1);
    if (windowId === undefined) await openProvider(runtime.selectedProvider(), { reveal: true });
    else runtime.showWindow(windowId, true);
  }

  async function showSelectedProvider(): Promise<void> {
    await openProvider(runtime.selectedProvider(), { reveal: true });
  }

  return { openProvider, revealProviderConversation, disconnectProvider, setWebProviderPresence, show, showSelectedProvider };
}
