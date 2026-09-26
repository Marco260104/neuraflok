import { existsSync } from 'node:fs';
import path from 'node:path';
import { envValue, pathEntries } from '../../../infrastructure/settings/env.js';

function firstAvailable(paths: readonly string[]): string | null {
  for (const candidate of paths) if (existsSync(candidate)) return candidate;
  return null;
}

export function windowsRoot(): string {
  return envValue(process.env, 'SystemRoot') || envValue(process.env, 'windir') || 'C:\\Windows';
}

export function findPowerShell(): string | null {
  const programFiles = envValue(process.env, 'ProgramFiles') ?? 'C:\\Program Files';
  return firstAvailable([
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ]);
}

export function findWindowsPowerShell(): string | null {
  const executable = path.join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(executable) ? executable : null;
}

function commandBases(command: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
  if (command.includes('\\') || command.includes('/')) {
    return [path.isAbsolute(command) ? command : path.resolve(cwd, command)];
  }
  return pathEntries(env).map(directory => path.join(directory, command));
}

export function findWindowsCommandShim(command: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== 'win32') return null;
  const extension = path.extname(command).toLowerCase();
  const suffixes = extension === '.cmd' || extension === '.bat' ? [''] : ['.cmd', '.bat'];
  const candidates = commandBases(command, cwd, env).flatMap(base => suffixes.map(suffix => `${base}${suffix}`));
  return firstAvailable(candidates);
}

export function findTaskkill(): string | null {
  return firstAvailable([path.join(windowsRoot(), 'System32', 'taskkill.exe')]);
}
