import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_VERSION, BRIDGE_PROTOCOL } from '../backend/infrastructure/settings/version.js';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { createBridgeClient } from '../browser-extension/src/background/connectivity/bridge-client.js';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { createExtensionUpdater } from '../browser-extension/src/background/connectivity/update-coordinator.js';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { createProviderPageExecutor } from '../browser-extension/src/background/providers/execution/router.js';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { createProviderRuntime } from '../browser-extension/src/background/providers/session-runtime.js';

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => key in data).map(key => [key, data[key]]));
    },
    async set(values: Record<string, unknown>) {
      Object.assign(data, structuredClone(values));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }
  };
}

function jsonResponse(status: number, value: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(value); },
    async text() { return String(value); }
  };
}

class FakeWebSocket {
  readyState = 0;
  readonly url: string;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: () => void;

  constructor(url: string) { this.url = url; }
}

function chromeFixture(local = memoryStorage(), session = memoryStorage()) {
  const tab = { id: 7, windowId: 2, url: 'https://chat.deepseek.com/', status: 'complete' };
  return {
    runtime: {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: (file: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${file}`,
      getManifest: () => ({ version: APP_VERSION }),
      reload: vi.fn()
    },
    storage: { local, session },
    tabs: {
      query: vi.fn(async (query: Record<string, unknown> = {}) => query.active ? [tab] : [tab]),
      get: vi.fn(async () => tab),
      create: vi.fn(async ({ url }: { url: string }) => ({ ...tab, id: 8, url })),
      update: vi.fn(async () => tab),
      sendMessage: vi.fn(async () => null)
    },
    windows: { update: vi.fn(async () => ({ id: 2 })) },
    scripting: {
      executeScript: vi.fn(async () => []),
      insertCSS: vi.fn(async () => undefined)
    },
    tab
  };
}

function installFetch(handler: (url: URL, init?: Record<string, unknown>) => Promise<unknown>) {
  const fetch = vi.fn(async (input: string | URL, init?: Record<string, unknown>) => {
    const url = new URL(String(input));
    const result = await handler(url, init);
    if (result && typeof result === 'object' && ('ok' in result ||
        typeof (result as { text?: unknown }).text === 'function')) return result;
    return jsonResponse(200, result);
  });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe('NEURAFLOK browser companion', () => {
  it('keeps release versions aligned and declares only supported provider pages', async () => {
    const root = process.cwd();
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
    const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages?: Record<string, { version?: string }>;
    };
    const manifest = JSON.parse(await readFile(path.join(root, 'browser-extension/manifest.json'), 'utf8')) as {
      version: string;
      host_permissions: string[];
      content_scripts: Array<{ js: string[]; matches: string[]; world?: string }>;
    };
    const worker = await readFile(path.join(root, 'browser-extension/src/background/service-worker.js'), 'utf8');
    const pageExecutor = await readFile(path.join(root, 'browser-extension/src/background/providers/execution/router.js'), 'utf8');
    const providerState = await readFile(path.join(root, 'browser-extension/src/background/providers/delivery-ledger.js'), 'utf8');
    const deepseekExecutor = await readFile(path.join(root, 'browser-extension/src/background/providers/execution/deepseek.js'), 'utf8');
    const webExecutor = await readFile(path.join(root, 'browser-extension/src/background/providers/execution/web.js'), 'utf8');

    expect(pkg.version).toBe(APP_VERSION);
    expect(lock.version).toBe(APP_VERSION);
    expect(lock.packages?.['']?.version).toBe(APP_VERSION);
    expect(manifest.version).toBe(APP_VERSION);
    expect(BRIDGE_PROTOCOL).toBe(16);
    expect(manifest.host_permissions).toEqual(expect.arrayContaining([
      'https://chat.deepseek.com/*', 'https://www.kimi.com/*', 'https://chat.qwen.ai/*',
      'https://z.ai/*', 'https://chat.z.ai/*', 'https://chatglm.cn/*'
    ]));
    expect(manifest.content_scripts.every(script => script.world !== 'MAIN')).toBe(true);
    expect(manifest.content_scripts.flatMap(script => script.js)).toEqual(expect.arrayContaining([
      'src/provider-pages/deepseek/dom-adapter.js', 'src/provider-pages/shared/delivery-agent.js', 'src/provider-pages/deepseek/controller.js',
      'src/provider-pages/web/dom-adapter.js', 'src/provider-pages/shared/delivery-agent.js', 'src/provider-pages/web/controller.js'
    ]));
    expect(worker.split('\n').length).toBeLessThan(200);
    expect(pageExecutor.split('\n').length).toBeLessThan(60);
    expect(providerState.split('\n').length).toBeLessThan(100);
    expect(deepseekExecutor.split('\n').length).toBeLessThan(300);
    const deepseekWatch = await readFile(path.join(root, 'browser-extension/src/background/providers/execution/deepseek-watch.js'), 'utf8');
    expect(deepseekWatch.split('\n').length).toBeLessThan(220);
    expect(webExecutor.split('\n').length).toBeLessThan(240);
    expect(worker).toContain("import { createAppLanguageSync } from './connectivity/language-sync.js'");
    expect(worker).toContain('await appLanguage.apply(data).catch');
  });

  it('pairs through the local bridge with a stable browser identity and authenticated requests', async () => {
    const legacyId = '0123456789abcdef0123456789abcdef';
    const local = memoryStorage({ browserId: legacyId });
    const chrome = chromeFixture(local);
    const fetch = installFetch(async (url, init) => {
      if (url.pathname === '/build-stamp.txt') return { text: async () => 'abcdef012345\n' };
      if (url.pathname === '/hello') return jsonResponse(200, {
        app: 'neuraflok', version: APP_VERSION, bridge: BRIDGE_PROTOCOL, compatible: true, disconnected: false
      });
      if (url.pathname === '/pair') return jsonResponse(200, { token: 'paired-token' });
      if (url.pathname === '/status') return jsonResponse(200, { ok: true });
      throw new Error(`Unexpected route ${url.pathname} ${String(init?.method || 'GET')}`);
    });
    const client = createBridgeClient(chrome as never);

    await expect(client.status()).resolves.toMatchObject({ connected: true, paired: true, compatible: true });
    await expect(client.request('/status')).resolves.toMatchObject({ ok: true, status: 200, data: { ok: true } });

    expect(local.data.neuraflokBrowserId).toBe(legacyId);
    expect(local.data.neuralJamBrowserId).toBeUndefined();
    expect(local.data.browserId).toBeUndefined();
    const statusCall = fetch.mock.calls.find(([input]) => new URL(String(input)).pathname === '/status');
    const headers = statusCall?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer paired-token');
    expect(headers['x-extension-browser']).toBe(legacyId);
    expect(headers['x-extension-build']).toBe('abcdef012345');
  });

  it('latches an app disconnect and requires an explicit reconnect', async () => {
    const local = memoryStorage();
    const chrome = chromeFixture(local);
    const onDisconnect = vi.fn(async () => undefined);
    const fetch = installFetch(async url => {
      if (url.pathname === '/build-stamp.txt') return { text: async () => 'abcdef012345' };
      if (url.pathname === '/hello') return jsonResponse(200, {
        app: 'neuraflok', version: APP_VERSION, bridge: BRIDGE_PROTOCOL, compatible: true, disconnected: true
      });
      if (url.pathname === '/pair') return jsonResponse(200, { token: 'new-token' });
      throw new Error(`Unexpected route ${url.pathname}`);
    });
    const client = createBridgeClient(chrome as never, onDisconnect);

    await expect(client.status()).resolves.toMatchObject({ connected: true, paired: false, disconnected: true });
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.some(([input]) => new URL(String(input)).pathname === '/pair')).toBe(false);

    await expect(client.pair()).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls.some(([input, init]) => new URL(String(input)).pathname === '/pair' &&
      JSON.parse(String(init?.body)).reconnect === true)).toBe(true);
    expect(client.state.disconnected).toBe(false);
  });

  it('reports signed-in provider state and rejects a page claiming another provider', async () => {
    const chrome = chromeFixture();
    const runtime = createProviderRuntime({
      chrome,
      activeTabs: null,
      call: vi.fn(async () => ({ ok: true })),
      tabReply: vi.fn(async (_id: number, message: { type: string }) => message.type === 'neuraflok-deepseek-status'
        ? { signedIn: true, generating: false, conversationId: 'ds-00000000-0000-0000-0000-000000000001' }
        : null),
      maintain: vi.fn(async () => undefined)
    });

    await expect(runtime.handlers.tabStatus()).resolves.toMatchObject({
      provider: 'deepseek',
      page: { signedIn: true, conversationId: 'ds-00000000-0000-0000-0000-000000000001' },
      webProviders: { deepseek: { open: true, signedIn: true, tabId: 7 } }
    });
    await expect(runtime.handlers['neuraflok-provider-present'](
      { provider: 'kimi', signedIn: true }, { tab: { id: 7, url: 'https://chat.deepseek.com/' } }
    )).resolves.toEqual({ ok: false });
    expect(runtime.isProviderUrl('https://chat.deepseek.com/')).toBe(true);
    expect(runtime.isProviderUrl('https://example.com/')).toBe(false);
  });

  it('reveals only the signed-in provider tab bound to the requested local conversation', async () => {
    const chrome = chromeFixture();
    const conversationId = 'km-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const tabs = [
      { id: 11, windowId: 3, url: 'https://www.kimi.com/en/', status: 'complete' },
      { id: 12, windowId: 4, url: 'https://www.kimi.com/en/', status: 'complete' }
    ];
    chrome.tabs.query.mockImplementation(async () => tabs as never);
    chrome.tabs.get = vi.fn(async (id: number) => tabs.find(tab => tab.id === id)) as typeof chrome.tabs.get;
    const tabReply = vi.fn(async (tabId: number) => ({
      provider: 'kimi', signedIn: true,
      conversationId: tabId === 12 ? conversationId : 'km-bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    }));
    const runtime = createProviderRuntime({
      chrome,
      activeTabs: null,
      call: vi.fn(async () => ({ ok: true })),
      tabReply,
      maintain: vi.fn(async () => undefined)
    });

    await expect(runtime.revealConversations([conversationId])).resolves.toEqual([true]);
    expect(chrome.tabs.update).toHaveBeenCalledOnce();
    expect(chrome.tabs.update).toHaveBeenCalledWith(12, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(4, { focused: true });
  });

  it.each(['kimi', 'qwen', 'glm'] as const)('delivers a fresh %s page offer and returns its exact answer', async provider => {
    const tab = { id: 12, url: provider === 'kimi' ? 'https://www.kimi.com/en/' :
      provider === 'qwen' ? 'https://chat.qwen.ai/' : 'https://z.ai/chat', status: 'complete' };
    const activeTabs = { set: vi.fn(async () => undefined) };
    const call = vi.fn(async (_route: string, _init?: Record<string, unknown>) => ({ ok: true, data: { ok: true } }));
    const tabReply = vi.fn(async (_tabId: number, message: { type: string }) => {
      if (message.type === 'neuraflok-provider-status' || message.type === 'neuraflok-provider-snapshot') {
        return { provider, signedIn: true, conversationId: null, before: '' };
      }
      if (message.type === 'neuraflok-provider-complete') return { text: `Answer from ${provider}` };
      return null;
    });
    const executor = createProviderPageExecutor({
      chrome: { storage: { local: memoryStorage(), session: memoryStorage() }, tabs: { get: async () => tab } } as never,
      activeTabs: activeTabs as never,
      call,
      tabReply,
      createBrowserTab: async () => tab,
      queryProviderTabs: async () => [],
      restoreDeepseekTab: async () => true,
      restoreProviderTab: async () => true,
      waitForTabReady: async () => undefined,
      isDeepseekUrl: () => false,
      usableProviderTab: () => true,
      providerPages: { [provider]: { url: tab.url, hosts: [new URL(tab.url).hostname] } }
    });

    executor.inspect({ id: `send-${provider}`, provider, conversationId: `session-${provider}`, fresh: true, text: 'Hello' }, false);
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith('/provider/page', expect.objectContaining({
      body: expect.stringContaining(`Answer from ${provider}`)
    })));
    expect(tabReply).toHaveBeenCalledWith(12, expect.objectContaining({ type: 'neuraflok-provider-complete' }), undefined, 100_000);
    expect(activeTabs.set).toHaveBeenCalledWith(`provider:send-${provider}`, [tab], expect.any(Function));
  });

  it('only reloads a companion after the app confirms a matching idle update', async () => {
    const chrome = chromeFixture();
    const bridge = {
      state: { buildId: 'aaaaaaaaaaaa' },
      request: vi.fn(async () => ({ ok: true, data: { build: 'bbbbbbbbbbbb', ready: true } }))
    };
    const updater = createExtensionUpdater({ bridge, chrome, isBusy: () => false } as never);

    await updater.update({ build: 'bbbbbbbbbbbb', busy: false });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(bridge.request).toHaveBeenCalledWith('/extension/update', { method: 'POST', body: '{}' });
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.data.neuraflokExtensionUpdateAttempt).toBe('aaaaaaaaaaaa>bbbbbbbbbbbb');
    expect(updater.hold).toBeNull();
  });

  it.each([
    [{ build: 'bbbbbbbbbbbb', busy: true }, false, 'app-busy'],
    [{ build: 'bbbbbbbbbbbb', busy: false }, true, 'browser-work'],
    [{ build: 'invalid', busy: false }, false, null],
    [{ build: 'aaaaaaaaaaaa', busy: false }, false, null]
  ])('holds or skips an update safely', async (offer, busy, hold) => {
    const chrome = chromeFixture();
    const bridge = {
      state: { buildId: 'aaaaaaaaaaaa' },
      request: vi.fn(async () => ({ ok: true, data: { build: 'bbbbbbbbbbbb', ready: true } }))
    };
    const updater = createExtensionUpdater({ bridge, chrome, isBusy: () => busy } as never);

    await updater.update(offer as never);

    expect(updater.hold).toBe(hold);
    expect(bridge.request).not.toHaveBeenCalled();
    expect(chrome.runtime.reload).not.toHaveBeenCalled();
  });
});
