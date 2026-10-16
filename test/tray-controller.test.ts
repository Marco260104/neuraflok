import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { ui: { chatExecutor: 'web', webProvider: 'deepseek', chatBrowser: 'integrated' } },
  trayInstances: [] as unknown[],
  textListeners: [] as Array<() => void>,
  bridgeListener: undefined as (() => void) | undefined,
  integratedLoadedListener: undefined as ((browser: unknown) => void) | undefined,
  browserChangeListener: undefined as (() => void) | undefined,
  browser: undefined as Record<string, unknown> | undefined,
  menuTemplate: undefined as unknown[] | undefined,
  translations: { Open: 'Abrir' }
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => Buffer.from('mark')),
  existsSync: vi.fn(() => false)
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
  Menu: { buildFromTemplate: vi.fn((template: unknown[]) => { mocks.menuTemplate = template; return template; }) },
  nativeImage: { createFromBuffer: vi.fn(() => ({
    addRepresentation: vi.fn(),
    setTemplateImage: vi.fn()
  })) },
  Tray: class {
    setImage = vi.fn();
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
    destroy = vi.fn();
    constructor() { mocks.trayInstances.push(this); }
  }
}));
vi.mock('../backend/infrastructure/settings/index.js', () => ({
  getConfig: () => mocks.config,
  logWarn: vi.fn(),
  mainText: (text: string) => `translated:${text}`,
  mainTextTranslations: () => mocks.translations,
  onMainTextsChange: (listener: () => void) => { mocks.textListeners.push(listener); },
  writeDurableSoon: vi.fn()
}));
vi.mock('../backend/domains/browser/index.js', () => ({
  onBridgeChange: (listener: () => void) => { mocks.bridgeListener = listener; },
  onIntegratedBrowserLoaded: (listener: (browser: unknown) => void) => { mocks.integratedLoadedListener = listener; },
  loadedIntegratedBrowser: () => mocks.browser,
  webProvidersStatus: () => ({ deepseek: { signedIn: true } })
}));
vi.mock('../backend/infrastructure/desktop-shell/index.js', () => ({
  trayGuidArgsForPlatform: () => [],
  trayImageSpec: vi.fn(async (_platform: string, running: boolean) => ({
    template: false,
    representations: [
      { scaleFactor: 1, png: Buffer.from(running ? 'connected' : 'disconnected') },
      { scaleFactor: 2, png: Buffer.from('high-dpi') }
    ]
  })),
  trayMarkPath: () => '/app/brand/mark.png'
}));

import { createTrayController } from '../backend/application/tray-controller.js';
import { writeDurableSoon } from '../backend/infrastructure/settings/index.js';

describe('native tray controller', () => {
  beforeEach(() => {
    mocks.config.ui.chatExecutor = 'web';
    mocks.config.ui.webProvider = 'deepseek';
    mocks.config.ui.chatBrowser = 'integrated';
    mocks.trayInstances.length = 0;
    mocks.textListeners.length = 0;
    mocks.bridgeListener = undefined;
    mocks.integratedLoadedListener = undefined;
    mocks.browserChangeListener = undefined;
    mocks.menuTemplate = undefined;
    mocks.browser = {
      visible: () => false,
      show: vi.fn(async () => undefined),
      hide: vi.fn(),
      onChange: (listener: () => void) => { mocks.browserChangeListener = listener; }
    };
    vi.mocked(writeDurableSoon).mockClear();
  });

  it('starts after icon preparation, paints localized status, and owns tray teardown', async () => {
    const openWindow = vi.fn();
    const quitApplication = vi.fn();
    const controller = createTrayController({ openWindow, quitApplication });

    await controller.start();

    const tray = mocks.trayInstances[0] as {
      setImage: ReturnType<typeof vi.fn>;
      setToolTip: ReturnType<typeof vi.fn>;
      setContextMenu: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    expect(tray.on).toHaveBeenCalledWith('click', openWindow);
    expect(tray.setToolTip).toHaveBeenCalledWith('NEURAFLOK — translated:Connected');
    expect(mocks.menuTemplate).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'translated:Open', click: openWindow }),
      expect.objectContaining({ label: 'translated:Show browser' }),
      expect.objectContaining({ label: 'translated:Quit', click: quitApplication })
    ]));
    expect(mocks.textListeners).toHaveLength(2);
    expect(mocks.bridgeListener).toBeDefined();
    expect(mocks.integratedLoadedListener).toBeDefined();

    mocks.textListeners[1]!();
    expect(writeDurableSoon).toHaveBeenCalledWith('main-texts', { Open: 'Abrir' });
    controller.destroy();
    controller.destroy();
    expect(tray.destroy).toHaveBeenCalledOnce();
    controller.refresh();
    expect(tray.setToolTip).toHaveBeenCalledTimes(1);
  });

  it('refreshes on bridge and integrated browser changes without duplicating startup', async () => {
    const controller = createTrayController({ openWindow: vi.fn(), quitApplication: vi.fn() });
    await controller.start();
    const tray = mocks.trayInstances[0] as { setContextMenu: ReturnType<typeof vi.fn> };
    const initialPaints = tray.setContextMenu.mock.calls.length;

    mocks.bridgeListener!();
    expect(tray.setContextMenu).toHaveBeenCalledTimes(initialPaints + 1);
    mocks.integratedLoadedListener!(mocks.browser);
    expect(mocks.browserChangeListener).toBeDefined();
    expect(tray.setContextMenu).toHaveBeenCalledTimes(initialPaints + 2);
    mocks.browserChangeListener!();
    expect(tray.setContextMenu).toHaveBeenCalledTimes(initialPaints + 3);
  });
});
