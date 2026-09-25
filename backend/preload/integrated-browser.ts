/** Toolbar of a NEURAFLOK browser window: its state in, tab actions out. Main checks every action. */
import { contextBridge, ipcRenderer } from 'electron';
import type { IntegratedBrowserToolbarAction, IntegratedBrowserToolbarState } from '../../contracts/browser/integrated-browser-toolbar.js';

contextBridge.exposeInMainWorld('integratedBrowser', {
  act: (action: IntegratedBrowserToolbarAction, tabId?: number): void => ipcRenderer.send('integrated-browser:toolbar', action, tabId),
  onState: (listener: (state: IntegratedBrowserToolbarState) => void): void => {
    ipcRenderer.on('integrated-browser:state', (_event, state: IntegratedBrowserToolbarState) => listener(state));
  }
});
