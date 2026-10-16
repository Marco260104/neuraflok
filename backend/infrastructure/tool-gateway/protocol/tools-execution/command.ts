import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { z } from 'zod';
import { logInfo } from '../../../settings/logger.js';
import { strayVirtualPath } from '../../../settings/sandbox.js';
import { commandHasSameArguments, evaluateCommandAllowlist } from '../../../../../contracts/command-allowlist/policy.js';
import { composeCommandBatch, parseCommandBatchSections } from '../../../../domains/workspace/execution/command-batch.js';
import { EXEC_OUTPUT_CEILING_POLICY, unifiedExecManager } from '../../../../domains/workspace/execution/manager.js';
import {
  backgroundExecObligations,
  forgetExecOwner,
  MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION,
  noteExecOwner
} from '../../../../domains/workspace/execution/ownership.js';
import {
  UnifiedExecError,
  applyUnifiedExecEnv,
  projectExecCommandOutput,
  type ExecCommandToolOutput
} from '../../../../domains/workspace/execution/unified-exec.js';
import { DEFAULT_EXEC_YIELD_TIME_MS, DEFAULT_TTY } from '../../../../domains/workspace/execution/unified-exec-constants.js';
import { defaultUserShell, deriveExecArgs, getShellByModelProvidedPath, shlexJoin, withPosixPathPrefix } from '../../../../domains/workspace/execution/shell.js';
import {
  EXEC_COMMAND_CMD_DESCRIPTION,
  EXEC_COMMAND_CMDS_DESCRIPTION,
  EXEC_COMMAND_DESCRIPTION,
  EXEC_COMMAND_LOGIN_DESCRIPTION,
  EXEC_COMMAND_SHELL_DESCRIPTION,
  EXEC_COMMAND_TTY_DESCRIPTION,
  EXEC_COMMAND_WORKDIR_DESCRIPTION,
  EXEC_COMMAND_YIELD_TIME_DESCRIPTION,
  MAX_OUTPUT_TOKENS_DESCRIPTION
} from '../../../../domains/workspace/execution/tool-specs.js';
import {
  benignExitNote,
  bindBundledRipgrep,
  nonZeroExitIsBenign,
  normalizePowerShellOperators,
  normalizeShellCommand,
  repairPowerShellQuoting
} from '../../../../domains/workspace/exec-hints.js';
import { execRecoveryHints, withExecNotes } from '../../../../domains/workspace/exec-recovery-hints.js';
import { childEnv } from '../../../../domains/workspace/exec.js';
import { locateRipgrep } from '../../../binaries/ripgrep.js';
import { ensureDevToolchain } from '../../../../domains/workspace/toolchain.js';
import { runParsedPatch } from '../tools-patching.js';
import { noteDetail, noteExec } from '../call-context.js';
import { getConfig } from '../../../settings/config.js';
import { toolDeclaration } from '../declaration-cache.js';
import { execPrincipal, unifiedExecOutputSchema, unsignedIntegerNumber } from './shared.js';
import { fail, friendlyError, resolveCwd, type SurfaceRegistrar } from '../kernel.js';

let toolchainLogged = false;

function execChildEnvironment(): NodeJS.ProcessEnv {
  const env = childEnv();
  const added = ensureDevToolchain(env);
  if (added.length > 0 && !toolchainLogged) {
    toolchainLogged = true;
    logInfo('exec_command: filled in unset toolchain variables (' + added.join(', ') + ')');
  }
  return applyUnifiedExecEnv(env);
}

export function registerExecCommandTool(reg: SurfaceRegistrar): void {
  const ctx = reg.ctx;
  reg.register(
    'exec_command',
    toolDeclaration('exec_command', () => ({
      description: EXEC_COMMAND_DESCRIPTION,
      inputSchema: z
        .object({
          cmd: z.string().optional().describe(EXEC_COMMAND_CMD_DESCRIPTION),
          cmds: z.array(z.string()).min(1).max(20).optional().describe(EXEC_COMMAND_CMDS_DESCRIPTION),
          workdir: z.string().optional().describe(EXEC_COMMAND_WORKDIR_DESCRIPTION),
          tty: z.boolean().optional().describe(EXEC_COMMAND_TTY_DESCRIPTION),
          yield_time_ms: unsignedIntegerNumber.optional().describe(EXEC_COMMAND_YIELD_TIME_DESCRIPTION),
          // Accepted and ignored on purpose; see MAX_OUTPUT_TOKENS_DESCRIPTION.
          max_output_tokens: unsignedIntegerNumber.optional().describe(MAX_OUTPUT_TOKENS_DESCRIPTION),
          shell: z.string().optional().describe(EXEC_COMMAND_SHELL_DESCRIPTION),
          login: z.boolean().optional().describe(EXEC_COMMAND_LOGIN_DESCRIPTION)
        })
        .strict()
        .superRefine((input, refinement) => {
          if ((input.cmd === undefined) === (input.cmds === undefined)) {
            refinement.addIssue({
              code: 'custom',
              path: [],
              message: 'exec_command requires exactly one of cmd or cmds'
            });
          }
        }),
      outputSchema: unifiedExecOutputSchema
    })),
    async (input) =>
      reg.guarded('command', 'exec_command', async () => {
        const dir = await resolveCwd(ctx, input.workdir);
        const rawCommands = input.cmd === undefined ? input.cmds! : [input.cmd];
        const isBatch = input.cmd === undefined;
        for (const [index, rawCommand] of rawCommands.entries()) {
          const virtualCommandPath = strayVirtualPath(rawCommand, ctx.roots);
          if (virtualCommandPath) {
            return fail(
              `INVALID_COMMAND_PATH${isBatch ? ` in command ${index + 1}` : ''}: ${virtualCommandPath} is an app virtual path, but shell commands do not understand virtual paths. ` +
                `Use workdir plus a relative path, or use the approved folder's native filesystem path. No command was run.`
            );
          }
        }
        const shell = input.shell === undefined ? defaultUserShell() : getShellByModelProvidedPath(input.shell, dir.real);
        if (!shell) {
          return fail(
            `SHELL_NOT_FOUND: the explicitly requested shell ${JSON.stringify(input.shell)} could not be resolved. ` +
              'No command was run. Omit shell to use the configured default, or provide an existing recognised shell binary.'
          );
        }
        // One preflight owns direct calls and code-mode children. It runs before command normalization, patch interception, process-id allocation or process launch, and a batch is admitted only after every user-authored command passes.
        const policy = evaluateCommandAllowlist(getConfig().commandAllowlist, rawCommands, shell.shellType);
        if (!policy.allowed) {
          const location = isBatch ? ` in command ${policy.commandIndex + 1}` : '';
          const reason = policy.kind === 'unmatched'
            ? 'the command did not match any allow rule'
            : policy.kind === 'denied'
              ? 'the command matched a deny rule'
            : policy.kind === 'invalid-policy'
              ? 'the saved policy is invalid'
              : 'the command uses unsupported or ambiguous shell syntax';
          return fail(
            `COMMAND_NOT_ALLOWED${location}: ${reason}. ${policy.detail} No command was run. ` +
            'Change the command policy in Settings if this launch should be permitted.'
          );
        }
        // Expands supported bare filename globs for PowerShell native commands.
        const commandNotes: string[] = [];
        const normalizedCommands: string[] = [];
        const boundCommands = rawCommands.map((rawCommand, index) => {
          const repaired = repairPowerShellQuoting(rawCommand, shell.shellType);
          const normalized = normalizeShellCommand(repaired.cmd, shell.shellType, (relativeDirectory = '.') =>
            nodeFs.readdirSync(nodePath.resolve(dir.real, relativeDirectory))
          );
          normalizedCommands.push(normalized.cmd);
          const prefix = (note: string): string => (isBatch ? `Command ${index + 1}: ${note}` : note);
          const bound = bindBundledRipgrep(
            normalized.cmd,
            shell.shellType,
            shell.shellType === 'cmd' ? null : locateRipgrep()
          );
          const chained = normalizePowerShellOperators(bound, shell.shellType, shell.shellPath);
          commandNotes.push(
            ...repaired.notes.map(prefix),
            ...normalized.notes.map(prefix),
            ...chained.notes.map(prefix)
          );
          return chained.cmd;
        });
        if (getConfig().commandAllowlist.enabled) {
          const changed = normalizedCommands.findIndex((command, index) =>
            !commandHasSameArguments(policy.args[index]!, command, shell.shellType)
          );
          if (changed !== -1) {
            return fail(
              `COMMAND_NOT_ALLOWED${isBatch ? ` in command ${changed + 1}` : ''}: command normalization changed the authorized argument list. ` +
              'No command was run. Change the command policy in Settings if this launch should be permitted.'
            );
          }
        }
        // Shell functions/aliases can resolve before applications on PATH. The app deliberately ships ripgrep, parses rg's flags against that exact version, and puts it first on child PATH, so a shadowing `rg` is not a harmless customization: it breaks the normalizer's assumptions and makes exit-code attribution unknowable. Bind ordinary bare rg/ripgrep invocations to the shipped executable on PowerShell and POSIX shells.
        const batch = isBatch ? composeCommandBatch(boundCommands, shell.shellType) : undefined;
        const boundCommand = batch?.command ?? boundCommands[0]!;
        const commandDetail = isBatch
          ? `[batch ${rawCommands.length}] ${rawCommands.join(' ; ')}`
          : rawCommands[0]!;
        // PowerShell profiles are user-custom startup programs. Loading them for every connector command adds arbitrary output/aliases and can spend seconds on network profile work before the requested command even begins. Keep explicit login=true, but make the deterministic/no-profile path the Windows default.
        const useLoginShell = input.login ?? process.platform !== 'win32';
        const command = deriveExecArgs(shell, boundCommand, useLoginShell);
        try {
          // Handle the supported patch command format before starting a shell process.
          if (!isBatch) {
              const { maybeParseApplyPatchForExec } = await import('../../../../domains/workspace/execution/apply-patch/invocation.js');
            const interceptedPatch = maybeParseApplyPatchForExec(command, dir.real);
            if (interceptedPatch.kind === 'correctness_error') {
              return fail(`apply_patch verification failed: ${interceptedPatch.error.message}`);
            }
            if (interceptedPatch.kind === 'body') {
              const patchRun = await runParsedPatch(interceptedPatch.args, ctx.roots, dir);
              if (patchRun.result.isError || patchRun.content === null) return patchRun.result;
  
              // `exec_command.rs` converts a successful intercepted patch into an ExecCommandToolOutput with zero wall time and no process/exit/chunk metadata.
              const output: ExecCommandToolOutput = {
                chunkId: '',
                wallTimeMs: 0,
                rawOutput: Buffer.from(patchRun.content, 'utf8'),
                truncationPolicy: EXEC_OUTPUT_CEILING_POLICY,
                maxOutputTokens: undefined,
                processId: null,
                exitCode: null,
                originalTokenCount: null,
                outputOmittedBytes: null
              };
              noteExec({ running: false, exitCode: null, timedOut: false, durationMs: 0 });
              noteDetail(commandDetail.replace(/\s+/g, ' ').slice(0, 120));
              const projection = projectExecCommandOutput(output);
              return {
                content: [{ type: 'text' as const, text: projection.text }],
                structuredContent: projection.structured
              };
            }
          }
  
          const owner = execPrincipal();
          const unread = backgroundExecObligations(owner).exitedUnread;
          if (unread.length >= MAX_UNREAD_EXEC_RESULTS_PER_CONVERSATION) {
            const sessionIds = unread.map((session) => session.processId).join(', ');
            return fail(
                `EXEC_RESULTS_UNREAD: ${unread.length} completed background results are still waiting for this session. ` +
                `Their output follows in tool responses; read it before retrying. Explicit write_stdin is also available for IDs ${sessionIds}. No child was spawned.`
            );
          }
  
          const processId = unifiedExecManager.allocateProcessId();
          // Process ids are deliberately small/reusable, while chat ownership lives in a separate registry. Clear any stale row at the allocation boundary so a recycled id cannot briefly authorize its previous chat before this call publishes the new owner.
          forgetExecOwner(processId);
  
          const ripgrep = locateRipgrep();
          const executionCommand = deriveExecArgs(shell,
            withPosixPathPrefix(boundCommand, shell.shellType, ripgrep ? nodePath.dirname(ripgrep) : null), useLoginShell);
          const output = await unifiedExecManager.execCommand({
            classifyExit: (exitCode, rawOutput) => {
              if (!batch) return nonZeroExitIsBenign(boundCommand, exitCode, rawOutput);
              const sections = parseCommandBatchSections(rawOutput, batch.marker);
              const nonzero = sections.filter(section => section.exitCode !== 0);
              return exitCode !== null && exitCode !== 0 && sections.length === rawCommands.length && nonzero.length > 0 &&
                nonzero.every(section => nonZeroExitIsBenign(boundCommands[section.index - 1] ?? '', section.exitCode, section.text));
            },
            batchMarker: batch?.marker,
            command: executionCommand,
            shellType: shell.shellType,
            hookCommand: commandDetail,
            processId,
            yieldTimeMs: input.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS,
            maxOutputTokens: undefined,
            truncationPolicy: EXEC_OUTPUT_CEILING_POLICY,
            cwd: dir.real,
            displayCwd: dir.virtual,
            env: execChildEnvironment(),
            tty: input.tty ?? DEFAULT_TTY
          });
          // Which exact session or temporary request principal may later write to this process id. Request custody upgrades lazily when exact correlation arrives.
          noteExecOwner(output.processId ?? output.completedSessionId ?? null, owner);
          const projection = projectExecCommandOutput(output);
          const responseText = projection.text;
          // A search that found nothing exits 1 and has not failed. Recording it as an error made a session's error count meaningless; see exec-hints.ts for why this cannot launder a real failure. `benign` only ever *withholds* the error mark — it never turns a genuine non-zero exit into a success. A batch has one exit code and several commands, so the single-command classifier cannot be handed the wrapper script — it would be asking whether a `for` loop is a search. Classify each section on its own command and its own output instead. This matters most for the case batching exists to serve: several ripgrep searches, where "no matches" is exit 1 and reporting the batch as failed is what makes a model run the whole thing again. Require a complete set of sections, so a truncated tail cannot let an unseen real failure pass as benign.
          const batchSections = batch ? parseCommandBatchSections(output.rawOutput.toString('utf8'), batch.marker) : [];
          const nonZeroSections = batchSections.filter((section) => section.exitCode !== 0);
          const benign = output.benignExit === true;
          noteExec({
            completion: output.completion,
            ...(output.processId === null ? {} : { id: String(output.processId) }),
            running: output.processId !== null,
            exitCode: output.exitCode,
            timedOut: false,
            durationMs: output.wallTimeMs,
            benignExit: benign
          });
          noteDetail(commandDetail.replace(/\s+/g, ' ').slice(0, 120));
          logInfo(`tool exec_command ${shell.shellType} -> ${output.processId ?? `exit ${output.exitCode ?? 'unknown'}`}`);
          // `benign` was previously spent only on the error count, leaving the model to read `Process exited with code 1` under an empty body and re-run a search that had already answered. It is the same classification, now also said out loud. A batch carries one top-line exit code for several commands, and in the recorded sessions 69 of 91 non-zero batches had at least one command that succeeded. Say which ones, so the model reruns the failed command and not the whole batch.
          const mixedBatch =
            isBatch &&
            !benign &&
            batchSections.length === rawCommands.length &&
            nonZeroSections.length > 0 &&
            nonZeroSections.length < batchSections.length
              ? [
                  `Batch: ${nonZeroSections.map((section) => `command ${section.index} exited ${section.exitCode}`).join(', ')}; ` +
                    `the other ${batchSections.length - nonZeroSections.length === 1 ? 'command' : `${batchSections.length - nonZeroSections.length} commands`} exited 0. ` +
                    'The top-line exit code is the first non-zero one.'
                ]
              : [];
          const notes = [
            ...commandNotes,
            ...mixedBatch,
            ...(benign
              ? isBatch
                ? nonZeroSections.map(
                    (section) =>
                      `Command ${section.index}: ${benignExitNote(
                        boundCommands[section.index - 1] ?? '',
                        shell.shellType,
                        section.exitCode,
                        section.text
                      )}`
                  )
                : [benignExitNote(boundCommand, shell.shellType, output.exitCode, responseText)]
              : []),
            // A batch parses each command independently. Its earlier mutations may already have succeeded when a later command has a syntax error: never tell the caller to rerun the whole batch on the strength of that one diagnostic. Completed authenticated sections also keep source text printed by a successful read from becoming an invented shell failure. With incomplete framing, abstain.
            ...(isBatch
              ? nonZeroSections.flatMap((section) =>
                  execRecoveryHints(rawCommands[section.index - 1] ?? '', section.text, shell.shellType)
                    .map((hint) => `Command ${section.index}: ${hint}`)
                )
              : output.exitCode !== null && output.exitCode !== 0
                ? execRecoveryHints(rawCommands[0] ?? '', responseText, shell.shellType)
                : [])
          ];
          return {
            content: [{ type: 'text' as const, text: withExecNotes(responseText, notes) }],
            structuredContent: projection.structured
          };
        } catch (error) {
          const detail = error instanceof UnifiedExecError ? error.debug() : friendlyError(error);
          return fail(`exec_command failed for \`${shlexJoin(command)}\`: ${detail}`);
        }
      })
  );
}
