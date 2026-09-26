import { rawPromises as fs } from '../../../../domains/workspace/rawfs.js';
import { formatBytes } from '../../../../domains/workspace/fsops.js';
import type { AppliedPatchDelta } from '../../../../domains/workspace/execution/apply-patch/index.js';
import type { PatchResolution } from './paths.js';

export interface PatchRollbackSnapshot {
  virtual: string;
  bytes: Buffer | null;
}

// Bound rollback memory when a patch touches many large files.
const MAX_PATCH_ROLLBACK_BYTES = 64 * 1024 * 1024;

async function readOptionalPatchBytes(real: string): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(real);
    if (!stat.isFile()) throw new Error('apply_patch target changed from a file before execution');
    return await fs.readFile(real);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function capturePatchRollbackSnapshots(resolution: PatchResolution): Promise<Map<string, PatchRollbackSnapshot>> {
  const snapshots = new Map<string, PatchRollbackSnapshot>();
  let total = 0;
  for (const [real, virtual] of resolution.virtualPaths) {
    const bytes = await readOptionalPatchBytes(real);
    total += bytes?.length ?? 0;
    if (total > MAX_PATCH_ROLLBACK_BYTES) {
      throw new Error(
        `apply_patch touches more than ${formatBytes(MAX_PATCH_ROLLBACK_BYTES)} of existing file data; split it into smaller patches so atomic rollback stays bounded.`
      );
    }
    snapshots.set(real, { virtual, bytes });
  }
  return snapshots;
}

function samePatchState(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function expectedPatchStates(
  snapshots: ReadonlyMap<string, PatchRollbackSnapshot>,
  delta: AppliedPatchDelta
): Map<string, Buffer | null> {
  const expected = new Map<string, Buffer | null>();
  for (const [real, snapshot] of snapshots) expected.set(real, snapshot.bytes);
  for (const { path: real, change } of delta.changes) {
    if (change.kind === 'add') {
      expected.set(real, Buffer.from(change.content, 'utf8'));
    } else if (change.kind === 'delete') {
      expected.set(real, null);
    } else if (change.movePath === null) {
      expected.set(real, Buffer.from(change.newContent, 'utf8'));
    } else {
      expected.set(real, null);
      expected.set(change.movePath, Buffer.from(change.newContent, 'utf8'));
    }
  }
  return expected;
}

// Restore only files that still match the recorded patch result.
export async function rollbackFailedPatch(
  snapshots: Map<string, PatchRollbackSnapshot>,
  delta: AppliedPatchDelta
): Promise<{ complete: boolean; note: string }> {
  const expected = expectedPatchStates(snapshots, delta);
  const problems: string[] = [];

  for (const [real, snapshot] of snapshots) {
    let current: Buffer | null;
    try {
      current = await readOptionalPatchBytes(real);
    } catch {
      problems.push(`${snapshot.virtual}: could not inspect current state`);
      continue;
    }
    if (samePatchState(current, snapshot.bytes)) continue;
    const patchState = expected.get(real) ?? null;
    if (!samePatchState(current, patchState)) {
      problems.push(`${snapshot.virtual}: changed outside the recorded patch state`);
      continue;
    }
    try {
      if (snapshot.bytes === null) await fs.rm(real, { force: true });
      else await fs.writeFile(real, snapshot.bytes);
    } catch {
      problems.push(`${snapshot.virtual}: restore failed`);
    }
  }

  // Prove the final state rather than assuming successful write/remove calls meant restoration.
  for (const [real, snapshot] of snapshots) {
    try {
      if (!samePatchState(await readOptionalPatchBytes(real), snapshot.bytes)) {
        if (!problems.some((problem) => problem.startsWith(`${snapshot.virtual}:`))) {
          problems.push(`${snapshot.virtual}: restore verification failed`);
        }
      }
    } catch {
      if (!problems.some((problem) => problem.startsWith(`${snapshot.virtual}:`))) {
        problems.push(`${snapshot.virtual}: restore verification failed`);
      }
    }
  }

  if (problems.length === 0) {
    delta.changes.splice(0);
    delta.exact = true;
    return { complete: true, note: 'All file changes from this failed patch were rolled back.' };
  }
  delta.exact = false;
  return { complete: false, note: `WARNING: failed patch rollback was incomplete: ${problems.join('; ')}` };
}
