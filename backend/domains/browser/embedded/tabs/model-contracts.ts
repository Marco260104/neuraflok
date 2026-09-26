export type TabStatus = 'loading' | 'complete';
export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

export interface ChromeTab {
  id: number;
  index: number;
  windowId: number;
  openerTabId?: number;
  active: boolean;
  highlighted: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  frozen: boolean;
  autoDiscardable: boolean;
  incognito: boolean;
  groupId: number;
  mutedInfo: { muted: boolean };
  url: string;
  pendingUrl?: string;
  title: string;
  status: TabStatus;
  lastAccessed: number;
}

export interface ChromeWindow {
  id: number;
  focused: boolean;
  state: WindowState;
  type: 'normal' | 'popup';
  incognito: boolean;
  alwaysOnTop: boolean;
  tabs?: ChromeTab[];
}

export type TabChange = Partial<Pick<ChromeTab, 'status' | 'url' | 'title' | 'autoDiscardable'>>;

export type ModelEvent =
  | { name: 'tabs.onCreated'; args: [ChromeTab] }
  | { name: 'tabs.onUpdated'; args: [number, TabChange, ChromeTab] }
  | { name: 'tabs.onActivated'; args: [{ tabId: number; windowId: number }] }
  | { name: 'tabs.onMoved'; args: [number, { windowId: number; fromIndex: number; toIndex: number }] }
  | { name: 'tabs.onDetached'; args: [number, { oldWindowId: number; oldPosition: number }] }
  | { name: 'tabs.onAttached'; args: [number, { newWindowId: number; newPosition: number }] }
  | { name: 'tabs.onRemoved'; args: [number, { windowId: number; isWindowClosing: boolean }] }
  | { name: 'windows.onCreated'; args: [ChromeWindow] }
  | { name: 'windows.onRemoved'; args: [number] }
  | { name: 'windows.onFocusChanged'; args: [number] };

export const WINDOW_ID_NONE = -1;

export interface TabQuery {
  active?: boolean;
  highlighted?: boolean;
  pinned?: boolean;
  discarded?: boolean;
  autoDiscardable?: boolean;
  status?: TabStatus;
  url?: string | string[];
  title?: string;
  windowId?: number;
  index?: number;
  lastFocusedWindow?: boolean;
  currentWindow?: boolean;
}

export interface WindowRecord {
  id: number;
  type: 'normal' | 'popup';
  state: WindowState;
  tabs: number[];
}

export interface TabRecord {
  id: number;
  windowId: number;
  openerTabId?: number;
  active: boolean;
  autoDiscardable: boolean;
  url: string;
  pendingUrl?: string;
  title: string;
  status: TabStatus;
  lastAccessed: number;
}
