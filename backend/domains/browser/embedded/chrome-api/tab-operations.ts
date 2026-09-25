import type { ChromeTab } from '../tabs/model-contracts.js';
import type { BrowserControl } from './types.js';
import { CURRENT_WINDOW_ID, integer, record } from './validation.js';

export function tabOf(browser: BrowserControl, id: unknown): ChromeTab {
  const tabId = integer(id, 'tabId');
  const tab = browser.model.tab(tabId);
  if (!tab) throw new Error(`No tab with id: ${tabId}.`);
  return tab;
}

export function windowIdOf(browser: BrowserControl, id: unknown): number {
  const windowId = integer(id, 'windowId');
  const resolved = windowId === CURRENT_WINDOW_ID ? browser.model.lastFocusedWindow() : windowId;
  if (!browser.model.window(resolved)) throw new Error(`No window with id: ${windowId}.`);
  return resolved;
}

export function activeTab(browser: BrowserControl): ChromeTab {
  const windowId = browser.model.lastFocusedWindow();
  const tabId = browser.model.activeTab(windowId);
  if (tabId === null) throw new Error('No current tab.');
  return browser.model.tab(tabId)!;
}

export function tabAndProperties(browser: BrowserControl, [first, second]: unknown[], name: string): [ChromeTab, Record<string, unknown>] {
  if (first === undefined || first === null) return [activeTab(browser), record(second, name)];
  if (typeof first === 'object') return [activeTab(browser), record(first, name)];
  return [tabOf(browser, first), record(second, name)];
}

export function targetWindow(browser: BrowserControl, windowId: unknown): number | null {
  if (windowId !== undefined) return windowIdOf(browser, windowId);
  const focused = browser.model.lastFocusedWindow();
  return browser.model.window(focused) ? focused : null;
}
