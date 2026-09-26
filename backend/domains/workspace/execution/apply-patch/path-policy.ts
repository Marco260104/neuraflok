import nodePath from 'node:path';
import { getMetadata, invalidInput } from '../filesystem.js';
import type { Hunk } from './hunk.js';

export const MAX_PATCH_SOURCE_BYTES = 16 * 1024 * 1024;

export type PatchPathResolver = (spelledPath: string, cwd: string) => string;

export const defaultPathResolver: PatchPathResolver = (spelledPath, cwd) => nodePath.resolve(cwd, spelledPath);

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

export async function ensurePatchSourceWithinBudget(path: string, allowMissing = false): Promise<void> {
  try {
    const metadata = await getMetadata(path);
    if (metadata.isFile && metadata.size > MAX_PATCH_SOURCE_BYTES) {
      throw invalidInput(`file is too large to patch safely: limit is ${MAX_PATCH_SOURCE_BYTES} bytes`);
    }
  } catch (error) {
    if (allowMissing && errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

export async function verifyPatchFileTarget(path: string, allowMissing: boolean): Promise<void> {
  try {
    const metadata = await getMetadata(path);
    if (!metadata.isFile) throw invalidInput('patch target is not a regular file');
    if (metadata.size > MAX_PATCH_SOURCE_BYTES) {
      throw invalidInput(`file is too large to patch safely: limit is ${MAX_PATCH_SOURCE_BYTES} bytes`);
    }
  } catch (error) {
    if (allowMissing && errorCode(error) === 'ENOENT') return;
    throw error;
  }
}

export function sameResolvedPath(left: string, right: string): boolean {
  const resolvedLeft = nodePath.resolve(left);
  const resolvedRight = nodePath.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

export function resolveHunkPath(hunk: Hunk, cwd: string, resolvePath: PatchPathResolver): string {
  return resolvePath(hunk.path, cwd);
}
