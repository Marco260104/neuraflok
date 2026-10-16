import { WebContentsView, type BaseWindow, type Session, type WebContents } from 'electron';
import type { BrowserControl, DebuggerTarget } from './chrome-api/index.js';
import type { TabModel } from './tabs/model.js';
import type { WindowState } from './tabs/model-contracts.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';

export interface IntegratedBrowserFrame {
  id: number;
  base: BaseWindow;
  toolbar: WebContentsView;
  shown: boolean;
  overlay: string;
}

interface IntegratedBrowserControlHost {
  model: TabModel;
  frames: Map<number, IntegratedBrowserFrame>;
  views: Map<number, WebContentsView>;
  detaching: Set<number>;
  getSession(): Session | null;
  createFrame(id: number): IntegratedBrowserFrame;
  destroyFrame(id: number): void;
  layout(id: number): void;
  showWindow(id: number, focus: boolean): void;
  hideWindow(id: number): void;
  notify(): void;
  wire(contents: WebContents): void;
  contentsOf(tabId: number): WebContents;
  repaintTab(tabId: number): void;
  pageBackground(): string;
}

function loadable(url: string): boolean {
  if (url === 'about:blank') return true;
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
}

export function createIntegratedBrowserControl(host: IntegratedBrowserControlHost): BrowserControl {
  let control!: BrowserControl;
  control = {
    model: host.model,

    createWindow: ({ url, focused, state, type }) => {
      const id = host.model.createWindow({ type, state: focused ? (state === 'minimized' ? 'normal' : state) : 'minimized' });
      host.createFrame(id);
      if (url !== undefined) control.createTab(id, url, { active: true });
      if (focused) host.showWindow(id, true);
      host.notify();
      return id;
    },

    createTab: (windowId, requested, options) => {
      if (!loadable(requested)) logWarn(`integrated browser: refused to open a ${requested.split(':')[0]!.slice(0, 20)}: URL in a tab`);
      const url = loadable(requested) ? requested : 'about:blank';
      const frame = host.frames.get(windowId);
      const ses = host.getSession();
      if (!frame || !ses) throw new Error(`No window with id: ${windowId}.`);
      const view = new WebContentsView({
        webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
      });
      view.setBackgroundColor(host.pageBackground());
      const id = view.webContents.id;
      host.views.set(id, view);
      host.wire(view.webContents);
      frame.base.contentView.addChildView(view);
      host.model.addTab(id, windowId, { url, ...options });
      host.layout(windowId);
      void view.webContents.loadURL(url).catch(() => undefined);
      return id;
    },

    navigate: (tabId, url) => {
      if (!loadable(url)) return logWarn(`integrated browser: refused to navigate a tab to a ${url.split(':')[0]!.slice(0, 20)}: URL`);
      void host.contentsOf(tabId).loadURL(url).catch(() => undefined);
    },

    reload: (tabId, bypassCache) => {
      const contents = host.contentsOf(tabId);
      if (bypassCache) contents.reloadIgnoringCache(); else contents.reload();
    },

    activate: tabId => host.model.activate(tabId),

    closeTab: tabId => {
      const view = host.views.get(tabId);
      const windowId = host.model.tab(tabId)?.windowId;
      if (view && windowId !== undefined) host.frames.get(windowId)?.base.contentView.removeChildView(view);
      host.views.delete(tabId);
      host.model.removeTab(tabId);
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    },

    moveTab: (tabId, windowId, index) => {
      const view = host.views.get(tabId);
      const from = host.model.tab(tabId)?.windowId;
      const target = host.frames.get(windowId);
      if (!view || from === undefined || !target) throw new Error(`No tab with id: ${tabId}.`);
      if (from !== windowId) {
        host.frames.get(from)?.base.contentView.removeChildView(view);
        target.base.contentView.addChildView(view);
      }
      host.model.move(tabId, windowId, index);
      host.layout(windowId);
      if (from !== windowId) host.layout(from);
    },

    closeWindow: windowId => {
      const tabs = host.model.tabsOf(windowId);
      host.model.removeWindow(windowId);
      for (const tabId of tabs) {
        const view = host.views.get(tabId);
        host.views.delete(tabId);
        if (view && !view.webContents.isDestroyed()) view.webContents.close();
      }
      host.destroyFrame(windowId);
    },

    presentWindow: (windowId, change: { state?: WindowState; focused?: boolean }) => {
      const frame = host.frames.get(windowId);
      if (!frame) return;
      if (change.state === 'minimized') { host.hideWindow(windowId); return; }
      if (change.state === 'maximized') frame.base.maximize();
      if (change.state === 'fullscreen') frame.base.setFullScreen(true);
      if (change.state === 'normal' && frame.base.isMaximized()) frame.base.unmaximize();
      if (change.state !== undefined || change.focused === true) host.showWindow(windowId, change.focused === true);
    },

    debuggerAttach: async (tabId, version) => {
      const contents = host.contentsOf(tabId);
      if (contents.debugger.isAttached()) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      host.detaching.delete(tabId);
      contents.debugger.attach(version);
      host.repaintTab(tabId);
    },

    debuggerDetach: async tabId => {
      const contents = host.contentsOf(tabId);
      if (!contents.debugger.isAttached()) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
      host.detaching.add(tabId);
      contents.debugger.detach();
    },

    debuggerSend: async (tabId, method, params, sessionId) => {
      const contents = host.contentsOf(tabId);
      if (!contents.debugger.isAttached()) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
      return contents.debugger.sendCommand(method, params, sessionId);
    },

    debuggerTargets: (): DebuggerTarget[] => host.model.query({}).map(tab => ({
      type: 'page', id: String(tab.id), tabId: tab.id, title: tab.title, url: tab.url,
      attached: host.views.get(tab.id)?.webContents.debugger.isAttached() === true
    }))
  };
  return control;
}
