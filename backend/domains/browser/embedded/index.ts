/** The integrated browser module loads only when the user selects it. */
import { app, ipcMain, Notification } from 'electron';
import path from 'node:path';
import { bridgeStatus, onBridgeChange, webProvidersStatus } from '../bridge.js';
import { getConfig, updateConfig } from '../../../infrastructure/settings/config.js';
import { logWarn } from '../../../infrastructure/settings/logger.js';
import { mainText } from '../../../infrastructure/settings/main-texts.js';
import { IntegratedBrowser } from './host.js';

// Resolve bundled preload and renderer resources from the app root.
const out = path.join(app.getAppPath(), 'out');

export const integratedBrowser = new IntegratedBrowser({
  preloadDir: path.join(out, 'preload'),
  rendererDir: path.join(out, 'renderer'),
  rendererUrl: () => process.env.ELECTRON_RENDERER_URL ?? null,
  onUserHide: showTrayHint
});

/** Shows one tray notice after the user hides the browser for the first time. */
function showTrayHint(): void {
  if (getConfig().ui.integratedBrowserTrayHint === true) return;
  void updateConfig(config => ({ ...config, ui: { ...config.ui, integratedBrowserTrayHint: true } }))
    .then(() => {
      if (!Notification.isSupported()) return;
      new Notification({
        title: mainText('The NEURAFLOK browser is still running'),
        body: mainText(process.platform === 'darwin'
          ? 'Your chats keep going. Choose Show browser in the menu bar icon’s menu to bring it back.'
          : 'Your chats keep going. Choose Show browser in the tray icon’s menu to bring it back.')
      }).show();
    })
    .catch(error => logWarn(`integrated browser: tray notice: ${error instanceof Error ? error.message : String(error)}`));
}

/** The dot on the toolbar's companion button: does its extension reach the app right now. */
function paintCompanion(): void {
  void bridgeStatus().then(status => integratedBrowser.setAppConnected(status.present === true)).catch(() => undefined);
}

// Hooks for the running browser only; while it is stopped they do no work.
onBridgeChange(() => {
  if (!integratedBrowser.running()) return;
  paintCompanion();
  integratedBrowser.setWebProviderPresence(webProvidersStatus());
});
ipcMain.on('integrated-browser:toolbar', (event, action: unknown, tabId: unknown) => {
  if (integratedBrowser.running() && typeof action === 'string') integratedBrowser.toolbarAction(event.sender, action, tabId);
});
/** Starts the app-owned browser once and leaves provider tabs available for background work. */
export function syncIntegratedBrowser(): void {
  void integratedBrowser.start().then(() => {
    paintCompanion(); integratedBrowser.setWebProviderPresence(webProvidersStatus());
  })
    .catch(error => logWarn(`integrated browser: could not start: ${error instanceof Error ? error.message : String(error)}`));
}
