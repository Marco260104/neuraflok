import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { childEnv } from './process-environment.js';
import { findTaskkill } from './process-platform.js';

type HelperSpawnOptions = {
  windowsHide: true;
  stdio: 'ignore';
  env: NodeJS.ProcessEnv;
};

export type ProcessControlDependencies = {
  platform: NodeJS.Platform;
  spawn: (file: string, args: string[], options: HelperSpawnOptions) => ChildProcess;
  findTaskkill: () => string | null;
  childEnv: () => NodeJS.ProcessEnv;
  signal: (pid: number, signal: NodeJS.Signals) => boolean;
};

const completedTreeKillCodes = new Set([0, 128]);

function waitForTreeKill(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise(resolve => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(code);
    };

    child.once('close', settle);
    child.once('error', () => settle(null));
    const delay = Number.isFinite(timeoutMs) ? Math.max(50, timeoutMs) : 50;
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      settle(null);
    }, delay);
  });
}

async function stopWindowsProcessTree(
  pid: number,
  force: boolean,
  timeoutMs: number,
  dependencies: ProcessControlDependencies
): Promise<boolean> {
  const executable = dependencies.findTaskkill();
  if (!executable) return false;

  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');

  try {
    const child = dependencies.spawn(executable, args, {
      windowsHide: true,
      stdio: 'ignore',
      env: dependencies.childEnv()
    });
    const exitCode = await waitForTreeKill(child, timeoutMs);
    return exitCode !== null && completedTreeKillCodes.has(exitCode);
  } catch {
    return false;
  }
}

function signalTarget(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function createProcessTerminator(dependencies: ProcessControlDependencies) {
  return async function terminateProcessTree(
    pid: number,
    force = true,
    helperTimeoutMs = force ? 1_000 : 500
  ): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return;

    if (dependencies.platform === 'win32') {
      if (await stopWindowsProcessTree(pid, force, helperTimeoutMs, dependencies)) return;
      dependencies.signal(pid, force ? 'SIGKILL' : 'SIGTERM');
      return;
    }

    const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
    if (!dependencies.signal(-pid, signal)) dependencies.signal(pid, signal);
  };
}

export const terminateProcessTree = createProcessTerminator({
  platform: process.platform,
  spawn: spawnProcess,
  findTaskkill,
  childEnv,
  signal: signalTarget
});
