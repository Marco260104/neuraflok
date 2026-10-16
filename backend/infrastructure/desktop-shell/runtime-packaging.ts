/** Stamped `npm run dev` copies Electron to `.dev-electron/NEURAFLOK.exe`. Electron then reports `app.isPackaged` because the basename is not `electron.exe`, while resources still live in the project tree. */

export function runningFromDevElectron(execPath: string): boolean {
  return execPath.replace(/\\/g, '/').toLowerCase().includes('/.dev-electron/');
}

export function packagedRuntime(packaged: boolean, execPath: string): boolean {
  return packaged && !runningFromDevElectron(execPath);
}
