// Owns the main BrowserWindow lifecycle and its persisted presentation state.

import path from 'node:path';
import { app, BrowserWindow, Menu, screen } from 'electron';
import { getConfig, logError, logInfo } from '../infrastructure/settings/index.js';
import { freshDevelopmentRendererUrl, loadFreshDevelopmentRenderer } from './window-load.js';
import {
  UI_BASE_ZOOM, windowLayoutForDisplays, windowPlacementWasMaximized, titleBarOverlayForTheme, windowBackgroundForTheme,
  trackNormalWindowBounds, browserWindowIconPath, unpackagedIconRoot, unpackagedWindowsIcoPath,
  applyUnpackagedWindowsTaskbar, editContextMenuTemplate, packagedRuntime,
  type WindowPlacement
} from '../infrastructure/desktop-shell/index.js';

export function createMainWindowController(options: {
  isQuitting: () => boolean;
  onBoundsChanged: (placement: WindowPlacement) => void;
}): {
  getWindow: () => BrowserWindow | null;
  setSavedBounds: (bounds: unknown) => void;
  showWindow: () => void;
} {
  let window: BrowserWindow | null = null;
  let savedWindowBounds: unknown = null;
  const benignRendererErrors = new Set(['ResizeObserver loop completed with undelivered notifications.']);

  function createWindow(): void {
    const primaryWorkArea = screen.getPrimaryDisplay().workArea;
    const { layout, restored } = windowLayoutForDisplays(
      primaryWorkArea,
      screen.getAllDisplays().map(display => display.workArea),
      savedWindowBounds
    );
    const restoreMaximized = windowPlacementWasMaximized(savedWindowBounds);
    const developmentRoot = unpackagedIconRoot(app.getAppPath(), path.join(__dirname, '../..'));
    const packaged = packagedRuntime(app.isPackaged, process.execPath);
    const icon = browserWindowIconPath(
      process.platform,
      packaged,
      process.resourcesPath,
      developmentRoot
    );
    window = new BrowserWindow({
      ...layout,
      ...(icon ? { icon } : {}),
      // Preserve the native macOS green-button fullscreen action.
      fullscreenable: process.platform === 'darwin',
      show: false,
      autoHideMenuBar: true,
      ...(process.platform === 'win32' ? {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: titleBarOverlayForTheme(getConfig().ui.theme, getConfig().ui.appearance)
      } : {}),
      // macOS: the app's own top bar is the title bar, with the traffic lights inside it, instead of a native title row above a second row that only held the sidebar and View buttons. The overlay publishes the traffic-light area as env(titlebar-area-x) to the page.
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: true } : {}),
      // Painted before the renderer loads, so a dark window never flashes white.
      backgroundColor: windowBackgroundForTheme(getConfig().ui.theme, getConfig().ui.appearance),
      title: 'NEURAFLOK',
      webPreferences: {
        zoomFactor: UI_BASE_ZOOM,
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        // The renderer only ever loads our own local files.
        webSecurity: true
      }
    });

    if (process.platform === 'win32') window.removeMenu();
    const owner = window;
    if (icon && process.platform !== 'darwin') owner.setIcon(icon);
    if (process.platform === 'win32' && !packaged) {
      applyUnpackagedWindowsTaskbar(owner, unpackagedWindowsIcoPath(developmentRoot));
    }

    window.once('ready-to-show', () => {
      // A renderer can finish loading after Cmd+Q has already entered bounded teardown. Never let that late native event make the app visible again while `will-quit` is draining.
      if (!options.isQuitting()) {
        // Fresh installs retain the existing maximized first presentation. A saved normal window stays normal; a window last used maximized restores that presentation over its saved normal rectangle so un-maximizing returns to the same user-sized geometry.
        if ((!restored || restoreMaximized) && !window?.isFullScreen()) window?.maximize();
        showWindow();
        // Start observing only after initial native presentation has settled. BrowserWindow construction/maximization can itself emit geometry events; those are not user choices.
        trackNormalWindowBounds(owner, (placement) => {
          savedWindowBounds = placement;
          options.onBoundsChanged(placement);
        });
      }
    });

    // A renderer that fails to load leaves a blank window with no other clue, so record it where the diagnostics panel can show it.
    window.webContents.on('did-finish-load', () => logInfo('window loaded'));
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F11' || input.isAutoRepeat) return;
      event.preventDefault();
      window?.setFullScreen(!window.isFullScreen());
    });
    window.webContents.on('context-menu', (_event, params) => {
      const owner = window;
      if (!owner || owner.isDestroyed()) return;
      const template = editContextMenuTemplate(params);
      if (template.length) Menu.buildFromTemplate(template).popup({ window: owner });
    });
    window.webContents.on('did-fail-load', (_event, code, description) =>
      logError(`window failed to load (${code}): ${description}`)
    );
    // Renderer errors are otherwise invisible from here. Only errors, and only the message text — never anything the page was working with.
    window.webContents.on('console-message', (details) => {
      // Chromium's ResizeObserver notice is not a failure: the composer's height animation starts inside its observer by design, and the deferred notification arrives on the next frame. Logged as an error it appeared on every send and read like a renderer fault.
      if (details.level === 'error' && !benignRendererErrors.has(details.message)) logError(`renderer: ${details.message}`);
    });

    // Nothing in this app should ever open a second window or navigate away.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());

    window.on('close', (event) => {
      if (!options.isQuitting() && getConfig().ui.minimizeToTray) {
        event.preventDefault();
        window?.hide();
      }
    });

    // Electron keeps the object after the window is gone, and every member on it throws from then on. Holding that reference made `getWindow()` answer "yes, there is a window" for the rest of the process, so the renderer pushes and the tray's Open both aimed at a corpse. Dropping it is what makes those paths take their existing null branch.
    window.on('closed', () => {
      window = null;
    });

    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    if (rendererUrl) {
      const developmentWindow = window;
      const freshRendererUrl = freshDevelopmentRendererUrl(rendererUrl);
      void loadFreshDevelopmentRenderer(
        () => developmentWindow.webContents.session.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] }),
        () => developmentWindow.webContents.session.clearCache(),
        () => developmentWindow.loadURL(freshRendererUrl)
      );
    } else {
      void window.loadFile(path.join(__dirname, '../renderer/index.html'));
    }
  }

  function showWindow(): void {
    // Defense in depth for every current or future native activation source. The explicit gate below additionally protects the long pre-window startup interval, while this invariant makes a direct caller harmless once `before-quit` has started.
    if (options.isQuitting()) return;
    if (!window) {
      createWindow();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  return {
    getWindow: () => window,
    setSavedBounds: (bounds) => { savedWindowBounds = bounds; },
    showWindow
  };
}
