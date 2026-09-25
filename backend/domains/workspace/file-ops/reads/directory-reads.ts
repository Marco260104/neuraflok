import nodePath from 'node:path';

import {
  MAX_WALK_DEPTH,
  MAX_WALK_DIRECTORIES,
  MAX_WALK_ENTRIES,
  getMetadata,
  readDirectory,
  walk
} from '../../execution/filesystem.js';
import { clamp } from '../limits.js';
import { isExcludedFolderName, type DirEntry } from '../directory.js';

export async function listDirectoryLevel(
  realDir: string,
  virtualDir: string,
  maxEntries: number,
  includeFileSizes = true
): Promise<{ entries: DirEntry[]; truncated: boolean }> {
  const raw = await readDirectory(realDir);
  raw.sort((left, right) => {
    const leftDir = left.isDirectory ? 0 : 1;
    const rightDir = right.isDirectory ? 0 : 1;
    return leftDir !== rightDir ? leftDir - rightDir : left.fileName.localeCompare(right.fileName);
  });

  const selected = raw.slice(0, Math.max(0, maxEntries));
  const truncated = raw.length > selected.length;
  const entries: DirEntry[] = [];
  for (const entry of selected) {
    let bytes: number | null = null;
    if (includeFileSizes && entry.isFile) {
      try {
        bytes = (await getMetadata(nodePath.join(realDir, entry.fileName))).size;
      } catch {
        bytes = null;
      }
    }
    entries.push({
      name: entry.fileName,
      virtualPath: `${virtualDir}/${entry.fileName}`,
      type: entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'other',
      bytes
    });
  }
  return { entries, truncated };
}

export async function walkFiles(
  realDir: string,
  virtualDir: string,
  options: { maxEntries: number; exclude: readonly string[] }
): Promise<{ files: string[]; truncated: boolean }> {
  const outcome = await walk(realDir, {
    maxDepth: MAX_WALK_DEPTH,
    maxDirectories: MAX_WALK_DIRECTORIES,
    maxEntries: clamp(options.maxEntries, 1, MAX_WALK_ENTRIES),
    followDirectorySymlinks: false,
    pruneDirectory: entry => isExcludedFolderName(entry.fileName, options.exclude)
  });

  const prefix = realDir.endsWith(nodePath.sep) ? realDir : realDir + nodePath.sep;
  const files: string[] = [];
  for (const entry of outcome.entries) {
    if (entry.kind !== 'file') continue;
    if (!entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length).split(nodePath.sep).join('/');
    files.push(`${virtualDir}/${relative}`);
  }
  return { files, truncated: outcome.truncated };
}
