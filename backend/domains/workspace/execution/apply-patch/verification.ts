import { readFileText, invalidInput } from '../filesystem.js';
import { ApplyPatchError } from './errors.js';
import { deriveNewContentsFromChunks } from './file-update.js';
import { type Hunk } from './hunk.js';
import type { ApplyPatchFileUpdateMode } from './mode.js';
import {
  defaultPathResolver,
  resolveHunkPath,
  sameResolvedPath,
  verifyPatchFileTarget,
  type PatchPathResolver
} from './path-policy.js';

export type ApplyPatchFileChange =
  | { kind: 'add'; content: string }
  | { kind: 'delete'; content: string }
  | { kind: 'update'; movePath: string | null; newContent: string };

export interface ApplyPatchAction {
  changes: Map<string, ApplyPatchFileChange>;
  updateFileMode: ApplyPatchFileUpdateMode;
  patch: string;
  cwd: string;
}

type SimulatedFile = { readonly present: true; readonly content: string } | { readonly present: false };

function removedEarlierInPatch(context: string): ApplyPatchError {
  return ApplyPatchError.io(context, new Error('an earlier hunk in this patch removed it'));
}

export async function verifyApplyPatchArgs(
  args: { patch: string; hunks: readonly Hunk[]; workdir: string | null },
  cwd: string,
  updateFileMode: ApplyPatchFileUpdateMode,
  resolvePath: PatchPathResolver = defaultPathResolver
): Promise<ApplyPatchAction> {
  const effectiveCwd = args.workdir === null ? cwd : resolvePath(args.workdir, cwd);
  const changes = new Map<string, ApplyPatchFileChange>();
  const simulatedFiles = new Map<string, SimulatedFile>();

  for (const hunk of args.hunks) {
    const path = resolveHunkPath(hunk, effectiveCwd, resolvePath);
    const priorState = simulatedFiles.get(path);
    if (priorState === undefined) await verifyPatchFileTarget(path, hunk.kind === 'add_file');

    if (hunk.kind === 'add_file') {
      changes.set(path, { kind: 'add', content: hunk.contents });
      simulatedFiles.set(path, { present: true, content: hunk.contents });
      continue;
    }

    if (hunk.kind === 'delete_file') {
      let content: string;
      if (priorState === undefined) {
        try {
          content = await readFileText(path);
        } catch (error) {
          throw ApplyPatchError.io(`Failed to read ${path}`, error);
        }
      } else if (priorState.present) {
        content = priorState.content;
      } else {
        throw removedEarlierInPatch(`Failed to read ${path}`);
      }
      changes.set(path, { kind: 'delete', content });
      simulatedFiles.set(path, { present: false });
      continue;
    }

    if (priorState !== undefined && !priorState.present) {
      throw removedEarlierInPatch(`Failed to read file to update ${path}`);
    }

    const { newContents } = await deriveNewContentsFromChunks(
      path,
      hunk.chunks,
      updateFileMode,
      priorState?.present === true ? priorState.content : undefined
    );
    const destination = hunk.movePath === null ? null : resolvePath(hunk.movePath, effectiveCwd);

    if (destination !== null && sameResolvedPath(path, destination)) {
      throw invalidInput('move source and destination resolve to the same file');
    }
    if (destination !== null && !simulatedFiles.has(destination)) {
      await verifyPatchFileTarget(destination, true);
    }

    changes.set(path, { kind: 'update', movePath: destination, newContent: newContents });
    if (destination === null) {
      simulatedFiles.set(path, { present: true, content: newContents });
    } else {
      simulatedFiles.set(path, { present: false });
      simulatedFiles.set(destination, { present: true, content: newContents });
    }
  }

  return { changes, updateFileMode, patch: args.patch, cwd: effectiveCwd };
}
