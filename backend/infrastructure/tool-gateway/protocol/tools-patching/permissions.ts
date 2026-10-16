import { rawPromises as fs } from '../../../../domains/workspace/rawfs.js';
import type { Capabilities } from '../../../../../contracts/types.js';
import type { Hunk, PatchPathResolver } from '../../../../domains/workspace/execution/apply-patch/index.js';

// Check syntax-level permissions before resolving patch effects.
export function patchCapabilityDenial(hunks: readonly Hunk[], caps: Capabilities): string | null {
  for (const hunk of hunks) {
    if (hunk.kind === 'add_file') {
      if (!caps.create) return 'TOOL_DISABLED: this patch adds a file but Create files and folders is disabled.';
      continue;
    }
    if (hunk.kind === 'delete_file') {
      if (!caps.deleteFile) return 'TOOL_DISABLED: this patch deletes a file but Delete files is disabled.';
      continue;
    }

    // A context-only chunk can express a rename without changing file content.
    const contentChange =
      hunk.movePath === null ||
      hunk.chunks.some(
        (chunk) =>
          chunk.oldLines.length !== chunk.newLines.length ||
          chunk.oldLines.some((line, index) => line !== chunk.newLines[index])
      );
    if (contentChange && !caps.edit) {
      return 'TOOL_DISABLED: this patch updates a file but Edit files is disabled.';
    }
    if (hunk.movePath !== null && !caps.move) {
      return 'TOOL_DISABLED: this patch moves a file but Move / rename is disabled.';
    }
  }
  return null;
}

// Require Edit when patch syntax would replace an existing destination.
export async function patchEffectCapabilityDenial(
  hunks: readonly Hunk[],
  caps: Capabilities,
  resolve: PatchPathResolver
): Promise<string | null> {
  const exists = async (target: string): Promise<boolean> => {
    try {
      await fs.lstat(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const samePath = (left: string, right: string): boolean =>
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

  for (const hunk of hunks) {
    if (hunk.kind === 'add_file') {
      if (!caps.edit && (await exists(resolve(hunk.path, '')))) {
        return 'TOOL_DISABLED: this patch replaces an existing file but Edit files is disabled.';
      }
      continue;
    }
    if (hunk.kind !== 'update_file' || hunk.movePath === null || caps.edit) continue;
    const source = resolve(hunk.path, '');
    const destination = resolve(hunk.movePath, '');
    if (!samePath(source, destination) && (await exists(destination))) {
      return 'TOOL_DISABLED: this patch replaces an existing move destination but Edit files is disabled.';
    }
  }
  return null;
}
