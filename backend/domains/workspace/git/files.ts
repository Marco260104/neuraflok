import type { Stats } from 'node:fs';
import path from 'node:path';
import { rawPromises as fs } from '../rawfs.js';
import { projectFileTarget } from '../file-ops/project-files/target.js';
import { MAX_GIT_TEXT_BYTES } from './limits.js';
import { decodeUtf8, repositoryFilePath, type RepositoryContext } from './repository.js';
import { runGit } from './process.js';

function sameFileState(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export async function readProjectBytes(
  projectId: string,
  relative: string,
  limit: number
): Promise<{ bytes: Buffer; tooLarge: boolean }> {
  const target = await projectFileTarget(projectId, relative, { allowRoot: false });
  if (target.kind !== 'file') throw new Error('Choose a regular file');
  const before = await fs.lstat(target.real);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Choose a regular file');
  const handle = await fs.open(target.real, 'r');
  try {
    const opened = await handle.stat();
    if (!sameFileState(before, opened)) throw new Error('The project file changed while Git changes were read');
    const tooLarge = opened.size > limit;
    const bytes = Buffer.alloc(tooLarge ? Math.min(opened.size, 8 * 1024) : opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const verified = await projectFileTarget(projectId, relative, { allowRoot: false });
    const after = await fs.lstat(target.real);
    const unchanged = verified.kind === 'file' && path.resolve(verified.real) === path.resolve(target.real) &&
      sameFileState(opened, await handle.stat()) && sameFileState(opened, after);
    if (!unchanged) throw new Error('The project file changed while Git changes were read');
    return { bytes, tooLarge };
  } finally {
    await handle.close();
  }
}

export function decodeTextFile(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try { return decodeUtf8(bytes); } catch { return null; }
}

export async function readRepositoryFile(
  context: RepositoryContext,
  relative: string,
  revision = 'HEAD'
): Promise<{ text: string | null; tooLarge: boolean }> {
  const object = `${revision}:${repositoryFilePath(context, relative)}`;
  const size = await runGit(context.projectReal, ['cat-file', '-s', object], 128);
  if (size.code !== 0) return { text: '', tooLarge: false };
  const byteCount = Number(decodeUtf8(size.stdout).trim());
  if (!Number.isFinite(byteCount) || byteCount > MAX_GIT_TEXT_BYTES) return { text: null, tooLarge: true };
  const content = await runGit(context.projectReal, ['cat-file', 'blob', object], MAX_GIT_TEXT_BYTES + 1);
  if (content.code !== 0) throw new Error(content.stderr || 'The Git base could not be read');
  return { text: decodeTextFile(content.stdout), tooLarge: false };
}

export async function readWorkingProjectFile(
  projectId: string,
  relative: string
): Promise<{ text: string | null; tooLarge: boolean }> {
  const result = await readProjectBytes(projectId, relative, MAX_GIT_TEXT_BYTES);
  return { text: result.tooLarge ? null : decodeTextFile(result.bytes), tooLarge: result.tooLarge };
}
