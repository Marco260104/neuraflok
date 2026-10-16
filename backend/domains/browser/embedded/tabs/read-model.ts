import { matchesTabUrlPatterns } from './url-query-filter.js';
import { TabModelState } from './runtime-state.js';
import { type ChromeTab, type ChromeWindow, type TabQuery } from './model-contracts.js';

function titleMatches(title: string, pattern: string): boolean {
  const glob = pattern.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${glob}$`, 'i').test(title);
}

export class TabReadModel {
  constructor(private readonly state: TabModelState) {}

  tab(id: number): ChromeTab | null {
    const record = this.state.tabs.get(id);
    if (!record) return null;
    const window = this.state.windows.get(record.windowId)!;
    return {
      id: record.id,
      index: window.tabs.indexOf(record.id),
      windowId: record.windowId,
      ...(record.openerTabId === undefined ? {} : { openerTabId: record.openerTabId }),
      active: record.active,
      highlighted: record.active,
      pinned: false,
      audible: false,
      discarded: false,
      frozen: false,
      autoDiscardable: record.autoDiscardable,
      incognito: false,
      groupId: -1,
      mutedInfo: { muted: false },
      url: record.url,
      ...(record.pendingUrl === undefined ? {} : { pendingUrl: record.pendingUrl }),
      title: record.title,
      status: record.status,
      lastAccessed: record.lastAccessed
    };
  }

  window(id: number, populate = false): ChromeWindow | null {
    const record = this.state.windows.get(id);
    if (!record) return null;
    return {
      id: record.id,
      focused: this.state.focusedWindowId === record.id,
      state: record.state,
      type: record.type,
      incognito: false,
      alwaysOnTop: false,
      ...(populate ? { tabs: record.tabs.map(tab => this.tab(tab)!) } : {})
    };
  }

  allWindows(populate = false): ChromeWindow[] {
    return [...this.state.windows.keys()].map(id => this.window(id, populate)!);
  }

  hasTab(id: number): boolean {
    return this.state.tabs.has(id);
  }

  tabsOf(windowId: number): number[] {
    return [...(this.state.windows.get(windowId)?.tabs ?? [])];
  }

  activeTab(windowId: number): number | null {
    return this.state.windows.get(windowId)?.tabs.find(id => this.state.tabs.get(id)!.active) ?? null;
  }

  lastFocusedWindow(): number {
    return this.state.lastFocusedWindowId;
  }

  query(query: TabQuery): ChromeTab[] {
    const focused = query.lastFocusedWindow !== undefined || query.currentWindow !== undefined
      ? this.state.lastFocusedWindowId
      : null;
    const result: ChromeTab[] = [];
    for (const window of this.state.windows.values()) {
      if (query.windowId !== undefined && window.id !== query.windowId) continue;
      if (focused !== null) {
        const wanted = query.lastFocusedWindow ?? query.currentWindow;
        if ((window.id === focused) !== wanted) continue;
      }
      for (const id of window.tabs) {
        const tab = this.tab(id)!;
        if (query.active !== undefined && tab.active !== query.active) continue;
        if (query.highlighted !== undefined && tab.highlighted !== query.highlighted) continue;
        if (query.pinned !== undefined && tab.pinned !== query.pinned) continue;
        if (query.discarded !== undefined && tab.discarded !== query.discarded) continue;
        if (query.autoDiscardable !== undefined && tab.autoDiscardable !== query.autoDiscardable) continue;
        if (query.status !== undefined && tab.status !== query.status) continue;
        if (query.index !== undefined && tab.index !== query.index) continue;
        if (query.title !== undefined && !titleMatches(tab.title, query.title)) continue;
        if (query.url !== undefined && !matchesTabUrlPatterns(tab.url, query.url)) continue;
        result.push(tab);
      }
    }
    return result;
  }
}
