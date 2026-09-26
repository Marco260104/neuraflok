import { execFileSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { GIT_COMMAND_TIMEOUT_MS, MAX_GIT_OUTPUT_BYTES } from './limits.js';

export interface GitCommandResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (/^GIT_/i.test(key)) delete environment[key];
  return {
    ...environment,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: '5',
    GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: 'cat',
    GIT_CONFIG_KEY_1: 'color.ui', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'diff.external', GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'diff.trustExitCode', GIT_CONFIG_VALUE_3: 'false',
    GIT_CONFIG_KEY_4: 'core.fsmonitor', GIT_CONFIG_VALUE_4: 'false'
  };
}

let cachedWindowsGit: string | null = null;
let cachedDeveloperDirectory: string | null = null;

function developerDirectory(): string | null {
  if (cachedDeveloperDirectory) return cachedDeveloperDirectory;
  try {
    cachedDeveloperDirectory = execFileSync('/usr/bin/xcode-select', ['-p'], {
      encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch {}
  return cachedDeveloperDirectory;
}

export function gitExecutable(
  platform: NodeJS.Platform = process.platform,
  searchPath = process.env['PATH'] ?? process.env['Path'] ?? '',
  isFile: (candidate: string) => boolean = candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  },
  findDeveloperDirectory: () => string | null = developerDirectory
): string {
  if (platform === 'darwin') {
    const candidates = searchPath.split(':')
      .filter(entry => path.posix.isAbsolute(entry))
      .map(entry => path.posix.join(entry, 'git'));
    const first = candidates.find(isFile);
    if (first !== '/usr/bin/git') return 'git';
    const developer = findDeveloperDirectory();
    if (developer && [
      path.posix.join(developer, 'usr/bin/git'),
      path.posix.join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/git')
    ].some(isFile)) return 'git';
    throw new Error('Git is not installed. Install the Xcode Command Line Tools to see Git changes.');
  }
  if (platform !== 'win32') return 'git';
  const currentPath = process.env['PATH'] ?? process.env['Path'] ?? '';
  const cacheable = searchPath === currentPath;
  if (cacheable && cachedWindowsGit) return cachedWindowsGit;
  for (const rawEntry of searchPath.split(';')) {
    const directory = rawEntry.trim().replace(/^"|"$/g, '');
    if (!directory || !path.win32.isAbsolute(directory) || /^[\/](?![\/])/.test(directory)) continue;
    for (const executable of ['git.exe', 'git.com']) {
      const candidate = path.win32.join(directory, executable);
      if (!isFile(candidate)) continue;
      if (cacheable) cachedWindowsGit = candidate;
      return candidate;
    }
  }
  throw new Error('Git was not found on PATH');
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  maxBytes = MAX_GIT_OUTPUT_BYTES
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitExecutable(), ['--no-optional-locks', ...args], {
      cwd, env: safeEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    const finish = (error?: Error, code = -1): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8').trim() });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Git took too long to respond'));
    }, GIT_COMMAND_TIMEOUT_MS);
    child.once('error', error => finish(error));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        child.kill();
        finish(new Error('Git returned too much data'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.once('close', code => finish(undefined, code ?? -1));
  });
}
