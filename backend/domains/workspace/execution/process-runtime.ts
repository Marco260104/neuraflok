import { spawn } from 'node:child_process';
import { childEnv } from './process-environment.js';
import { prepareCommand, powershellArguments, type PreparedCommand } from './command-preparation.js';
import {
  DEFAULT_TIMEOUT_MS,
  ExecError,
  MAX_OUTPUT_BYTES,
  MAX_SCRIPT_CHARS,
  MAX_TIMEOUT_MS,
  type CommandEnvironment,
  type ExecResult
} from './process-contract.js';
import { findPowerShell } from './process-platform.js';
import { cleanPowerShellStderr } from './powershell-codec.js';
import { terminateProcessTree } from './process-control.js';

export {
  DEFAULT_TIMEOUT_MS,
  ExecError,
  MAX_ENV_KEY_CHARS,
  MAX_ENV_VALUE_CHARS,
  MAX_ENV_VARS,
  MAX_OUTPUT_BYTES,
  MAX_SCRIPT_CHARS,
  MAX_SHELL_COMMAND_CHARS,
  MAX_TIMEOUT_MS
} from './process-contract.js';
export type { CommandEnvironment, ExecResult } from './process-contract.js';
export { childEnv } from './process-environment.js';
export { prepareCommand, prepareShellCommand } from './command-preparation.js';
export type { AgentShell, PreparedCommand } from './command-preparation.js';
export { findPowerShell, findWindowsPowerShell } from './process-platform.js';
export { cleanPowerShellStderr } from './powershell-codec.js';
export { terminateProcessTree } from './process-control.js';

interface RunOptions {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

function run(options: RunOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(options.file, options.args, {
      cwd: options.cwd,
      env: options.env ?? childEnv(),
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const collect = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const room = MAX_OUTPUT_BYTES - current;
      if (room <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        truncated = true;
        return MAX_OUTPUT_BYTES;
      }
      chunks.push(chunk);
      return current + chunk.length;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void terminateProcessTree(child.pid);
    }, options.timeoutMs);
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated,
        timedOut,
        durationMs: Date.now() - started
      });
    };
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout: '',
        stderr: `Failed to start: ${error.message}`,
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started
      });
    });
    child.on('close', (code) => finish(code));
  });
}

export function normaliseTimeout(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(input)));
}

export async function runPowerShell(script: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  if (typeof script !== 'string' || script.trim() === '') throw new ExecError('script must be a non-empty string');
  if (script.length > MAX_SCRIPT_CHARS) {
    throw new ExecError(`script is too long (limit ${MAX_SCRIPT_CHARS} characters)`);
  }
  const shell = findPowerShell();
  if (!shell) throw new ExecError('PowerShell was not found on this system');
  const result = await run({
    file: shell,
    args: powershellArguments(script),
    cwd,
    timeoutMs
  });
  const stderr = cleanPowerShellStderr(result.stderr);
  return {
    ...result,
    stderr: stderr && result.exitCode === 0 ? `PowerShell error stream (process exited 0):\n${stderr}` : stderr
  };
}

export async function launchCommand(command: string, args: readonly string[], cwd: string): Promise<{ pid: number }> {
  const prepared = prepareCommand(command, args, cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.file, prepared.args, {
      cwd,
      env: prepared.env,
      windowsHide: false,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: 'ignore'
    });
    child.once('error', (error) => reject(new ExecError(`Failed to start: ${error.message}`)));
    child.once('spawn', () => {
      const pid = child.pid;
      child.unref();
      if (pid === undefined) reject(new ExecError('Program started without a process id'));
      else resolve({ pid });
    });
  });
}

export async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  env?: CommandEnvironment
): Promise<ExecResult> {
  const prepared: PreparedCommand = prepareCommand(command, args, cwd, env);
  return run({ file: prepared.file, args: prepared.args, cwd, timeoutMs, env: prepared.env });
}
