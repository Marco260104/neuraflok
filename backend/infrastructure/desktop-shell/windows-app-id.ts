import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, shell, type BrowserWindow } from 'electron';
import { packagedRuntime, runningFromDevElectron } from './runtime-packaging.js';
import { unpackagedIconRoot } from './window-icon.js';

// Windows retained the old Electron taskbar glyph for the previous id. This stable
// branded id gives the installed app a fresh shell association and icon cache entry.
export const WINDOWS_APP_USER_MODEL_ID = 'com.neuraflok.desktop.app';
export const WINDOWS_DEV_APP_USER_MODEL_ID = 'com.neuraflok.desktop.dev';

/** Unpackaged `npm run dev` must not reuse the packaged id: Windows caches that id's taskbar glyph (Electron's atom). */
export function windowsAppUserModelId(execPath = process.execPath, packaged = app.isPackaged): string {
  if (runningFromDevElectron(execPath) || !packaged) return WINDOWS_DEV_APP_USER_MODEL_ID;
  return WINDOWS_APP_USER_MODEL_ID;
}

export function unpackagedWindowsIcoPath(developmentRoot: string): string {
  return path.join(developmentRoot, 'build', 'icon.ico');
}

/** Pair every Windows window with the same AppUserModelId and ICO as its Start Menu app. */
export function applyWindowsTaskbar(window: BrowserWindow, iconPath: string): void {
  if (process.platform !== 'win32' || !existsSync(iconPath)) return;
  try {
    const appId = windowsAppUserModelId();
    app.setAppUserModelId(appId);
    window.setAppDetails({ appId, appIconPath: iconPath });
  } catch {
    // Taskbar identity must never abort the window: the integrated browser starts after this.
  }
}

function writeStartMenuShortcut(fileName: string, appId: string, iconPath: string): void {
  if (!existsSync(iconPath)) return;
  try {
    const shortcut = path.join(
      app.getPath('appData'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      fileName
    );
    const details = {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      appUserModelId: appId,
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

function writeDevShortcut(iconPath: string): void {
  if (packagedRuntime(app.isPackaged, process.execPath)) return;
  writeStartMenuShortcut('NEURAFLOK Dev.lnk', WINDOWS_DEV_APP_USER_MODEL_ID, iconPath);
}

function writeInstalledShortcut(iconPath: string): void {
  if (!packagedRuntime(app.isPackaged, process.execPath)) return;
  writeStartMenuShortcut('NEURAFLOK.lnk', WINDOWS_APP_USER_MODEL_ID, iconPath);
}

if (process.platform === 'win32') {
  const apply = () => app.setAppUserModelId(windowsAppUserModelId());
  apply();
  app.once('ready', () => {
    apply();
    if (packagedRuntime(app.isPackaged, process.execPath)) {
      writeInstalledShortcut(path.join(process.resourcesPath, 'app-icon.ico'));
      return;
    }
    const root = unpackagedIconRoot(app.getAppPath(), path.join(__dirname, '../..'));
    writeDevShortcut(unpackagedWindowsIcoPath(root));
  });
}
