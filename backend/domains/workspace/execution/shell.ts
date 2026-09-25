import { accessSync, constants, statSync } from 'node:fs';
import nodePath from 'node:path';

export type ShellType = 'zsh' | 'bash' | 'powershell' | 'sh' | 'cmd';

export interface DetectedShell {
  shellType: ShellType;
  shellPath: string;
}

const SHELL_NAMES: Readonly<Record<string, ShellType>> = {
  bash: 'bash',
  cmd: 'cmd',
  powershell: 'powershell',
  pwsh: 'powershell',
  sh: 'sh',
  zsh: 'zsh'
};

const ZSH_FALLBACK_PATHS = ['/bin/zsh'];
const BASH_FALLBACK_PATHS = ['/bin/bash', '/usr/bin/bash'];
const SH_FALLBACK_PATHS = ['/bin/sh'];
const PWSH_FALLBACK_PATHS =
  process.platform === 'win32'
    ? ['C:\\Program Files\\PowerShell\\7\\pwsh.exe']
    : process.platform === 'darwin'
      ? ['/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh']
      : ['/usr/local/bin/pwsh'];
const POWERSHELL_FALLBACK_PATHS =
  process.platform === 'win32' ? ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] : [];
const POWERSHELL_FLAGS = new Set(['-nologo', '-noprofile', '-command', '-c']);
const SHLEX_SAFE = /^[A-Za-z0-9,._+:@%/-]+$/;

let cachedDefaultShell: { key: string; shell: DetectedShell } | null = null;

function fileStem(candidate: string): string {
  return nodePath.parse(nodePath.basename(candidate)).name.toLowerCase();
}

export function detectShellType(shellPath: string): ShellType | null {
  return SHELL_NAMES[fileStem(shellPath)] ?? null;
}

function executableFile(candidate: string): string | null {
  try {
    if (!statSync(candidate).isFile()) return null;
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function pathEntries(): string[] {
  const value = process.platform === 'win32' ? (process.env['PATH'] ?? process.env['Path'] ?? '') : (process.env['PATH'] ?? '');
  return value.split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
}

function findOnPath(binaryName: string): string | null {
  const extensions =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  for (const entry of pathEntries()) {
    const directory = entry.replace(/^"|"$/g, '');
    for (const extension of extensions) {
      const candidate = nodePath.join(directory, `${binaryName}${extension}`);
      const match = executableFile(candidate);
      if (match) return match;
    }
  }
  return null;
}

function configuredShellPath(): string | null {
  return process.platform === 'win32' ? null : process.env['SHELL'] || null;
}

function resolveShellPath(
  shellType: ShellType,
  providedPath: string | undefined,
  binaryName: string,
  fallbackPaths: readonly string[]
): string | null {
  if (providedPath) {
    const exact = executableFile(providedPath);
    if (exact) return exact;
  }
  const configured = configuredShellPath();
  if (configured && detectShellType(configured) === shellType) {
    const exact = executableFile(configured);
    if (exact) return exact;
  }
  const found = findOnPath(binaryName);
  if (found) return found;
  for (const candidate of fallbackPaths) {
    const exact = executableFile(candidate);
    if (exact) return exact;
  }
  return null;
}

export function isWindowsPowerShell5(shellPath: string): boolean {
  return /(?:^|[\\/])powershell(?:\.exe)?$/i.test(shellPath.trim());
}

export function getShell(shellType: ShellType, path?: string): DetectedShell | null {
  const resolve = (binary: string, fallbacks: readonly string[]) => resolveShellPath(shellType, path, binary, fallbacks);
  let shellPath: string | null;
  switch (shellType) {
    case 'zsh':
      shellPath = resolve('zsh', ZSH_FALLBACK_PATHS);
      break;
    case 'bash':
      shellPath = resolve('bash', BASH_FALLBACK_PATHS);
      break;
    case 'sh':
      shellPath = resolve('sh', SH_FALLBACK_PATHS);
      break;
    case 'cmd':
      shellPath = resolve('cmd', []);
      break;
    case 'powershell':
      shellPath = resolve('pwsh', PWSH_FALLBACK_PATHS) ?? resolve('powershell', POWERSHELL_FALLBACK_PATHS);
      break;
  }
  return shellPath ? { shellType, shellPath } : null;
}

export function ultimateFallbackShell(): DetectedShell {
  return process.platform === 'win32' ? { shellType: 'cmd', shellPath: 'cmd.exe' } : { shellType: 'sh', shellPath: '/bin/sh' };
}

export function getShellByModelProvidedPath(shellPath: string, cwd: string = process.cwd()): DetectedShell | null {
  const shellType = detectShellType(shellPath);
  if (!shellType) return null;
  const pathLike = nodePath.isAbsolute(shellPath) || /[\\/]/.test(shellPath);
  if (pathLike) {
    const resolved = nodePath.isAbsolute(shellPath) ? shellPath : nodePath.resolve(cwd, shellPath);
    return executableFile(resolved) ? { shellType, shellPath: resolved } : null;
  }
  const name = fileStem(shellPath);
  if (name === 'pwsh') {
    const resolved = findOnPath('pwsh') ?? PWSH_FALLBACK_PATHS.map(executableFile).find(Boolean) ?? null;
    return resolved ? { shellType, shellPath: resolved } : null;
  }
  if (name === 'powershell') {
    const resolved = findOnPath('powershell') ?? POWERSHELL_FALLBACK_PATHS.map(executableFile).find(Boolean) ?? null;
    return resolved ? { shellType, shellPath: resolved } : null;
  }
  return getShell(shellType, shellPath);
}

export function posixShellPreference(platform: NodeJS.Platform, configured: ShellType | null): ShellType[] {
  const fallback: ShellType[] = platform === 'darwin' ? ['zsh', 'bash'] : ['bash', 'zsh'];
  return [...new Set([...(configured ? [configured] : []), ...fallback])];
}

function defaultShellCacheKey(): string {
  return [
    process.platform,
    process.platform === 'win32' ? (process.env['PATH'] ?? process.env['Path'] ?? '') : (process.env['PATH'] ?? ''),
    process.env['PATHEXT'] ?? '',
    process.env['SHELL'] ?? ''
  ].join('\u0000');
}

export function defaultUserShell(): DetectedShell {
  const key = defaultShellCacheKey();
  if (cachedDefaultShell?.key === key) return cachedDefaultShell.shell;
  let shell: DetectedShell;
  if (process.platform === 'win32') {
    shell = getShell('powershell') ?? ultimateFallbackShell();
  } else {
    const configured = configuredShellPath();
    const type = configured ? detectShellType(configured) : null;
    shell =
      posixShellPreference(process.platform, type)
        .map((shellType) => getShell(shellType))
        .find((candidate): candidate is DetectedShell => candidate !== null) ?? ultimateFallbackShell();
  }
  cachedDefaultShell = { key, shell };
  return shell;
}

export function withPosixPathPrefix(command: string, shellType: ShellType, directory: string | null): string {
  if (!directory || !['zsh', 'bash', 'sh'].includes(shellType)) return command;
  return `export PATH=${shlexJoin([directory])}:"\${PATH:-}"\n${command}`;
}

export function deriveExecArgs(shell: DetectedShell, command: string, useLoginShell: boolean): string[] {
  switch (shell.shellType) {
    case 'zsh':
    case 'bash':
    case 'sh':
      return [shell.shellPath, useLoginShell ? '-lc' : '-c', command];
    case 'powershell':
      return [shell.shellPath, ...(useLoginShell ? [] : ['-NoProfile']), '-Command', command];
    case 'cmd':
      return [shell.shellPath, '/c', command];
  }
}

export const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';

export function extractPowershellCommand(command: readonly string[]): { shell: string; script: string } | null {
  if (command.length < 3) return null;
  const shell = command[0];
  if (!shell || detectShellType(shell) !== 'powershell') return null;
  for (let index = 1; index + 1 < command.length; index += 1) {
    const flag = command[index]?.toLowerCase();
    if (!flag || !POWERSHELL_FLAGS.has(flag)) return null;
    if (flag === '-command' || flag === '-c') {
      const script = command[index + 1];
      return script === undefined ? null : { shell, script };
    }
  }
  return null;
}

export function prefixPowershellScriptWithUtf8(command: readonly string[]): string[] {
  const invocation = extractPowershellCommand(command);
  if (!invocation) return [...command];
  const script = invocation.script.trimStart().startsWith(UTF8_OUTPUT_PREFIX)
    ? invocation.script
    : `${UTF8_OUTPUT_PREFIX}${invocation.script}`;
  return [...command.slice(0, -1), script];
}

function quoteShellToken(token: string): string {
  if (!token) return "''";
  if (SHLEX_SAFE.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}

export function shlexJoin(tokens: readonly string[]): string {
  if (tokens.some((token) => token.includes('\0'))) return '<command included NUL byte>';
  return tokens.map(quoteShellToken).join(' ');
}
