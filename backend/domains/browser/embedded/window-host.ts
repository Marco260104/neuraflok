import { BaseWindow, BrowserWindow, WebContentsView, shell, type Session, type WebContents } from 'electron';
import path from 'node:path';
import { defaultAppearance } from '../../../../contracts/appearance-settings.js';
import { paletteTokens } from '../../../../contracts/appearance-tokens.js';
import type { IntegratedBrowserToolbarState } from '../../../../contracts/browser/integrated-browser-toolbar.js';
import { getConfig } from '../../../infrastructure/settings/config.js';
import type { BrowserControl } from './chrome-api/index.js';
import type { IntegratedBrowserFrame } from './browser-control.js';
import { WINDOW_ID_NONE } from './tabs/model-contracts.js';
import type { TabModel } from './tabs/model.js';
import { INTEGRATED_BROWSER_FALLBACK_SIZE, INTEGRATED_BROWSER_TOOLBAR_HEIGHT, paintedTabBounds } from './tab-paint.js';

const UI_PARTITION = 'integrated-browser-ui';
const TOOLBAR_HEIGHT = INTEGRATED_BROWSER_TOOLBAR_HEIGHT;
const WINDOW_CONTROLS = process.platform === 'darwin' ? { left: 78, right: 8 } : { left: 8, right: 138 };

interface Assets {
  preloadDir: string;
  rendererUrl: () => string | null;
  rendererDir: string;
  onUserHide?: () => void;
}

interface Runtime {
  assets: Assets;
  model: TabModel;
  frames: Map<number, IntegratedBrowserFrame>;
  views: Map<number, WebContentsView>;
  getControl(): BrowserControl;
  extensionId(): string;
  session(): Session | null;
  appConnected(): boolean | null;
  companionIcon(): string | null;
  favicon(tabId: number): string | null;
  isStopping(): boolean;
  isQuitting(): boolean;
  loadPage(contents: WebContents, file: string): void;
  notify(): void;
}

function themeTokens(surface: 'sidebar' | 'background'): Record<string, string> {
  const ui = getConfig().ui;
  const palette = (ui.appearance ?? defaultAppearance())[ui.theme === 'light' ? 'light' : 'dark'];
  return paletteTokens(palette[surface], palette.accent, palette.contrast);
}

export function integratedBrowserPageBackground(): string {
  return themeTokens('background')['--page']!;
}

export function createIntegratedBrowserWindowHost(runtime: Runtime) {
  const { assets, model, frames, views } = runtime;
  let popup: BrowserWindow | null = null;

  function paintToolbar(id: number): void {
    const frame = frames.get(id);
    if (!frame || frame.toolbar.webContents.isDestroyed()) return;
    const activeId = model.activeTab(id);
    const tabs = model.tabsOf(id).map(tabId => {
      const tab = model.tab(tabId)!;
      return {
        id: tab.id, title: tab.title || tab.pendingUrl || tab.url || 'New tab', url: tab.url || tab.pendingUrl || '',
        favicon: runtime.favicon(tabId), active: tab.active, loading: tab.status === 'loading',
        working: views.get(tabId)?.webContents.debugger.isAttached() === true
      };
    });
    const history = activeId === null ? null : views.get(activeId)?.webContents.navigationHistory;
    const tokens = themeTokens('sidebar');
    const state: IntegratedBrowserToolbarState = {
      tabs,
      navigation: {
        back: history?.canGoBack() === true, forward: history?.canGoForward() === true,
        loading: tabs.find(tab => tab.active)?.loading === true
      },
      connected: runtime.appConnected(), companionIcon: runtime.companionIcon(), tokens, insets: WINDOW_CONTROLS
    };
    frame.toolbar.webContents.send('integrated-browser:state', state);
    if (frame.base.isDestroyed()) return;
    const active = tabs.find(tab => tab.active);
    frame.base.setTitle(active ? `${active.title} — NEURAFLOK browser` : 'NEURAFLOK browser');
    if (process.platform !== 'darwin' && frame.overlay !== tokens['--page']) {
      frame.overlay = tokens['--page']!;
      frame.base.setTitleBarOverlay({ color: tokens['--page']!, symbolColor: tokens['--ink']!, height: TOOLBAR_HEIGHT });
    }
  }

  function createFrame(id: number): IntegratedBrowserFrame {
    const tokens = themeTokens('sidebar');
    const base = new BaseWindow({
      width: INTEGRATED_BROWSER_FALLBACK_SIZE.width, height: INTEGRATED_BROWSER_FALLBACK_SIZE.height, minWidth: 480, minHeight: 360, show: false, title: 'NEURAFLOK browser',
      backgroundColor: tokens['--page'], titleBarStyle: 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 14, y: 13 } }
        : { titleBarOverlay: { color: tokens['--page']!, symbolColor: tokens['--ink']!, height: TOOLBAR_HEIGHT } })
    });
    if (process.platform !== 'darwin') base.removeMenu();
    const toolbar = new WebContentsView({
      webPreferences: {
        partition: UI_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: path.join(assets.preloadDir, 'integrated-browser.js')
      }
    });
    toolbar.setBackgroundColor(tokens['--page']!);
    toolbar.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    toolbar.webContents.on('will-navigate', event => event.preventDefault());
    toolbar.webContents.on('did-finish-load', () => paintToolbar(id));
    base.contentView.addChildView(toolbar);
    const frame: IntegratedBrowserFrame = { id, base, toolbar, shown: false, overlay: tokens['--page']! };
    frames.set(id, frame);
    runtime.loadPage(toolbar.webContents, 'integrated-browser.html');
    base.on('resize', () => layout(id));
    base.on('focus', () => model.focusWindow(id));
    base.on('blur', () => {
      if (![...frames.values()].some(other => other.base.isFocused())) model.focusWindow(WINDOW_ID_NONE);
    });
    base.on('close', event => {
      if (runtime.isStopping() || runtime.isQuitting()) return;
      event.preventDefault();
      userHide(id);
    });
    base.on('minimize', () => userHide(id));
    layout(id);
    return frame;
  }

  function destroyFrame(id: number): void {
    const frame = frames.get(id);
    if (!frame) return;
    frames.delete(id);
    frame.toolbar.webContents.close();
    if (!frame.base.isDestroyed()) frame.base.destroy();
    runtime.notify();
  }

  function showWindow(id: number, focus: boolean): void {
    const frame = frames.get(id);
    if (!frame) return;
    if (frame.base.isMinimized()) frame.base.restore();
    if (focus) frame.base.show(); else frame.base.showInactive();
    if (focus) {
      frame.base.focus();
      const active = model.activeTab(id);
      if (active !== null) views.get(active)?.webContents.focus();
    }
    frame.shown = true;
    model.setWindowState(id, frame.base.isMaximized() ? 'maximized' : 'normal');
    layout(id);
    runtime.notify();
  }

  function userHide(id: number): void {
    const frame = frames.get(id);
    const shown = frame !== undefined && (frame.shown || frame.base.isVisible());
    hideWindow(id);
    if (shown) assets.onUserHide?.();
  }

  function hideWindow(id: number): void {
    const frame = frames.get(id);
    if (!frame || (!frame.shown && !frame.base.isVisible())) return;
    frame.base.hide();
    frame.shown = false;
    model.setWindowState(id, 'minimized');
    if (frame.base.isFocused() || model.lastFocusedWindow() === id) model.focusWindow(WINDOW_ID_NONE);
    runtime.notify();
  }

  function layout(id: number): void {
    const frame = frames.get(id);
    if (!frame || frame.base.isDestroyed()) return;
    const { width, height } = frame.base.getContentBounds();
    const page = paintedTabBounds(width, height);
    frame.toolbar.setBounds({ x: 0, y: 0, width: page.width, height: TOOLBAR_HEIGHT });
    const active = model.activeTab(id);
    const activeView = active !== null ? views.get(active) : undefined;
    for (const tabId of model.tabsOf(id)) {
      const view = views.get(tabId);
      if (!view) continue;
      view.setBounds(page);
      // Keep background pages at a real size so their virtualized chat DOM
      // stays mounted, but never paint them over the selected tab.
      view.setVisible(tabId === active);
    }
    if (activeView) frame.base.contentView.addChildView(activeView);
  }

  function toolbarAction(sender: WebContents, action: string, tabId: unknown): void {
    const frame = [...frames.values()].find(candidate => candidate.toolbar.webContents === sender);
    if (!frame) return;
    if (action === 'extension') { openExtensionPopup(frame); return; }
    if (typeof tabId !== 'number' || model.tab(tabId)?.windowId !== frame.id) return;
    if (action === 'activate') model.activate(tabId);
    else if (action === 'close') runtime.getControl().closeTab(tabId);
    else if (action === 'reload') runtime.getControl().reload(tabId, false);
    else if (action === 'stop') views.get(tabId)?.webContents.stop();
    else if (action === 'back') views.get(tabId)?.webContents.navigationHistory.goBack();
    else if (action === 'forward') views.get(tabId)?.webContents.navigationHistory.goForward();
  }

  function openExtensionPopup(frame: IntegratedBrowserFrame): void {
    const ses = runtime.session();
    const extensionId = runtime.extensionId();
    if (!ses || !extensionId) return;
    popup?.destroy();
    const bounds = frame.base.getContentBounds();
    const nextPopup = new BrowserWindow({
      parent: frame.base, x: bounds.x + bounds.width - 396, y: bounds.y + TOOLBAR_HEIGHT, width: 380, height: 540,
      frame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, show: false,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    popup = nextPopup;
    nextPopup.on('blur', () => { if (!nextPopup.isDestroyed()) nextPopup.destroy(); });
    nextPopup.on('closed', () => { if (popup === nextPopup) popup = null; });
    nextPopup.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
    nextPopup.webContents.on('will-navigate', event => event.preventDefault());
    nextPopup.webContents.on('will-redirect', event => event.preventDefault());
    nextPopup.once('ready-to-show', () => nextPopup.show());
    void nextPopup.loadURL(`chrome-extension://${extensionId}/src/popup/index.html`).catch(() => undefined);
  }

  function closePopup(): void {
    popup?.destroy();
    popup = null;
  }

  return { createFrame, destroyFrame, showWindow, hideWindow, layout, paintToolbar, toolbarAction, closePopup };
}
