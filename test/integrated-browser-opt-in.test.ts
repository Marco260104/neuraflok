import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The integrated browser stays lazy until startup, then receives current provider state.
const app = vi.hoisted(() => {
  const ipc = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>();
  return {
    config: { ui: { chatBrowser: 'chrome' as string } },
    ipc,
    bridgeListeners: [] as Array<() => void>,
    bridgeStatus: vi.fn(async () => ({ present: true })),
    providerPresence: {
      deepseek: { open: true, signedIn: true, tabId: 7, lastSeenAt: 100 },
      kimi: { open: false, signedIn: null, tabId: null, lastSeenAt: null },
      qwen: { open: false, signedIn: null, tabId: null, lastSeenAt: null },
      glm: { open: false, signedIn: null, tabId: null, lastSeenAt: null }
    },
    moduleLoads: 0,
    assets: null as null | { preloadDir: string; rendererDir: string },
    browser: {
      running: false,
      start: vi.fn(async () => { app.browser.running = true; }),
      stop: vi.fn(() => { app.browser.running = false; }),
      setAppConnected: vi.fn(),
      setWebProviderPresence: vi.fn(),
      toolbarAction: vi.fn()
    }
  };
});

vi.mock('electron', () => ({
  app: { getAppPath: () => '/fixture/app' },
  ipcMain: { on: (channel: string, listener: any) => app.ipc.set(channel, listener) }
}));
vi.mock('../backend/infrastructure/settings/config.js', () => ({ getConfig: () => app.config }));
vi.mock('../backend/infrastructure/settings/logger.js', () => ({ logWarn: vi.fn() }));
vi.mock('../backend/domains/browser/bridge.js', () => ({
  bridgeStatus: app.bridgeStatus,
  webProvidersStatus: () => app.providerPresence,
  onBridgeChange: (listener: () => void) => { app.bridgeListeners.push(listener); }
}));
vi.mock('../backend/domains/browser/embedded/host.js', () => ({
  IntegratedBrowser: class {
    constructor(assets: { preloadDir: string; rendererDir: string }) { app.moduleLoads++; app.assets = assets; }
    running() { return app.browser.running; }
    start() { return app.browser.start(); }
    stop() { app.browser.stop(); }
    setAppConnected(value: boolean) { app.browser.setAppConnected(value); }
    setWebProviderPresence(presence: unknown) { app.browser.setWebProviderPresence(presence); }
    toolbarAction(...args: unknown[]) { app.browser.toolbarAction(...args); }
  }
}));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  app.config.ui.chatBrowser = 'chrome';
  app.ipc.clear();
  app.bridgeListeners.length = 0;
  app.moduleLoads = 0;
  app.browser.running = false;
  for (const mock of [app.bridgeStatus, app.browser.start, app.browser.stop, app.browser.setAppConnected,
    app.browser.setWebProviderPresence, app.browser.toolbarAction]) mock.mockClear();
});
afterEach(() => { vi.resetModules(); });

describe('lazy browser loading', () => {
  it('does not load or hook the browser when its selection module is only imported', async () => {
    const selection = await import('../backend/domains/browser/embedded/selection.js');
    const loaded = vi.fn();
    selection.onIntegratedBrowserLoaded(loaded);
    expect(app.moduleLoads).toBe(0);
    expect(selection.loadedIntegratedBrowser()).toBeNull();
    expect(loaded).not.toHaveBeenCalled();
    expect(app.bridgeListeners).toHaveLength(0);
    expect(app.ipc.size).toBe(0);
    expect(app.browser.start).not.toHaveBeenCalled();
  });

  it('is not imported statically by the app shell, its IPC or the browser opener', () => {
    // A static import would load the module, and with it its hooks, on the default path.
    const ipcDirectory = 'backend/application/ipc';
    const ipcFiles = readdirSync(ipcDirectory).filter(file => file.endsWith('.ts')).map(file => path.join(ipcDirectory, file));
    for (const file of ['backend/application/startup.ts', ...ipcFiles, 'backend/domains/browser/browser.ts', 'backend/domains/browser/bridge.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/^import [^;]*from ['"][^'"]*\/embedded\/(index|host)\.js['"]/m);
    }
  });
});

describe('with the built-in browser selected', () => {
  it('loads, starts and paints companion and provider presence at once', async () => {
    app.config.ui.chatBrowser = 'integrated';
    const selection = await import('../backend/domains/browser/embedded/selection.js');
    const loaded = vi.fn();
    selection.onIntegratedBrowserLoaded(loaded);
    await selection.syncIntegratedBrowser();
    await settle();
    expect(app.moduleLoads).toBe(1);
    expect(loaded).toHaveBeenCalledExactlyOnceWith(selection.loadedIntegratedBrowser());
    // Its preloads and pages from the app root: as an on-demand chunk it no longer sits in out/main.
    expect(app.assets!.preloadDir.replace(/\\/g, '/')).toBe('/fixture/app/out/preload');
    expect(app.assets!.rendererDir.replace(/\\/g, '/')).toBe('/fixture/app/out/renderer');
    expect(app.browser.start).toHaveBeenCalledTimes(1);
    // Ready on its first frame, not after the next bridge or session change.
    expect(app.browser.setAppConnected).toHaveBeenCalledWith(true);
    expect(app.browser.setWebProviderPresence).toHaveBeenCalledWith(app.providerPresence);
    app.browser.setWebProviderPresence.mockClear();
    app.providerPresence.deepseek.lastSeenAt = 200;
    for (const listener of app.bridgeListeners) listener();
    expect(app.browser.setWebProviderPresence).toHaveBeenCalledWith(app.providerPresence);
    app.ipc.get('integrated-browser:toolbar')!({ sender: 'toolbar' }, 'reload', 7);
    expect(app.browser.toolbarAction).toHaveBeenCalledWith('toolbar', 'reload', 7);
  });

});
