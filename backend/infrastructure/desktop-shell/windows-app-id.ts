import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, shell, type BrowserWindow } from 'electron';
import { packagedRuntime, runningFromDevElectron } from './runtime-packaging.js';
import { unpackagedIconRoot } from './window-icon.js';

export const WINDOWS_APP_USER_MODEL_ID = 'com.neuraflok.desktop';
export const WINDOWS_DEV_APP_USER_MODEL_ID = 'com.neuraflok.desktop.dev';

/** Unpackaged `npm run dev` must not reuse the packaged id: Windows caches that id's taskbar glyph (Electron's atom). */
export function windowsAppUserModelId(execPath = process.execPath, packaged = app.isPackaged): string {
  if (runningFromDevElectron(execPath) || !packaged) return WINDOWS_DEV_APP_USER_MODEL_ID;
  return WINDOWS_APP_USER_MODEL_ID;
}

export function unpackagedWindowsIcoPath(developmentRoot: string): string {
  return path.join(developmentRoot, 'build', 'icon.ico');
}

/** Taskbar uses the Start Menu shortcut for this AppUserModelId, not BrowserWindow.setIcon (that only feeds Alt-Tab). */
export function applyUnpackagedWindowsTaskbar(window: BrowserWindow, iconPath: string): void {
  if (process.platform !== 'win32' || packagedRuntime(app.isPackaged, process.execPath) || !existsSync(iconPath)) return;
  try {
    const appId = windowsAppUserModelId();
    app.setAppUserModelId(appId);
    window.setAppDetails({ appId, appIconPath: iconPath });
  } catch {
    // Taskbar identity must never abort the window: the integrated browser starts after this.
  }
}

function writeDevShortcut(iconPath: string): void {
  if (packagedRuntime(app.isPackaged, process.execPath) || !existsSync(iconPath)) return;
  try {
    const shortcut = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'NEURAFLOK Dev.lnk'
    );
    const details = {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      appUserModelId: WINDOWS_DEV_APP_USER_MODEL_ID,
      icon: iconPath,
      iconIndex: 0,
      description: 'NEURAFLOK'
    };
    if (!shell.writeShortcutLink(shortcut, 'replace', details)) {
      shell.writeShortcutLink(shortcut, 'create', details);
    }
  } catch {
    // A missing Start Menu write must not block app ready.
  }
}

if (process.platform === 'win32') {
  const apply = () => app.setAppUserModelId(windowsAppUserModelId());
  apply();
  app.once('ready', () => {
    apply();
    if (packagedRuntime(app.isPackaged, process.execPath)) return;
    const root = unpackagedIconRoot(app.getAppPath(), path.join(__dirname, '../..'));
    writeDevShortcut(unpackagedWindowsIcoPath(root));
  });
}
