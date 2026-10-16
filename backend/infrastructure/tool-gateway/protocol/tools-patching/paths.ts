import { SandboxError, isNativeWindowsPath } from '../../../settings/sandbox.js';
import type { Root } from '../../../../../contracts/types.js';
import type { Hunk, PatchPathResolver } from '../../../../domains/workspace/execution/apply-patch/index.js';
import { resolveIn } from '../kernel.js';

export interface PatchResolution {
  resolve: PatchPathResolver;
  // Map real paths to safe virtual paths for change records.
  virtualPaths: Map<string, string>;
  // Map real spellings to safe paths before returning tool output.
  displayRewrites: Map<string, string>;
}

export function safePatchOutput(text: string, resolution: PatchResolution): string {
  let safe = text;
  const rewrites = [...resolution.displayRewrites].sort(([a], [b]) => b.length - a.length);
  for (const [from, to] of rewrites) {
    if (from === '' || from === to || !safe.includes(from)) continue;
    safe = safe.split(from).join(to);
  }
  return safe;
}

// Resolve patch paths up front to enforce the same approved-root boundary as other file tools.
export async function resolvePatchPaths(
  roots: readonly Root[],
  baseVirtual: string,
  hunks: readonly Hunk[]
): Promise<PatchResolution> {
  const realBySpelling = new Map<string, string>();
  const virtualPaths = new Map<string, string>();
  const displayRewrites = new Map<string, string>();
  // Track sequential path presence so later hunks observe earlier adds, moves, and deletes.
  const pendingPresence = new Map<string, boolean>();
  const pathKey = (real: string): string => (process.platform === 'win32' ? real.toLowerCase() : real);

  const add = async (spelledPath: string, requireExisting: boolean): Promise<string> => {
    // Resolve a stable path identity even when a prior hunk created the leaf.
    let resolved = await resolveIn(roots, spelledPath, { base: baseVirtual, allowMissing: true });
    const state = pendingPresence.get(pathKey(resolved.real));
    // Preserve strict initial existence checks while honoring prior hunk effects.
    if (requireExisting && state === undefined) {
      resolved = await resolveIn(roots, spelledPath, { base: baseVirtual, allowMissing: false });
    }
    realBySpelling.set(spelledPath, resolved.real);
    virtualPaths.set(resolved.real, resolved.virtual);
    displayRewrites.set(resolved.real, resolved.virtual);
    if (isNativeWindowsPath(spelledPath)) displayRewrites.set(spelledPath, resolved.virtual);
    return resolved.real;
  };

  for (const hunk of hunks) {
    if (hunk.kind === 'add_file') {
      const target = await add(hunk.path, false);
      pendingPresence.set(pathKey(target), true);
      continue;
    }
    if (hunk.kind === 'delete_file') {
      const target = await add(hunk.path, true);
      pendingPresence.set(pathKey(target), false);
      continue;
    }

    const source = await add(hunk.path, true);
    if (hunk.movePath === null) {
      pendingPresence.set(pathKey(source), true);
      continue;
    }
    const destination = await add(hunk.movePath, false);
    pendingPresence.set(pathKey(source), false);
    pendingPresence.set(pathKey(destination), true);
  }

  const resolve: PatchPathResolver = (spelledPath) => {
    const resolved = realBySpelling.get(spelledPath);
    if (resolved === undefined) {
      throw new SandboxError(`Patch path was not validated before use: ${spelledPath}`);
    }
    return resolved;
  };
  return { resolve, virtualPaths, displayRewrites };
}
