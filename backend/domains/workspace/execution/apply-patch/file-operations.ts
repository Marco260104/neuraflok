import nodePath from 'node:path';

import { createDirectory, getMetadata, invalidInput, readFileText, remove, writeFile } from '../filesystem.js';
import { deriveNewContentsFromChunks } from './file-update.js';
import { hunkPath, type Hunk } from './hunk.js';
import type { ApplyPatchFileUpdateMode } from './mode.js';
import {
  ensurePatchSourceWithinBudget,
  errorCode,
  resolveHunkPath,
  type PatchPathResolver
} from './path-policy.js';
import type { AffectedPaths, AppliedPatchDelta } from './types.js';

async function withContext<T>(work: Promise<T>, context: () => string): Promise<T> {
  try {
    return await work;
  } catch (error) {
    throw new Error(context(), { cause: error });
  }
}

export async function applyHunksToFiles(
  hunks: readonly Hunk[],
  updateFileMode: ApplyPatchFileUpdateMode,
  cwd: string,
  resolvePath: PatchPathResolver,
  delta: AppliedPatchDelta
): Promise<AffectedPaths> {
  if (hunks.length === 0) throw new Error('No files were modified.');

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  // A failed write can still change disk state, so the recorded delta becomes uncertain.
  const tryWrite = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      delta.exact = false;
      throw error;
    }
  };

  for (const hunk of hunks) {
    const affectedPath = hunkPath(hunk);
    const resolved = resolveHunkPath(hunk, cwd, resolvePath);

    if (hunk.kind === 'add_file') {
      await ensurePatchSourceWithinBudget(resolved, true);
      const overwrittenContent = await readOptionalFileTextForDelta(resolved, delta);
      await tryWrite(writeFileWithMissingParentRetry(resolved, hunk.contents));
      delta.changes.push({
        path: resolved,
        change: { kind: 'add', content: hunk.contents, overwrittenContent }
      });
      added.push(affectedPath);
      continue;
    }

    if (hunk.kind === 'delete_file') {
      await ensurePatchSourceWithinBudget(resolved);
      await noteExistingPathDeltaSupport(resolved, delta);
      let deletedContent: string | null = null;
      try {
        deletedContent = await readFileText(resolved);
      } catch {
        delta.exact = false;
      }
      await withContext(ensureNotDirectory(resolved), () => `Failed to delete file ${resolved}`);
      try {
        await withContext(
          remove(resolved, { recursive: false, force: false }),
          () => `Failed to delete file ${resolved}`
        );
      } catch (error) {
        const sideEffectFree = await removeFailureWasSideEffectFree(resolved, deletedContent);
        delta.exact = delta.exact && sideEffectFree;
        throw error;
      }
      if (deletedContent !== null) {
        delta.changes.push({ path: resolved, change: { kind: 'delete', content: deletedContent } });
      }
      deleted.push(affectedPath);
      continue;
    }

    await ensurePatchSourceWithinBudget(resolved);
    await noteExistingPathDeltaSupport(resolved, delta);
    const { originalContents, newContents } = await deriveNewContentsFromChunks(
      resolved,
      hunk.chunks,
      updateFileMode
    );

    if (hunk.movePath !== null) {
      const destination = resolvePath(hunk.movePath, cwd);
      const overwrittenMoveContent = await readOptionalFileTextForDelta(destination, delta);
      await tryWrite(writeFileWithMissingParentRetry(destination, newContents));
      const destinationChangeIndex = delta.changes.length;
      delta.changes.push({
        path: destination,
        change: { kind: 'add', content: newContents, overwrittenContent: overwrittenMoveContent }
      });
      try {
        await withContext(ensureNotDirectory(resolved), () => `Failed to remove original ${resolved}`);
        await withContext(
          remove(resolved, { recursive: false, force: false }),
          () => `Failed to remove original ${resolved}`
        );
      } catch (error) {
        const sideEffectFree = await removeFailureWasSideEffectFree(resolved, originalContents);
        delta.exact = delta.exact && sideEffectFree;
        // Restore the destination only when the source is confirmed unchanged.
        if (sideEffectFree) {
          let destinationStillOurs = false;
          try {
            destinationStillOurs = (await readFileText(destination)) === newContents;
          } catch {
            destinationStillOurs = false;
          }
          // Only roll back a destination that still contains the content written by this move.
          if (!destinationStillOurs) {
            delta.exact = false;
            throw error;
          }
          try {
            if (overwrittenMoveContent === null) {
              await remove(destination, { recursive: false, force: true });
            } else {
              await writeFile(destination, overwrittenMoveContent);
            }
            delta.changes.splice(destinationChangeIndex, 1);
          } catch {
            delta.exact = false;
          }
        }
        throw error;
      }
      delta.changes[destinationChangeIndex] = {
        path: resolved,
        change: {
          kind: 'update',
          movePath: destination,
          oldContent: originalContents,
          overwrittenMoveContent,
          newContent: newContents
        }
      };
      modified.push(affectedPath);
      continue;
    }

    await tryWrite(
      withContext(writeFile(resolved, newContents), () => `Failed to write file ${resolved}`)
    );
    delta.changes.push({
      path: resolved,
      change: {
        kind: 'update',
        movePath: null,
        oldContent: originalContents,
        overwrittenMoveContent: null,
        newContent: newContents
      }
    });
    modified.push(affectedPath);
  }

  return { added, modified, deleted };
}

async function ensureNotDirectory(path: string): Promise<void> {
  const metadata = await getMetadata(path);
  if (metadata.isDirectory) throw invalidInput('path is a directory');
}

async function removeFailureWasSideEffectFree(
  path: string,
  expectedContent: string | null
): Promise<boolean> {
  if (expectedContent === null) return false;
  try {
    return (await readFileText(path)) === expectedContent;
  } catch {
    return false;
  }
}

async function readOptionalFileTextForDelta(path: string, delta: AppliedPatchDelta): Promise<string | null> {
  await noteExistingPathDeltaSupport(path, delta);
  try {
    return await readFileText(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    delta.exact = false;
    return null;
  }
}

async function noteExistingPathDeltaSupport(path: string, delta: AppliedPatchDelta): Promise<void> {
  try {
    const metadata = await getMetadata(path);
    if (!(metadata.isFile && !metadata.isSymlink)) delta.exact = false;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') delta.exact = false;
  }
}

async function writeFileWithMissingParentRetry(path: string, contents: string): Promise<void> {
  try {
    await writeFile(path, contents);
    return;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new Error(`Failed to write file ${path}`, { cause: error });
    }
  }
  const parent = nodePath.dirname(path);
  await withContext(
    createDirectory(parent, { recursive: true }),
    () => `Failed to create parent directories for ${path}`
  );
  await withContext(writeFile(path, contents), () => `Failed to write file ${path}`);
}
