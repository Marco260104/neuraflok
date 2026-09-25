import { NavigationOperations } from './navigation-operations.js';
import { TabReadModel } from './read-model.js';
import { TabModelState } from './runtime-state.js';
import { TabOperations } from './tab-operations.js';
import { WindowOperations } from './window-operations.js';
import type { ChromeTab, ChromeWindow, ModelEvent, TabQuery, WindowState } from './model-contracts.js';

export class TabModel {
  private readonly read: TabReadModel;
  private readonly tabs: TabOperations;
  private readonly windows: WindowOperations;
  private readonly navigation: NavigationOperations;

  constructor(emit: (event: ModelEvent) => void, now: () => number = Date.now) {
    const state = new TabModelState(emit, now);
    this.read = new TabReadModel(state);
    this.tabs = new TabOperations(state, this.read, { dropWindow: id => this.windows.dropWindow(id) });
    this.windows = new WindowOperations(state, this.read, {
      detachTab: (id, isWindowClosing) => this.tabs.detach(id, isWindowClosing),
      activeTab: windowId => this.read.activeTab(windowId)
    });
    this.navigation = new NavigationOperations(state, this.read);
  }

  tab(id: number): ChromeTab | null { return this.read.tab(id); }
  window(id: number, populate = false): ChromeWindow | null { return this.read.window(id, populate); }
  allWindows(populate = false): ChromeWindow[] { return this.read.allWindows(populate); }
  hasTab(id: number): boolean { return this.read.hasTab(id); }
  tabsOf(windowId: number): number[] { return this.read.tabsOf(windowId); }
  activeTab(windowId: number): number | null { return this.read.activeTab(windowId); }
  lastFocusedWindow(): number { return this.read.lastFocusedWindow(); }
  query(query: TabQuery): ChromeTab[] { return this.read.query(query); }
  createWindow(options: { type?: 'normal' | 'popup'; state?: WindowState } = {}): number { return this.windows.createWindow(options); }
  setWindowState(id: number, state: WindowState): void { this.windows.setWindowState(id, state); }
  focusWindow(id: number): void { this.windows.focusWindow(id); }
  removeWindow(id: number): void { this.windows.removeWindow(id); }
  addTab(id: number, windowId: number, options: { url: string; active: boolean; index?: number; openerTabId?: number }): ChromeTab {
    return this.tabs.addTab(id, windowId, options);
  }
  activate(id: number): void { this.tabs.activate(id); }
  move(id: number, windowId: number, index: number): ChromeTab { return this.tabs.move(id, windowId, index); }
  removeTab(id: number): void { this.tabs.removeTab(id); }
  setAutoDiscardable(id: number, value: boolean): void { this.tabs.setAutoDiscardable(id, value); }
  navigationStarted(id: number, url: string): void { this.navigation.navigationStarted(id, url); }
  navigationCommitted(id: number, url: string): void { this.navigation.navigationCommitted(id, url); }
  sameDocumentNavigated(id: number, url: string): void { this.navigation.sameDocumentNavigated(id, url); }
  titleChanged(id: number, title: string): void { this.navigation.titleChanged(id, title); }
  loadingStopped(id: number): void { this.navigation.loadingStopped(id); }
}
