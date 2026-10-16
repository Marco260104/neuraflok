import type { ChromeApiHandler } from './types.js';
import { tabOf, windowIdOf } from './tab-operations.js';
import { EMPTY_PAGE_URL, optionalBoolean, optionalString, populate, record, windowState } from './validation.js';

export const handlers: Record<string, ChromeApiHandler> = {
  'windows.get': (browser, [id, options]) => browser.model.window(windowIdOf(browser, id), populate(options)),
  'windows.getAll': (browser, [options]) => browser.model.allWindows(populate(options)),
  'windows.getLastFocused': (browser, [options]) => {
    const window = browser.model.window(browser.model.lastFocusedWindow(), populate(options));
    if (!window) throw new Error('No last-focused window');
    return window;
  },
  'windows.create': (browser, [data]) => {
    const props = record(data, 'createData');
    const urls = props.url === undefined ? [] : Array.isArray(props.url) ? props.url : [props.url];
    for (const url of urls) optionalString(url, 'url');
    const wanted = windowState(props.state);
    const focused = optionalBoolean(props.focused, 'focused');
    if (wanted === 'minimized' && focused === true) throw new Error('Invalid value for state');
    const type = props.type === 'popup' ? 'popup' : 'normal';
    const moving = props.tabId === undefined ? null : tabOf(browser, props.tabId);
    const id = browser.createWindow({
      ...(moving || urls.length === 0 ? {} : { url: urls[0] as string }),
      focused: focused ?? wanted !== 'minimized',
      state: wanted ?? 'normal',
      type
    });
    if (moving) browser.moveTab(moving.id, id, -1);
    else if (urls.length === 0) browser.createTab(id, EMPTY_PAGE_URL, { active: true });
    for (const url of urls.slice(1)) browser.createTab(id, url as string, { active: false });
    return browser.model.window(id, true);
  },
  'windows.update': (browser, [id, info]) => {
    const windowId = windowIdOf(browser, id);
    const props = record(info, 'updateInfo');
    const wanted = windowState(props.state);
    const focused = optionalBoolean(props.focused, 'focused');
    if (wanted === 'minimized' && focused === true) throw new Error('Invalid value for state');
    browser.presentWindow(windowId, { ...(wanted ? { state: wanted } : {}), ...(focused === undefined ? {} : { focused }) });
    return browser.model.window(windowId);
  },
  'windows.remove': (browser, [id]) => { browser.closeWindow(windowIdOf(browser, id)); }
};
