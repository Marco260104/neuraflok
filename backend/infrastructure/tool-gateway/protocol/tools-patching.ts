import { rawPromises as fs } from '../../../domains/workspace/rawfs.js';
import { logInfo } from '../../settings/logger.js';
import type { Capabilities, Root } from '../../../../contracts/types.js';
import {
  ApplyPatchError,
  PatchParseError,
  executeApplyPatch,
  verifyApplyPatchArgs,
  type Hunk
} from '../../../domains/workspace/execution/apply-patch/index.js';
import { DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE } from '../../../domains/workspace/execution/apply-patch/mode.js';
import { formatCommandResult } from '../../../domains/workspace/execution/exec-output.js';
import { DEFAULT_TRUNCATION_POLICY } from '../../../domains/workspace/execution/manager.js';
import { noteChanges } from './call-context.js';
import { fail, friendlyError, ok, resolveIn, type ToolResult } from './kernel.js';
import { capturePatchRollbackSnapshots, rollbackFailedPatch, type PatchRollbackSnapshot } from './tools-patching/rollback.js';
import { patchCapabilityDenial, patchEffectCapabilityDenial } from './tools-patching/permissions.js';
import { resolvePatchPaths, safePatchOutput, type PatchResolution } from './tools-patching/paths.js';
import { patchFileChanges } from './tools-patching/changes.js';

export function applyPatchErrorText(error: unknown, includeSourceContext = false): string {
  if (error instanceof ApplyPatchError && includeSourceContext && error.sourceContext) {
    return `${error.message}\n\n${error.sourceContext}`;
  }
  return error instanceof PatchParseError || error instanceof ApplyPatchError ? error.message : friendlyError(error);
}

interface ParsedPatchRun {
  result: ToolResult;
  content: string | null;
  exitCode: number | null;
}

// Existing bytes allow a failed patch to restore its original files.

export async function runParsedPatch(
  args: { patch: string; hunks: Hunk[]; workdir: string | null; environmentId: string | null },
  roots: readonly Root[],
  base: { real: string; virtual: string },
  caps?: Capabilities
): Promise<ParsedPatchRun> {
  if (caps !== undefined) {
    // Standalone patches use file permissions; shell interception uses the command permission.
    const denial = patchCapabilityDenial(args.hunks, caps);
    if (denial !== null) return { result: fail(denial), content: null, exitCode: null };
  }

  // Resolve the shell-level workdir once before patch verification.
  let effectiveBase = base;
  let effectiveArgs = args;
  if (args.workdir !== null) {
    try {
      // Require an existing directory because the intercepted shell command would not create it.
      effectiveBase = await resolveIn(roots, args.workdir, { base: base.virtual });
      const stat = await fs.stat(effectiveBase.real);
      if (!stat.isDirectory()) {
        return { result: fail('apply_patch workdir must be an existing folder'), content: null, exitCode: null };
      }
    } catch (error) {
      return { result: fail(friendlyError(error)), content: null, exitCode: null };
    }
    effectiveArgs = { ...args, workdir: null };
  }

  // Validate every patch path through the approved-root resolver before execution.
  let resolution: PatchResolution;
  try {
    resolution = await resolvePatchPaths(roots, effectiveBase.virtual, effectiveArgs.hunks);
  } catch (error) {
    return { result: fail(friendlyError(error)), content: null, exitCode: null };
  }
  if (caps !== undefined) {
    try {
      const denial = await patchEffectCapabilityDenial(effectiveArgs.hunks, caps, resolution.resolve);
      if (denial !== null) return { result: fail(denial), content: null, exitCode: null };
    } catch (error) {
      return { result: fail(friendlyError(error)), content: null, exitCode: null };
    }
  }
  // Preserve line endings for move-only permission because content changes already require Edit.
  const patchUpdateMode = caps !== undefined && !caps.edit ? 'preserve_line_endings' : DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE;

  try {
    await verifyApplyPatchArgs(
      effectiveArgs,
      effectiveBase.real,
      patchUpdateMode,
      resolution.resolve
    );
  } catch (error) {
    return {
      result: fail(`apply_patch verification failed: ${safePatchOutput(applyPatchErrorText(error, caps?.read === true), resolution)}`),
      content: null,
      exitCode: null
    };
  }

  let rollbackSnapshots: Map<string, PatchRollbackSnapshot> | null = null;
  if (caps !== undefined) {
    try {
      rollbackSnapshots = await capturePatchRollbackSnapshots(resolution);
    } catch (error) {
      return { result: fail(friendlyError(error)), content: null, exitCode: null };
    }
  }

  const execution = await executeApplyPatch({
    patch: effectiveArgs.patch,
    cwd: effectiveBase.real,
    updateFileMode: patchUpdateMode,
    resolvePath: resolution.resolve
  });
  let rollbackNote = '';
  if (execution.exitCode !== 0 && rollbackSnapshots !== null) {
    const rollback = await rollbackFailedPatch(rollbackSnapshots, execution.delta);
    rollbackNote = rollback.note;
  }
  const stdout = safePatchOutput(execution.stdout, resolution);
  const stderr = safePatchOutput(`${execution.stderr}${rollbackNote ? `${execution.stderr.endsWith('\n') || execution.stderr === '' ? '' : '\n'}${rollbackNote}\n` : ''}`, resolution);
  const content = formatCommandResult({
    exitCode: execution.exitCode,
    stdout,
    stderr,
    elapsedMs: execution.durationMs,
    timedOut: false
  }, DEFAULT_TRUNCATION_POLICY);

  const recordedChanges = patchFileChanges(execution.delta, resolution.virtualPaths);
  noteChanges(recordedChanges.map(entry => entry.change), execution.exitCode === 0 && execution.delta.exact
    ? recordedChanges.map(({ before, after }) => ({ before, after })) : undefined);
  logInfo(`tool apply_patch (${execution.delta.changes.length} file(s), exit ${execution.exitCode})`);
  return {
    result: execution.exitCode === 0 ? ok(content) : fail(content),
    content,
    exitCode: execution.exitCode
  };
}
