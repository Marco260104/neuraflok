import { ApplyPatchError, PatchParseError } from './errors.js';
import { applyHunksToFiles } from './file-operations.js';
import type { Hunk } from './hunk.js';
import { DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE, type ApplyPatchFileUpdateMode } from './mode.js';
import { parsePatch } from './parser.js';
import {
  defaultPathResolver,
  type PatchPathResolver
} from './path-policy.js';
import type { AffectedPaths, AppliedPatchDelta } from './types.js';

export { ApplyPatchError, PatchParseError } from './errors.js';
export { parsePatch, parsePatchText, type ApplyPatchArgs } from './parser.js';
export { StreamingPatchParser } from './streaming-parser.js';
export type { Hunk, UpdateFileChunk } from './hunk.js';
export { MAX_PATCH_SOURCE_BYTES, type PatchPathResolver } from './path-policy.js';
export { verifyApplyPatchArgs, type ApplyPatchAction, type ApplyPatchFileChange } from './verification.js';
export {
  DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
  type ApplyPatchFileUpdateMode
} from './mode.js';
export type { AffectedPaths, AppliedPatchChange, AppliedPatchDelta, AppliedPatchFileChange } from './types.js';

function emptyDelta(): AppliedPatchDelta {
  return { changes: [], exact: true };
}

/** `ApplyPatchFailure`: a failure together with the mutations committed before it was observed. */
export class ApplyPatchFailure extends Error {
  readonly error: ApplyPatchError;
  readonly delta: AppliedPatchDelta;

  constructor(error: ApplyPatchError, delta: AppliedPatchDelta) {
    super(error.message, { cause: error });
    this.name = 'ApplyPatchFailure';
    this.error = error;
    this.delta = delta;
  }
}

/** Receives output lines produced by patch execution. */
export interface Writer {
  text: string;
}

function writeLine(out: Writer, line: string): void {
  out.text += `${line}\n`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `apply_patch`: applies the patch and writes the result to the given buffers. */
export async function applyPatch(
  patch: string,
  cwd: string,
  stdout: Writer,
  stderr: Writer,
  resolvePath: PatchPathResolver = defaultPathResolver
): Promise<AppliedPatchDelta> {
  return await applyPatchWithMode(
    patch,
    DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
    cwd,
    stdout,
    stderr,
    resolvePath
  );
}

/** `apply_patch_with_mode`. */
export async function applyPatchWithMode(
  patch: string,
  updateFileMode: ApplyPatchFileUpdateMode,
  cwd: string,
  stdout: Writer,
  stderr: Writer,
  resolvePath: PatchPathResolver = defaultPathResolver
): Promise<AppliedPatchDelta> {
  let hunks: Hunk[];
  try {
    hunks = parsePatch(patch).hunks;
  } catch (error) {
    if (!(error instanceof PatchParseError)) throw error;
    if (error.kind === 'invalid_patch') {
      writeLine(stderr, `Invalid patch: ${error.detail}`);
    } else {
      writeLine(stderr, `Invalid patch hunk on line ${error.lineNumber}: ${error.detail}`);
    }
    throw new ApplyPatchFailure(ApplyPatchError.fromParseError(error), emptyDelta());
  }

  return await applyHunksWithMode(hunks, updateFileMode, cwd, stdout, stderr, resolvePath);
}

/** `apply_hunks_with_mode`. */
export async function applyHunksWithMode(
  hunks: readonly Hunk[],
  updateFileMode: ApplyPatchFileUpdateMode,
  cwd: string,
  stdout: Writer,
  stderr: Writer,
  resolvePath: PatchPathResolver = defaultPathResolver
): Promise<AppliedPatchDelta> {
  const delta = emptyDelta();
  try {
    const affectedPaths = await applyHunksToFiles(hunks, updateFileMode, cwd, resolvePath, delta);
    printSummary(affectedPaths, stdout);
    return delta;
  } catch (error) {
    const message = messageOf(error);
    writeLine(stderr, message);
    const applyPatchError =
      error instanceof ApplyPatchError ? error : ApplyPatchError.io('I/O error', error);
    throw new ApplyPatchFailure(applyPatchError, delta);
  }
}

/** Writes a concise summary of changed paths. */
export function printSummary(affected: AffectedPaths, out: Writer): void {
  writeLine(out, 'Success. Updated the following files:');
  for (const path of affected.added) writeLine(out, `A ${path}`);
  for (const path of affected.modified) writeLine(out, `M ${path}`);
  for (const path of affected.deleted) writeLine(out, `D ${path}`);
}

/** Output returned to the tool layer after patch execution. */
export interface ApplyPatchExecution {
  exitCode: number;
  stdout: string;
  stderr: string;
  aggregatedOutput: string;
  durationMs: number;
  delta: AppliedPatchDelta;
}

/** Applies a patch and returns its output, duration, and file-change evidence. */
export async function executeApplyPatch(options: {
  patch: string;
  cwd: string;
  updateFileMode?: ApplyPatchFileUpdateMode;
  resolvePath?: PatchPathResolver;
}): Promise<ApplyPatchExecution> {
  const startedAt = performance.now();
  const stdout: Writer = { text: '' };
  const stderr: Writer = { text: '' };
  let delta: AppliedPatchDelta;
  let failed = false;
  try {
    delta = await applyPatchWithMode(
      options.patch,
      options.updateFileMode ?? DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
      options.cwd,
      stdout,
      stderr,
      options.resolvePath ?? defaultPathResolver
    );
  } catch (error) {
    failed = true;
    if (error instanceof ApplyPatchFailure) {
      delta = error.delta;
    } else {
      // Preserve failures raised before the patch pipeline records its own result.
      delta = emptyDelta();
      writeLine(stderr, messageOf(error));
    }
  }
  return {
    exitCode: failed ? 1 : 0,
    stdout: stdout.text,
    stderr: stderr.text,
    aggregatedOutput: `${stdout.text}${stderr.text}`,
    durationMs: performance.now() - startedAt,
    delta
  };
}

