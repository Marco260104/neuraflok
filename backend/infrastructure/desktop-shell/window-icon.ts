import { existsSync } from 'node:fs';
import path from 'node:path';

/** Packaged Windows and Linux windows receive an explicit branded PNG; macOS uses its app-bundle icon. Unpackaged `electron-vite dev` uses the authored mark. */
export function browserWindowIconPath(
  platform: NodeJS.Platform,
  packaged: boolean,
  resourcesPath: string,
  developmentRoot?: string
): string | undefined {
  if (packaged) {
    if (platform === 'win32' || platform === 'linux') return path.join(resourcesPath, 'runtime-icon.png');
    return undefined;
  }
  if (!developmentRoot) return undefined;
  return path.join(developmentRoot, 'brand', 'LogotipoSN.png');
}

/** Prefer the app package root, then the compiled-main relative root, so `npm run dev` still finds the mark. */
export function unpackagedIconRoot(appPath: string, compiledMainRoot: string): string {
  if (existsSync(path.join(appPath, 'brand', 'LogotipoSN.png'))) return appPath;
  return compiledMainRoot;
}
