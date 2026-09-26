// Owns the native tray lifecycle and its live status menu.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';
import {
  getConfig,
  logWarn,
  mainText,
  mainTextTranslations,
  onMainTextsChange,
  writeDurableSoon
} from '../infrastructure/settings/index.js';
import {
  onBridgeChange,
  onIntegratedBrowserLoaded,
  loadedIntegratedBrowser,
  webProvidersStatus
} from '../domains/browser/index.js';
import { usesBrowserProvider } from '../../contracts/chat-protocol.js';
import {
  trayGuidArgsForPlatform,
  trayImageSpec,
  trayMarkPath,
  type TrayImageSpec
} from '../infrastructure/desktop-shell/index.js';
import { packagedRuntime } from '../infrastructure/desktop-shell/runtime-packaging.js';
import { unpackagedIconRoot } from '../infrastructure/desktop-shell/window-icon.js';

export const MAIN_TEXTS_STATE = 'main-texts';

export interface TrayControllerOptions {
  openWindow: () => void;
  quitApplication: () => void;
}

export function createTrayController(options: TrayControllerOptions) {
  let tray: Tray | null = null;
  let trayImages: { connected: Electron.NativeImage; disconnected: Electron.NativeImage } | null = null;

  function nativeTrayImage(spec: TrayImageSpec): Electron.NativeImage {
    const [base, ...highDpi] = spec.representations;
    const image = nativeImage.createFromBuffer(base.png, { scaleFactor: base.scaleFactor });
    for (const representation of highDpi) {
      image.addRepresentation({
        scaleFactor: representation.scaleFactor,
        dataURL: `data:image/png;base64,${representation.png.toString('base64')}`
      });
    }
    if (spec.template) image.setTemplateImage(true);
    return image;
  }

  async function initializeTrayImages(): Promise<void> {
    const packaged = packagedRuntime(app.isPackaged, process.execPath);
    const appPath = packaged ? app.getAppPath() : unpackagedIconRoot(app.getAppPath(), path.join(__dirname, '../..'));
    const markPath = trayMarkPath(packaged, appPath, process.resourcesPath);
    const mark = readFileSync(markPath);
    const image = await trayImageSpec(process.platform, false, mark).then(nativeTrayImage);
    trayImages = { connected: image, disconnected: image };
  }

  function trayIcon(running: boolean): Electron.NativeImage {
    const image = trayImages?.[running ? 'connected' : 'disconnected'];
    if (!image) throw new Error('Tray images are not initialized');
    return image;
  }

  function refresh(): void {
    if (!tray) return;
    const browserExecutor = usesBrowserProvider(getConfig().ui.chatExecutor);
    const provider = getConfig().ui.webProvider ?? 'deepseek';
    const connected = browserExecutor && webProvidersStatus()[provider]?.signedIn === true;
    const label = mainText(connected ? 'Connected' : 'Not connected');
    tray.setImage(trayIcon(connected));
    // Keep translated nouns in their original casing.
    tray.setToolTip(`NEURAFLOK — ${label}`);
    const integratedBrowser = loadedIntegratedBrowser();
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label, enabled: false },
        { type: 'separator' },
        { label: mainText('Open'), click: options.openWindow },
        ...(integratedBrowser && getConfig().ui.chatBrowser === 'integrated' ? [{
          label: mainText(integratedBrowser.visible() ? 'Hide browser' : 'Show browser'),
          click: () => {
            if (integratedBrowser.visible()) integratedBrowser.hide();
            else void integratedBrowser.show().catch(error => logWarn(`integrated browser: could not show: ${error instanceof Error ? error.message : String(error)}`));
          }
        }] : []),
        { type: 'separator' },
        { label: mainText('Quit'), click: options.quitApplication }
      ])
    );
  }

  async function start(): Promise<void> {
    await initializeTrayImages();
    tray = new Tray(trayIcon(false), ...trayGuidArgsForPlatform());
    tray.on('click', options.openWindow);
    refresh();
    onBridgeChange(refresh);
    onIntegratedBrowserLoaded(integratedBrowser => { integratedBrowser.onChange(refresh); refresh(); });
    onMainTextsChange(refresh);
    onMainTextsChange(() => writeDurableSoon(MAIN_TEXTS_STATE, mainTextTranslations()));
  }

  function destroy(): void {
    tray?.destroy();
    tray = null;
  }

  return { start, refresh, destroy };
}
