import { childEnv } from './process-environment.js';
import { ExecError, MAX_SHELL_COMMAND_CHARS, type CommandEnvironment } from './process-contract.js';
import { findPowerShell, findWindowsCommandShim } from './process-platform.js';
import { encodePowerShellScript } from './powershell-codec.js';

const MAX_COMMAND_ARGUMENTS = 128;
const SHIM_COMMAND_ENV = 'NEURAFLOK_COMMAND';
const SHIM_ARGUMENTS_ENV = 'NEURAFLOK_ARGUMENTS';
const WINDOWS_SHIM_LAUNCHER = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  `$commandPath=$env:${SHIM_COMMAND_ENV}`,
  '$argumentList=@()',
  `if($env:${SHIM_ARGUMENTS_ENV}){$argumentList=@(ConvertFrom-Json $env:${SHIM_ARGUMENTS_ENV})}`,
  '& $commandPath @argumentList',
  'if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}'
].join('; ');

export interface PreparedCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

export type AgentShell = 'powershell' | 'cmd';

export function powershellArguments(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-NoLogo', '-OutputFormat', 'Text', '-EncodedCommand', encodePowerShellScript(script)];
}

function validateShellScript(script: string): void {
  if (typeof script !== 'string' || script.trim() === '') throw new ExecError('cmd must be a non-empty string');
  if (script.includes('\0')) throw new ExecError('cmd contains a null byte');
  if (script.length > MAX_SHELL_COMMAND_CHARS) {
    throw new ExecError(`cmd is too long (limit ${MAX_SHELL_COMMAND_CHARS} characters)`);
  }
}

export function prepareShellCommand(
  script: string,
  shellKind: AgentShell,
  envOverrides?: CommandEnvironment
): PreparedCommand {
  validateShellScript(script);
  const env = childEnv(envOverrides);
  if (shellKind === 'cmd') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${script}"`],
      env,
      windowsVerbatimArguments: true
    };
  }
  const shell = findPowerShell();
  if (!shell) throw new ExecError('PowerShell was not found on this system');
  return { file: shell, args: powershellArguments(script), env };
}

function validateCommand(command: string, args: readonly string[]): void {
  if (typeof command !== 'string' || command.trim() === '') throw new ExecError('command must be a non-empty string');
  if (command.includes('\0')) throw new ExecError('command contains a null byte');
  if (args.length > MAX_COMMAND_ARGUMENTS) throw new ExecError('Too many arguments');
  for (const arg of args) {
    if (typeof arg !== 'string') throw new ExecError('Every argument must be a string');
    if (arg.includes('\0')) throw new ExecError('An argument contains a null byte');
  }
}

function prepareShimCommand(shim: string, args: readonly string[], env: NodeJS.ProcessEnv): PreparedCommand | null {
  const shell = findPowerShell();
  if (!shell) return null;
  const shimEnv = {
    ...env,
    [SHIM_COMMAND_ENV]: shim,
    [SHIM_ARGUMENTS_ENV]: JSON.stringify(args)
  };
  return { file: shell, args: powershellArguments(WINDOWS_SHIM_LAUNCHER), env: shimEnv };
}

export function prepareCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  envOverrides?: CommandEnvironment
): PreparedCommand {
  validateCommand(command, args);
  const env = childEnv(envOverrides);
  const shim = findWindowsCommandShim(command, cwd, env);
  const wrappedShim = shim ? prepareShimCommand(shim, args, env) : null;
  return wrappedShim ?? { file: command, args: [...args], env };
}
