import type { BrowserControl, ChromeApiHandler } from './types.js';
import { handlers as tabHandlers } from './tabs.js';
import { handlers as windowHandlers } from './windows.js';
import { handlers as debuggerHandlers } from './debugger.js';

const handlers: Record<string, ChromeApiHandler> = {
  ...tabHandlers,
  ...windowHandlers,
  ...debuggerHandlers
};

export type { BrowserControl, DebuggerTarget } from './types.js';
export type ChromeApiReply = { ok: true; value: unknown } | { ok: false; message: string };

export async function callChromeApi(browser: BrowserControl, name: string, args: unknown): Promise<ChromeApiReply> {
  const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
  if (!handler) return { ok: false, message: `${name} is not available in the NEURAFLOK browser.` };
  try {
    return { ok: true, value: await handler(browser, Array.isArray(args) ? args : []) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
