import { existsSync } from 'node:fs';
import path from 'node:path';

/** Packaged Windows/macOS keep the executable / app-bundle icon. Packaged Linux needs an explicit PNG. Unpackaged `electron-vite dev` uses the authored mark so Windows does not keep Electron's stock icon. */
export function browserWindowIconPath(
  platform: NodeJS.Platform,
  packaged: boolean,
  resourcesPath: string,
  developmentRoot?: string
): string | undefined {
  if (packaged) {
    if (platform !== 'linux') return undefined;
    return path.join(resourcesPath, 'runtime-icon.png');
  }
  if (!developmentRoot) return undefined;
  return path.join(developmentRoot, 'brand', 'LogotipoSN.png');
}

/** Prefer the app package root, then the compiled-main relative root, so `npm run dev` still finds the mark. */
export function unpackagedIconRoot(appPath: string, compiledMainRoot: string): string {
  if (existsSync(path.join(appPath, 'brand', 'LogotipoSN.png'))) return appPath;
  return compiledMainRoot;
}
