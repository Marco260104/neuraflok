/** The integrated browser runs the provider extension inside app-owned Chromium windows. This host owns Electron windows and views; the tab model and API modules handle browser state and extension calls. Background windows stay hidden from the taskbar and dock. */
import { WebContentsView, app, session, shell, type Session, type WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../../../infrastructure/settings/config.js';
import { extensionDir } from '../extension-path.js';
import { logInfo } from '../../../infrastructure/settings/logger.js';
import type { BrowserControl } from './chrome-api/index.js';
import { createIntegratedBrowserControl, type IntegratedBrowserFrame } from './browser-control.js';
import { IntegratedBrowserExtensionBridge } from './extension-worker-bridge.js';
import type { WorkerRegistry } from './extension-worker.js';
import { opensInIntegratedBrowser } from '../../../../contracts/browser/integrated-site-policy.js';
import type { WebProviderId, WebProviderPresenceMap } from '../../../../contracts/web-providers.js';
import { TabModel } from './tabs/model.js';
import { configureIntegratedBrowserSession } from './session-setup.js';
import type { ModelEvent } from './tabs/model-contracts.js';
import { createIntegratedBrowserProviderPages } from './provider-pages.js';
import { createIntegratedBrowserWindowHost, integratedBrowserPageBackground } from './window-host.js';
import { loadFreshIntegratedExtension } from './extension-loading.js';
import { integratedBrowserRendererPage, integratedBrowserRendererUrl } from './renderer-url.js';

const PARTITION = 'persist:neural-jam-browser';

export class IntegratedBrowser {
  private ses: Session | null = null;
  private extensionId = '';
  // Before `control`, which reads it: field initializers run in declaration order.
  private readonly model = new TabModel(event => this.onModelEvent(event));
  private readonly frames = new Map<number, IntegratedBrowserFrame>();
  private readonly views = new Map<number, WebContentsView>();
  private extensionBridge!: IntegratedBrowserExtensionBridge;
  /** The session outlives a stop: its preload and listeners are installed once per process. */
  private configured: Session | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly favicons = new Map<number, string>();
  /** Favicons as data URLs by source URL: the toolbar has no network access of its own. */
  private readonly faviconCache = new Map<string, string | null>();
  private appConnected: boolean | null = null;
  private companionIcon: string | null = null;
  private stopping = false;
  /** Set once the app quits: a window must close then, never hide and hold the quit back. */
  private quitting = false;
  /** Tabs whose debugger the extension itself detached: Chrome reports no onDetach for those. */
  private readonly detaching = new Set<number>();
  private startPromise: Promise<void> | null = null;
  private windowHost!: ReturnType<typeof createIntegratedBrowserWindowHost>;
  private providerPages!: ReturnType<typeof createIntegratedBrowserProviderPages>;
  readonly control: BrowserControl;
  constructor(private readonly assets: {
    preloadDir: string; rendererUrl: () => string | null; rendererDir: string;
    /** The user closed or minimized a shown window: it hides to the tray and goes on running. */
    onUserHide?: () => void;
  }) {
    this.control = createIntegratedBrowserControl({
      model: this.model,
      frames: this.frames,
      views: this.views,
      detaching: this.detaching,
      getSession: () => this.ses,
      createFrame: id => this.windowHost.createFrame(id),
      destroyFrame: id => this.windowHost.destroyFrame(id),
      layout: id => this.windowHost.layout(id),
      showWindow: (id, focus) => this.windowHost.showWindow(id, focus),
      hideWindow: id => this.windowHost.hideWindow(id),
      notify: () => this.notify(),
      wire: contents => this.wire(contents),
      contentsOf: tabId => this.contentsOf(tabId),
      repaintTab: tabId => this.repaintTab(tabId),
      pageBackground: () => integratedBrowserPageBackground()
    });
    this.extensionBridge = new IntegratedBrowserExtensionBridge(this.control);
    this.windowHost = createIntegratedBrowserWindowHost({
      assets: this.assets,
      model: this.model,
      frames: this.frames,
      views: this.views,
      getControl: () => this.control,
      extensionId: () => this.extensionId,
      session: () => this.ses,
      appConnected: () => this.appConnected,
      companionIcon: () => this.companionIcon,
      favicon: tabId => this.favicons.get(tabId) ?? null,
      isStopping: () => this.stopping,
      isQuitting: () => this.quitting,
      loadPage: (contents, file) => this.loadPage(contents, file),
      notify: () => this.notify()
    });
    this.providerPages = createIntegratedBrowserProviderPages({
      model: this.model,
      frames: this.frames,
      views: this.views,
      control: this.control,
      start: () => this.start(),
      showWindow: (id, focus) => this.windowHost.showWindow(id, focus),
      hideWindow: id => this.windowHost.hideWindow(id),
      storageSession: () => this.configured ?? session.fromPartition(PARTITION),
      selectedProvider: () => getConfig().ui.webProvider ?? 'deepseek',
      revealStoredProviderConversation: conversationId => this.extensionBridge.revealProviderConversation(conversationId),
      notify: () => this.notify()
    });
  }

  running(): boolean {
    return this.ses !== null && !this.stopping;
  }

  /** Whether these contents are pages of this browser: they navigate and follow redirects as in any browser (every sign-in is a chain of them), so the app-wide no-navigation guard skips them. */
  browses(contents: WebContents): boolean {
    return this.configured !== null && contents.session === this.configured;
  }

  /** Whether any NEURAFLOK browser window is on screen. */
  visible(): boolean {
    return [...this.frames.values()].some(frame => frame.shown);
  }

  /** The bridge's view of the companion; shown as the dot on the toolbar's companion button. */
  setAppConnected(connected: boolean): void {
    if (this.appConnected === connected) return;
    this.appConnected = connected;
    for (const id of this.frames.keys()) this.windowHost.paintToolbar(id);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Loads the extension into the browser's own session. Idempotent while running. */
  start(): Promise<void> {
    this.startPromise ??= this.boot().catch(error => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  private async boot(): Promise<void> {
    const dir = extensionDir();
    if (!dir) throw new Error('The NEURAFLOK browser needs the bundled extension folder, which is missing from this installation.');
    this.stopping = false;
    const ses = session.fromPartition(PARTITION);
    this.configure(ses);
    this.ses = ses;
    const extension = await loadFreshIntegratedExtension(
      () => ses.clearStorageData({ storages: ['serviceworkers'] }),
      () => ses.extensions.loadExtension(dir)
    );
    this.extensionId = extension.id;
    try { this.companionIcon = `data:image/png;base64,${readFileSync(path.join(dir, 'icons', 'icon32.png')).toString('base64')}`; }
    catch { this.companionIcon = null; }
    this.extensionBridge.connect(ses.serviceWorkers as unknown as WorkerRegistry, extension.id);
    // Chrome tells an extension the browser started; Electron loads it without that event, and the companion first looks for the app on it.
    this.extensionBridge.announceStartup();
    logInfo(`integrated browser: started with extension ${extension.version} from ${dir}`);
    this.notify();
  }

  private configure(ses: Session): void {
    if (this.configured === ses) return;
    this.configured = ses;
    app.once('before-quit', () => { this.quitting = true; });
    configureIntegratedBrowserSession(ses, this.assets.preloadDir,
      (versionId, runningStatus) => this.extensionBridge.statusChanged(versionId, runningStatus), process.env.IETEGRATED_BROWSER_TRACE === '1');
  }

  /** Closes every window and unloads the extension. Chats in it end, as when Chrome quits. */
  stop(): void {
    if (!this.ses) return;
    this.stopping = true;
    for (const id of [...this.frames.keys()]) this.control.closeWindow(id);
    this.windowHost.closePopup();
    this.extensionBridge.close();
    try { if (this.extensionId) this.ses.extensions.removeExtension(this.extensionId); } catch { /* already gone */ }
    this.ses = null;
    this.startPromise = null;
    logInfo('integrated browser: stopped');
    this.notify();
  }

  /** Opens a URL the app chose. `reveal` is for an explicit user action such as "open this chat": the window comes forward. Anything else opens in a background window that stays hidden. */
  async open(url: string, options: { reveal: boolean }): Promise<void> {
    await this.start();
    if (options.reveal) {
      const existing = this.model.query({}).find(tab => tab.url === url || tab.pendingUrl === url);
      if (existing) {
        this.model.activate(existing.id);
        this.windowHost.showWindow(existing.windowId, true);
        return;
      }
      const windowId = this.frames.has(this.model.lastFocusedWindow()) ? this.model.lastFocusedWindow() : null;
      if (windowId === null) this.control.createWindow({ url, focused: true, state: 'normal', type: 'normal' });
      else { this.control.createTab(windowId, url, { active: true }); this.windowHost.showWindow(windowId, true); }
      return;
    }
    this.control.createWindow({ url, focused: false, state: 'minimized', type: 'normal' });
  }

  /** Opens a provider in NEURAFLOK's persistent Chromium profile. The hidden chat path reuses an existing provider tab and never surfaces a window; an explicit connect action may surface it until the page confirms sign-in, then return that same window to the tray. */
  async openProvider(provider: WebProviderId, options: { reveal: boolean; hideAfterSignIn?: boolean }): Promise<void> {
    await this.providerPages.openProvider(provider, options);
  }

  /** Reveals only the provider page whose document still proves the exact local session binding. */
  async revealProviderConversation(provider: WebProviderId, conversationId: string): Promise<boolean> {
    return this.providerPages.revealProviderConversation(provider, conversationId);
  }

  /** Removes one provider's app-owned login state and closes its pages. Chromium documents that origin-scoped clearing also clears cookies for that registrable domain; providers remain isolated because each uses a different site origin. */
  async disconnectProvider(provider: WebProviderId): Promise<void> {
    await this.providerPages.disconnectProvider(provider);
  }

  /** Hides only the connection window that belongs to this provider's completed login. */
  setWebProviderPresence(presence: WebProviderPresenceMap): void {
    this.providerPages.setWebProviderPresence(presence);
  }

  /** Tray "Show browser": restores the last window or opens the selected provider. */
  async show(): Promise<void> {
    await this.providerPages.show();
  }

  /** Shows the selected model's app-owned browser session. */
  async showSelectedProvider(): Promise<void> {
    await this.providerPages.showSelectedProvider();
  }

  /** Tray "Hide browser": every window leaves the screen; its pages keep running. */
  hide(): void {
    for (const id of this.frames.keys()) this.windowHost.hideWindow(id);
  }

  // Model section.

  private onModelEvent(event: ModelEvent): void {
    if (this.stopping) return;
    this.extensionBridge.send(event.name, event.args);
    if (event.name === 'tabs.onActivated') this.windowHost.layout(event.args[0].windowId);
    if (event.name === 'windows.onRemoved') this.windowHost.destroyFrame(event.args[0]);
    const windowId = event.name.startsWith('tabs.') ? this.windowOfEvent(event) : null;
    if (windowId !== null) this.windowHost.paintToolbar(windowId);
  }

  private windowOfEvent(event: ModelEvent): number | null {
    switch (event.name) {
      case 'tabs.onCreated': return event.args[0].windowId;
      case 'tabs.onUpdated': return event.args[2].windowId;
      case 'tabs.onActivated': return event.args[0].windowId;
      case 'tabs.onMoved': return event.args[1].windowId;
      case 'tabs.onAttached': return event.args[1].newWindowId;
      case 'tabs.onDetached': return event.args[1].oldWindowId;
      case 'tabs.onRemoved': return event.args[1].windowId;
      default: return null;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** One of the app's own pages, from the dev server or beside the bundle. */
  private loadPage(contents: WebContents, file: string): void {
    const rendererUrl = this.assets.rendererUrl();
    void (rendererUrl
      ? contents.loadURL(integratedBrowserRendererUrl(rendererUrl, file))
      : contents.loadFile(path.join(this.assets.rendererDir, integratedBrowserRendererPage(file)))).catch(() => undefined);
  }

  /** Toolbar actions, accepted only from this window's own toolbar and for its own tabs. */
  toolbarAction(sender: WebContents, action: string, tabId: unknown): void {
    this.windowHost.toolbarAction(sender, action, tabId);
  }

  // Tabs section.

  private wire(contents: WebContents): void {
    const id = contents.id;
    contents.on('did-start-navigation', details => {
      if (details.isMainFrame && !details.isSameDocument) this.model.navigationStarted(id, details.url);
    });
    contents.on('did-navigate', (_event, url) => this.model.navigationCommitted(id, url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) this.model.sameDocumentNavigated(id, url); });
    contents.on('did-stop-loading', () => this.model.loadingStopped(id));
    contents.on('page-title-updated', (_event, title) => this.model.titleChanged(id, title));
    contents.on('page-favicon-updated', (_event, favicons) => {
      const source = favicons.find(url => /^(https:|data:image\/)/.test(url));
      if (!source) return;
      void this.faviconData(source).then(icon => {
        if (!icon || this.favicons.get(id) === icon || !this.views.has(id)) return;
        this.favicons.set(id, icon);
        this.repaintTab(id);
      });
    });
    // A page that closes itself (window.close) is a closed tab.
    contents.once('destroyed', () => {
      this.views.delete(id);
      this.favicons.delete(id);
      if (!this.stopping) this.model.removeTab(id);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (opensInIntegratedBrowser(url)) {
        // Supported model providers open as tabs of this browser, beside their opener.
        const windowId = this.model.tab(id)?.windowId;
        if (windowId !== undefined) this.control.createTab(windowId, url, { active: true, openerTabId: id });
      } else if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.debugger.on('message', (_event, method, params, sessionId) => {
      this.extensionBridge.send('debugger.onEvent', [{ tabId: id, ...(sessionId ? { sessionId } : {}) }, method, params]);
    });
    contents.debugger.on('detach', (_event, reason) => {
      this.repaintTab(id);
      if (this.detaching.delete(id)) return;
      this.extensionBridge.send('debugger.onDetach', [{ tabId: id }, /closed/i.test(reason) ? 'target_closed' : 'canceled_by_user']);
    });
  }

  /** A page's favicon, fetched with the page's own session and handed to the toolbar inline. */
  private async faviconData(source: string): Promise<string | null> {
    if (source.startsWith('data:image/')) return source.length <= 96 * 1024 ? source : null;
    if (this.faviconCache.has(source)) return this.faviconCache.get(source)!;
    let icon: string | null = null;
    try {
      const response = await this.ses?.fetch(source);
      const type = response?.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (response?.ok && /^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|webp|gif|jpeg)$/.test(type)) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length <= 64 * 1024) icon = `data:${type};base64,${bytes.toString('base64')}`;
      }
    } catch { /* No icon: the tab shows its generic glyph. */ }
    if (this.faviconCache.size >= 64) this.faviconCache.clear();
    this.faviconCache.set(source, icon);
    return icon;
  }

  private repaintTab(tabId: number): void {
    const windowId = this.model.tab(tabId)?.windowId;
    if (windowId !== undefined) this.windowHost.paintToolbar(windowId);
  }

  private contentsOf(tabId: number): WebContents {
    const view = this.views.get(tabId);
    if (!view || view.webContents.isDestroyed()) throw new Error(`No tab with id: ${tabId}.`);
    return view.webContents;
  }

}
