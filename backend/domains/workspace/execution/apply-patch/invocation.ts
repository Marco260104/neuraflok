// Recognizes the supported patch command forms before ordinary shell execution.

import nodePath from 'node:path';

import { ApplyPatchError, PatchParseError } from './errors.js';
import { parsePatch, type ApplyPatchArgs } from './parser.js';

const APPLY_PATCH_COMMANDS = new Set(['apply_patch', 'applypatch']);

type ApplyPatchShell = 'unix' | 'powershell' | 'cmd';

export type MaybeApplyPatch =
  | { kind: 'body'; args: ApplyPatchArgs }
  | { kind: 'patch_parse_error'; error: PatchParseError }
  | { kind: 'not_apply_patch' };

export type MaybeApplyPatchVerified =
  | { kind: 'body'; args: ApplyPatchArgs }
  | { kind: 'correctness_error'; error: ApplyPatchError }
  | { kind: 'not_apply_patch' };

function usesWindowsConvention(cwd: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\');
}

function classifyShellName(shell: string, cwd: string): string | null {
  const pathApi = usesWindowsConvention(cwd) ? nodePath.win32 : nodePath.posix;
  const basename = pathApi.basename(shell);
  if (basename === '') return null;
  const dot = basename.lastIndexOf('.');
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  return stem.toLowerCase();
}

function classifyShell(shell: string, flag: string, cwd: string): ApplyPatchShell | null {
  const name = classifyShellName(shell, cwd);
  if ((name === 'bash' || name === 'zsh' || name === 'sh') && (flag === '-lc' || flag === '-c')) return 'unix';
  if ((name === 'pwsh' || name === 'powershell') && flag.toLowerCase() === '-command') return 'powershell';
  if (name === 'cmd' && flag.toLowerCase() === '/c') return 'cmd';
  return null;
}

function canSkipFlag(shell: string, flag: string, cwd: string): boolean {
  const name = classifyShellName(shell, cwd);
  return (name === 'pwsh' || name === 'powershell') && flag.toLowerCase() === '-noprofile';
}

function parseShellScript(argv: readonly string[], cwd: string): { shell: ApplyPatchShell; script: string } | null {
  if (argv.length === 3) {
    const [shell, flag, script] = argv;
    if (shell === undefined || flag === undefined || script === undefined) return null;
    const shellType = classifyShell(shell, flag, cwd);
    return shellType === null ? null : { shell: shellType, script };
  }
  if (argv.length === 4) {
    const [shell, skipFlag, flag, script] = argv;
    if (shell === undefined || skipFlag === undefined || flag === undefined || script === undefined) return null;
    if (!canSkipFlag(shell, skipFlag, cwd)) return null;
    const shellType = classifyShell(shell, flag, cwd);
    return shellType === null ? null : { shell: shellType, script };
  }
  return null;
}

function extractApplyPatchScript(script: string): { body: string; workdir: string | null } | null {
  const lines = script.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  while (start < lines.length && lines[start]?.trim() === '') start += 1;
  if (start >= lines.length) return null;

  let command = lines[start]?.trim() ?? '';
  let workdir: string | null = null;
  const changeDirectory = /^cd\s+(?:(["'])(.*?)\1|([^\s"'`]+))\s+&&\s+(.+)$/.exec(command);
  if (changeDirectory) {
    workdir = changeDirectory[2] ?? changeDirectory[3] ?? null;
    command = changeDirectory[4] ?? '';
    if (!workdir) return null;
  }

  const header = /^(?:apply_patch|applypatch)\s*<<\s*(?:(['"])(.+?)\1|([A-Za-z0-9_][A-Za-z0-9_.-]{0,63}))$/.exec(command);
  const delimiter = header?.[2] ?? header?.[3];
  if (!delimiter) return null;

  const bodyStart = start + 1;
  const bodyEnd = lines.indexOf(delimiter, bodyStart);
  if (bodyEnd < bodyStart || lines.slice(bodyEnd + 1).some((line) => line.trim() !== '')) return null;
  const body = lines.slice(bodyStart, bodyEnd).join('\n').replace(/\n+$/g, '');
  return body ? { body, workdir } : null;
}

// Parses only direct commands and one-line shell wrappers with a single heredoc.
export function maybeParseApplyPatch(argv: readonly string[], cwd: string): MaybeApplyPatch {
  if (argv.length === 2 && argv[0] !== undefined && argv[1] !== undefined && APPLY_PATCH_COMMANDS.has(argv[0])) {
    try {
      return { kind: 'body', args: parsePatch(argv[1]) };
    } catch (error) {
      if (error instanceof PatchParseError) return { kind: 'patch_parse_error', error };
      throw error;
    }
  }

  const shell = parseShellScript(argv, cwd);
  if (shell === null) return { kind: 'not_apply_patch' };
  const extracted = extractApplyPatchScript(shell.script);
  if (extracted === null) return { kind: 'not_apply_patch' };
  try {
    const args = parsePatch(extracted.body);
    args.workdir = extracted.workdir;
    return { kind: 'body', args };
  } catch (error) {
    if (error instanceof PatchParseError) return { kind: 'patch_parse_error', error };
    throw error;
  }
}

// Adds the explicit-invocation rule before the normal patch verification step.
export function maybeParseApplyPatchForExec(argv: readonly string[], cwd: string): MaybeApplyPatchVerified {
  if (argv.length === 1 && argv[0] !== undefined) {
    try {
      parsePatch(argv[0]);
      return { kind: 'correctness_error', error: ApplyPatchError.implicitInvocation() };
    } catch (error) {
      if (!(error instanceof PatchParseError)) throw error;
    }
  }

  const shell = parseShellScript(argv, cwd);
  if (shell !== null) {
    try {
      parsePatch(shell.script);
      return { kind: 'correctness_error', error: ApplyPatchError.implicitInvocation() };
    } catch (error) {
      if (!(error instanceof PatchParseError)) throw error;
    }
  }

  const parsed = maybeParseApplyPatch(argv, cwd);
  if (parsed.kind === 'patch_parse_error') {
    return { kind: 'correctness_error', error: ApplyPatchError.fromParseError(parsed.error) };
  }
  return parsed;
}
