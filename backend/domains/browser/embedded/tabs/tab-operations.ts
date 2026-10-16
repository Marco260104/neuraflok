import { publishTabUpdate } from './events.js';
import { TabReadModel } from './read-model.js';
import { TabModelState } from './runtime-state.js';
import type { ChromeTab } from './model-contracts.js';

export interface TabOperationHooks {
  dropWindow(id: number): void;
}

export class TabOperations {
  constructor(private readonly state: TabModelState, private readonly read: TabReadModel, private readonly hooks: TabOperationHooks) {}

  addTab(id: number, windowId: number, options: { url: string; active: boolean; index?: number; openerTabId?: number }): ChromeTab {
    const window = this.state.windows.get(windowId);
    if (!window) throw new Error(`No window with id: ${windowId}.`);
    if (this.state.tabs.has(id)) throw new Error(`Tab ${id} already exists.`);
    this.state.tabs.set(id, {
      id, windowId, active: false, autoDiscardable: true, url: '', pendingUrl: options.url, title: '',
      status: 'loading', lastAccessed: this.state.now(),
      ...(options.openerTabId === undefined ? {} : { openerTabId: options.openerTabId })
    });
    window.tabs.splice(this.insertionIndex(window.tabs, options.index), 0, id);
    this.state.emit({ name: 'tabs.onCreated', args: [this.read.tab(id)!] });
    if (options.active || this.read.activeTab(windowId) === null) this.activate(id);
    return this.read.tab(id)!;
  }

  activate(id: number): void {
    const tab = this.state.tabs.get(id);
    if (!tab || tab.active) return;
    for (const other of this.state.windows.get(tab.windowId)!.tabs) this.state.tabs.get(other)!.active = false;
    tab.active = true;
    tab.lastAccessed = this.state.now();
    this.state.emit({ name: 'tabs.onActivated', args: [{ tabId: id, windowId: tab.windowId }] });
  }

  move(id: number, windowId: number, index: number): ChromeTab {
    const tab = this.state.tabs.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    const target = this.state.windows.get(windowId);
    if (!target) throw new Error(`No window with id: ${windowId}.`);
    const source = this.state.windows.get(tab.windowId)!;
    const fromIndex = source.tabs.indexOf(id);
    if (source === target) {
      source.tabs.splice(fromIndex, 1);
      const toIndex = this.insertionIndex(source.tabs, index);
      source.tabs.splice(toIndex, 0, id);
      if (toIndex !== fromIndex) this.state.emit({ name: 'tabs.onMoved', args: [id, { windowId, fromIndex, toIndex }] });
      return this.read.tab(id)!;
    }
    const wasActive = tab.active;
    source.tabs.splice(fromIndex, 1);
    tab.active = false;
    this.state.emit({ name: 'tabs.onDetached', args: [id, { oldWindowId: source.id, oldPosition: fromIndex }] });
    if (wasActive) this.activateNeighbour(source, fromIndex);
    tab.windowId = windowId;
    const toIndex = this.insertionIndex(target.tabs, index);
    target.tabs.splice(toIndex, 0, id);
    this.state.emit({ name: 'tabs.onAttached', args: [id, { newWindowId: windowId, newPosition: toIndex }] });
    if (this.read.activeTab(windowId) === null) this.activate(id);
    if (source.tabs.length === 0) this.hooks.dropWindow(source.id);
    return this.read.tab(id)!;
  }

  removeTab(id: number): void {
    const tab = this.state.tabs.get(id);
    if (!tab) return;
    const windowId = tab.windowId;
    this.detach(id, false);
    if (this.state.windows.get(windowId)?.tabs.length === 0) this.hooks.dropWindow(windowId);
  }

  detach(id: number, isWindowClosing: boolean): void {
    const tab = this.state.tabs.get(id)!;
    const window = this.state.windows.get(tab.windowId)!;
    const index = window.tabs.indexOf(id);
    window.tabs.splice(index, 1);
    this.state.tabs.delete(id);
    this.state.emit({ name: 'tabs.onRemoved', args: [id, { windowId: window.id, isWindowClosing }] });
    if (tab.active && !isWindowClosing) this.activateNeighbour(window, index);
  }

  setAutoDiscardable(id: number, value: boolean): void {
    const tab = this.state.tabs.get(id);
    if (!tab || tab.autoDiscardable === value) return;
    tab.autoDiscardable = value;
    publishTabUpdate(this.state, this.read, tab, { autoDiscardable: value });
  }

  private activateNeighbour(window: { tabs: number[] }, index: number): void {
    const next = window.tabs[index] ?? window.tabs[index - 1];
    if (next !== undefined) this.activate(next);
  }

  private insertionIndex(tabs: number[], index: number | undefined): number {
    return index === undefined || index < 0 || index > tabs.length ? tabs.length : index;
  }
}
