import { TabModelState } from './runtime-state.js';
import { TabReadModel } from './read-model.js';
import { WINDOW_ID_NONE, type WindowState } from './model-contracts.js';

export interface WindowOperationHooks {
  detachTab(id: number, isWindowClosing: boolean): void;
  activeTab(windowId: number): number | null;
}

export class WindowOperations {
  constructor(private readonly state: TabModelState, private readonly read: TabReadModel, private readonly hooks: WindowOperationHooks) {}

  createWindow(options: { type?: 'normal' | 'popup'; state?: WindowState } = {}): number {
    const id = this.state.nextWindowId++;
    this.state.windows.set(id, { id, type: options.type ?? 'normal', state: options.state ?? 'normal', tabs: [] });
    this.state.emit({ name: 'windows.onCreated', args: [this.read.window(id)!] });
    return id;
  }

  setWindowState(id: number, state: WindowState): void {
    const window = this.state.windows.get(id);
    if (window) window.state = state;
  }

  focusWindow(id: number): void {
    const next = id === WINDOW_ID_NONE || this.state.windows.has(id) ? id : WINDOW_ID_NONE;
    if (next === this.state.focusedWindowId) return;
    this.state.focusedWindowId = next;
    if (next !== WINDOW_ID_NONE) {
      this.state.lastFocusedWindowId = next;
      const active = this.hooks.activeTab(next);
      if (active !== null) this.state.tabs.get(active)!.lastAccessed = this.state.now();
    }
    this.state.emit({ name: 'windows.onFocusChanged', args: [next] });
  }

  removeWindow(id: number): void {
    const window = this.state.windows.get(id);
    if (!window) return;
    for (const tab of [...window.tabs].reverse()) this.hooks.detachTab(tab, true);
    this.dropWindow(id);
  }

  dropWindow(id: number): void {
    if (!this.state.windows.delete(id)) return;
    if (this.state.focusedWindowId === id) this.state.focusedWindowId = WINDOW_ID_NONE;
    if (this.state.lastFocusedWindowId === id) {
      this.state.lastFocusedWindowId = [...this.state.windows.keys()].at(-1) ?? WINDOW_ID_NONE;
    }
    this.state.emit({ name: 'windows.onRemoved', args: [id] });
  }
}
