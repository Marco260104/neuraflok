import type { TabQuery } from '../tabs/model-contracts.js';
import type { ChromeApiHandler } from './types.js';
import { tabAndProperties, tabOf, targetWindow, windowIdOf } from './tab-operations.js';
import { EMPTY_PAGE_URL, integer, optionalBoolean, optionalString, record } from './validation.js';

export const handlers: Record<string, ChromeApiHandler> = {
  'tabs.query': (browser, [query]) => browser.model.query(record(query, 'queryInfo') as TabQuery),
  'tabs.get': (browser, [id]) => tabOf(browser, id),
  'tabs.create': (browser, [properties]) => {
    const props = record(properties, 'createProperties');
    const url = optionalString(props.url, 'url') ?? EMPTY_PAGE_URL;
    const active = optionalBoolean(props.active, 'active') ?? optionalBoolean(props.selected, 'selected') ?? true;
    const index = props.index === undefined ? undefined : integer(props.index, 'index');
    const openerTabId = props.openerTabId === undefined ? undefined : tabOf(browser, props.openerTabId).id;
    const windowId = targetWindow(browser, props.windowId);
    if (windowId === null) {
      const created = browser.createWindow({ url, focused: active, state: 'normal', type: 'normal' });
      return browser.model.tab(browser.model.tabsOf(created)[0]!)!;
    }
    const id = browser.createTab(windowId, url, { active, ...(index === undefined ? {} : { index }), ...(openerTabId === undefined ? {} : { openerTabId }) });
    return browser.model.tab(id)!;
  },
  'tabs.update': (browser, args) => {
    const [tab, props] = tabAndProperties(browser, args, 'updateProperties');
    const url = optionalString(props.url, 'url');
    const active = optionalBoolean(props.active, 'active') ?? optionalBoolean(props.highlighted, 'highlighted');
    const autoDiscardable = optionalBoolean(props.autoDiscardable, 'autoDiscardable');
    optionalBoolean(props.pinned, 'pinned');
    optionalBoolean(props.muted, 'muted');
    if (autoDiscardable !== undefined) browser.model.setAutoDiscardable(tab.id, autoDiscardable);
    if (url !== undefined) browser.navigate(tab.id, url);
    if (active === true) browser.activate(tab.id);
    return browser.model.tab(tab.id);
  },
  'tabs.reload': (browser, args) => {
    const [tab, props] = tabAndProperties(browser, args, 'reloadProperties');
    browser.reload(tab.id, optionalBoolean(props.bypassCache, 'bypassCache') === true);
  },
  'tabs.move': (browser, [ids, properties]) => {
    const props = record(properties, 'moveProperties');
    const index = integer(props.index, 'index');
    const list = Array.isArray(ids) ? ids : [ids];
    const tabs = list.map(id => tabOf(browser, id));
    const moved = tabs.map((tab, offset) => {
      const windowId = props.windowId === undefined ? tab.windowId : windowIdOf(browser, props.windowId);
      browser.moveTab(tab.id, windowId, index === -1 ? -1 : index + offset);
      return browser.model.tab(tab.id)!;
    });
    return Array.isArray(ids) ? moved : moved[0];
  },
  'tabs.remove': (browser, [ids]) => {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) tabOf(browser, id);
    for (const id of list) browser.closeTab(id as number);
  }
};
