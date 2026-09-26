import { rawPromises as fs, rawRealpathNative } from '../../../domains/workspace/rawfs.js';
import path from 'node:path';

import type { Root } from '../../../../contracts/types.js';
import { IS_WINDOWS, WSL_PATH, SandboxError, isContained, nativePathIdentity } from './path-policy.js';
export async function canonicalRealpath(target: string): Promise<string> {
  return IS_WINDOWS ? rawRealpathNative(target) : fs.realpath(target);
}

/** Windows treats these as devices no matter which directory they appear in. */

export async function realpathDeepest(absPath: string): Promise<{ real: string; missing: string[] }> {
  let current = path.resolve(absPath);
  const missing: string[] = [];
  for (;;) {
    try {
      return { real: await canonicalRealpath(current), missing };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      if (IS_WINDOWS && WSL_PATH.test(current)) {
        // The WSL redirector can report ENOENT for an existing Linux link it cannot canonicalize. Never interpret that link as a missing path available for writes.
        const exists = await fs.lstat(current).then(() => true, (probe: NodeJS.ErrnoException) => {
          if (probe.code === 'ENOENT' || probe.code === 'ENOTDIR') return false;
          throw new SandboxError('Path could not be resolved safely');
        });
        if (exists) throw new SandboxError('Path contains a link that could not be resolved');
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new SandboxError('Path has no existing parent directory');
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
}

/** Reads the canonical path of an approved root, failing loudly if it has gone away. */
export async function realRoot(root: Root): Promise<string> {
  try {
    const current = await canonicalRealpath(root.path);
    // roots:add persists validateNewRoot()'s canonical path. Re-resolving that pathname is a liveness check, not permission to follow a new reparse target: otherwise replacing the approved directory itself with a junction silently moves the sandbox boundary to whatever unapproved tree the junction names. isContained() applies the native path's case rules.
    if (!isContained(root.path, current) || !isContained(current, root.path)) {
      throw new SandboxError(`Root "/${root.name}" changed on disk. Remove it and approve the folder again.`);
    }
    return current;
  } catch {
    throw new SandboxError(`Root "/${root.name}" is not available or changed on disk. Remove it and approve the folder again.`);
  }
}


export function toVirtualPath(root: Root, rootReal: string, realPath: string): string {
  // path.win32.relative folds case even on WSL. Containment already proved the Linux prefix, so retain the exact suffix and treat only the local host/distro as aliases.
  const rel = IS_WINDOWS && WSL_PATH.test(path.resolve(rootReal)) && isContained(rootReal, realPath)
    ? nativePathIdentity(realPath).slice(nativePathIdentity(rootReal).replace(/\\$/, '').length).replace(/^\\/, '')
    : path.relative(rootReal, realPath);
  if (rel === '') return `/${root.name}`;
  return `/${root.name}/${rel.split(path.sep).join('/')}`;
}

/** Validates a folder the user picked in the UI before it becomes a root. Allows local WSL folders, rejects other network paths and overlapping roots. */

