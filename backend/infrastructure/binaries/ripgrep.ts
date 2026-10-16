import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { pathEntries } from '../settings/env.js';

export interface RipgrepRuntimePaths {
  platform: NodeJS.Platform;
  resourcesDirectory: string | null;
  moduleDirectory: string;
  inheritedDirectories: readonly string[];
}

type RunnableFileCheck = (candidate: string, platform: NodeJS.Platform) => boolean;

export function ripgrepExecutableName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'rg.exe' : 'rg';
}

function isRunnableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatePaths(runtime: RipgrepRuntimePaths): string[] {
  const executable = ripgrepExecutableName(runtime.platform);
  const candidates: string[] = [];
  if (runtime.resourcesDirectory) candidates.push(path.join(runtime.resourcesDirectory, 'rg', executable));
  candidates.push(path.resolve(runtime.moduleDirectory, '..', '..', 'resources', 'rg', executable));
  for (const entry of runtime.inheritedDirectories) {
    const directory = entry.trim().replace(/^"|"$/g, '');
    if (directory) candidates.push(path.join(directory, executable));
  }
  return candidates;
}

export function resolveRipgrep(
  runtime: RipgrepRuntimePaths,
  isRunnable: RunnableFileCheck = isRunnableFile
): string | null {
  for (const candidate of candidatePaths(runtime)) {
    if (isRunnable(candidate, runtime.platform)) return candidate;
  }
  return null;
}

export function locateRipgrep(): string | null {
  return resolveRipgrep({
    platform: process.platform,
    resourcesDirectory: process.resourcesPath || null,
    moduleDirectory: __dirname,
    inheritedDirectories: pathEntries()
  });
}
