import vm from 'node:vm';
import { beforeEach, expect, it, vi } from 'vitest';

type Script = { func: (...args: unknown[]) => unknown; args?: unknown[] };

const electron = vi.hoisted(() => ({
  protocol: 'chrome-extension:' as string | undefined,
  exposed: new Map<string, unknown>(),
  scripts: [] as Script[],
  invoke: vi.fn(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>()
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => electron.exposed.set(key, value),
    // The first script asks the worker world for its own protocol; later ones install the shim.
    executeInMainWorld: (script: Script) => {
      electron.scripts.push(script);
      return electron.scripts.length === 1 ? electron.protocol : undefined;
    }
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => electron.listeners.set(channel, listener)
  }
}));

beforeEach(() => {
  vi.resetModules();
  electron.exposed.clear();
  electron.scripts.length = 0;
  electron.listeners.clear();
  electron.invoke.mockReset();
  electron.protocol = 'chrome-extension:';
});

/** The extension worker's own world: Electron's partial `chrome`, plus what the preload exposed. */
async function workerWorld() {
  await import('../backend/preload/integrated-browser-worker.js');
  const nativeSendMessage = vi.fn(async () => 'native reply');
  type Namespace = Record<string, unknown>;
  const chrome: { runtime: Namespace; tabs: Namespace; scripting: Namespace; windows?: Namespace; debugger?: Namespace; permissions?: Namespace } = {
    runtime: {
      getManifest: () => ({ permissions: ['debugger', 'tabs', 'scripting'], host_permissions: ['https://assistant.example/*'] }),
      onStartup: { addListener: () => undefined, native: true }
    },
    tabs: { sendMessage: nativeSendMessage, query: () => 'native query' },
    scripting: {}
  };
  const world = vm.createContext({ chrome, __integratedBrowserWorker: electron.exposed.get('__integratedBrowserWorker'), console, Promise, Error, JSON, Object, Set, Map });
  const install = electron.scripts[1]!;
  // From source text, as Electron serializes it: a reference to module scope fails here.
  vm.runInContext(`(${install.func.toString()})(...${JSON.stringify(install.args ?? [])})`, world);
  const event = (name: string, args: unknown[]) => electron.listeners.get('integrated-browser:event')!({}, name, args);
  return { chrome, nativeSendMessage, event };
}

it('does not expose extension APIs to an ordinary webpage worker', async () => {
  electron.protocol = 'https:';
  await import('../backend/preload/integrated-browser-worker.js');
  expect(electron.exposed.size).toBe(0);
  expect(electron.scripts).toHaveLength(1);
});

it('routes tab and window calls to the app and keeps Electron\'s own messaging', async () => {
  const { chrome, nativeSendMessage } = await workerWorld();
  electron.invoke.mockResolvedValue({ ok: true, value: [{ id: 4 }] });
  await expect((chrome.tabs.query as (q: object) => Promise<unknown>)({ url: ['https://assistant.example/*'] })).resolves.toEqual([{ id: 4 }]);
  expect(electron.invoke).toHaveBeenCalledWith('integrated-browser:api', 'tabs.query', [{ url: ['https://assistant.example/*'] }]);
  expect(chrome.tabs.sendMessage).toBe(nativeSendMessage);
  for (const name of ['get', 'create', 'update', 'reload', 'move', 'remove']) expect(typeof chrome.tabs[name]).toBe('function');
  for (const name of ['get', 'getAll', 'create', 'update', 'remove']) expect(typeof chrome.windows![name]).toBe('function');
  for (const name of ['attach', 'detach', 'sendCommand', 'getTargets']) expect(typeof chrome.debugger![name]).toBe('function');
});

it('routes alarms to the browser owner and delivers onAlarm through the worker event link', async () => {
  const { chrome, event } = await workerWorld();
  const alarms = (chrome as typeof chrome & { alarms: Record<string, unknown> }).alarms;
  const received = vi.fn();
  (alarms.onAlarm as { addListener(fn: (...args: unknown[]) => void): void }).addListener(received);
  electron.invoke.mockResolvedValue({ ok: true, value: undefined });
  await (alarms.create as (name: string, info: object) => Promise<void>)('maintenance', { delayInMinutes: 0.5 });
  expect(electron.invoke).toHaveBeenCalledWith('integrated-browser:api', 'alarms.create', ['maintenance', { delayInMinutes: 0.5 }]);
  const alarm = { name: 'maintenance', scheduledTime: 30_000 };
  event('alarms.onAlarm', [alarm]);
  expect(received).toHaveBeenCalledWith(alarm);
});

it('rejects with Chrome\'s exact message and sets runtime.lastError for callback callers', async () => {
  const { chrome } = await workerWorld();
  electron.invoke.mockResolvedValue({ ok: false, message: 'No tab with id: 9.' });
  await expect((chrome.tabs.get as (id: number) => Promise<unknown>)(9)).rejects.toThrow(/^No tab with id: 9\.$/);
  const seen = await new Promise<unknown>(resolve => (chrome.tabs.get as (id: number, cb: () => void) => void)(9, () => resolve(chrome.runtime.lastError)));
  expect(seen).toEqual({ message: 'No tab with id: 9.' });
  expect(chrome.runtime.lastError).toBeUndefined();
});

it('retries a call made before the app registered its handler', async () => {
  const { chrome } = await workerWorld();
  electron.invoke
    .mockRejectedValueOnce(new Error("Error invoking remote method 'integrated-browser:api': Error: No handler registered for 'integrated-browser:api'"))
    .mockResolvedValueOnce({ ok: true, value: [] });
  await expect((chrome.tabs.query as (q: object) => Promise<unknown>)({})).resolves.toEqual([]);
  expect(electron.invoke).toHaveBeenCalledTimes(2);
});

it('delivers app events to the extension\'s listeners, including the browser start', async () => {
  const { chrome, event } = await workerWorld();
  const started = vi.fn();
  const updated = vi.fn();
  (chrome.runtime.onStartup as { addListener(fn: () => void): void }).addListener(started);
  (chrome.tabs.onUpdated as { addListener(fn: (...args: unknown[]) => void): void }).addListener(updated);
  event('runtime.onStartup', []);
  event('tabs.onUpdated', [4, { url: 'https://assistant.example/c/x' }, { id: 4 }]);
  expect(started).toHaveBeenCalledTimes(1);
  expect(updated).toHaveBeenCalledWith(4, { url: 'https://assistant.example/c/x' }, { id: 4 });
  expect((chrome.runtime.onStartup as { native?: boolean }).native).toBeUndefined();
});

it('grants exactly the permissions the manifest declares', async () => {
  const { chrome } = await workerWorld();
  const contains = chrome.permissions!.contains as (request: object) => Promise<boolean>;
  await expect(contains({ permissions: ['debugger', 'tabs'] })).resolves.toBe(true);
  await expect(contains({ permissions: ['bookmarks'] })).resolves.toBe(false);
  await expect(contains({ origins: ['https://assistant.example/*'] })).resolves.toBe(true);
});
