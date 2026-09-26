import type { BrowserControl, ChromeApiHandler } from './types.js';
import { integer, optionalString, record } from './validation.js';

function debuggerTab(browser: BrowserControl, target: unknown): number {
  const source = record(target, 'target');
  if (source.tabId === undefined) throw new Error('Either tab id or extension id must be specified.');
  const tabId = integer(source.tabId, 'tabId');
  if (!browser.model.hasTab(tabId)) throw new Error(`No tab with given id ${tabId}.`);
  return tabId;
}

export const handlers: Record<string, ChromeApiHandler> = {
  'debugger.attach': async (browser, [target, version]) => {
    await browser.debuggerAttach(debuggerTab(browser, target), optionalString(version, 'requiredVersion') ?? '1.3');
  },
  'debugger.detach': async (browser, [target]) => { await browser.debuggerDetach(debuggerTab(browser, target)); },
  'debugger.sendCommand': (browser, [target, method, params]) => {
    const source = record(target, 'target');
    return browser.debuggerSend(debuggerTab(browser, target), optionalString(method, 'method') ?? '',
      params === undefined ? undefined : record(params, 'commandParams'), optionalString(source.sessionId, 'sessionId'));
  },
  'debugger.getTargets': browser => browser.debuggerTargets()
};
