import type { TabModel } from '../tabs/model.js';
import type { WindowState } from '../tabs/model-contracts.js';

export interface DebuggerTarget {
  type: 'page';
  id: string;
  tabId: number;
  title: string;
  url: string;
  attached: boolean;
}

export interface BrowserControl {
  readonly model: TabModel;
  createWindow(options: { url?: string; focused: boolean; state: WindowState; type: 'normal' | 'popup' }): number;
  createTab(windowId: number, url: string, options: { active: boolean; index?: number; openerTabId?: number }): number;
  navigate(tabId: number, url: string): void;
  reload(tabId: number, bypassCache: boolean): void;
  activate(tabId: number): void;
  closeTab(tabId: number): void;
  moveTab(tabId: number, windowId: number, index: number): void;
  closeWindow(windowId: number): void;
  presentWindow(windowId: number, change: { state?: WindowState; focused?: boolean }): void;
  debuggerAttach(tabId: number, version: string): Promise<void>;
  debuggerDetach(tabId: number): Promise<void>;
  debuggerSend(tabId: number, method: string, params: object | undefined, sessionId: string | undefined): Promise<unknown>;
  debuggerTargets(): DebuggerTarget[];
}

export type ChromeApiHandler = (browser: BrowserControl, args: unknown[]) => unknown;
