import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  createProcessTerminator,
  type ProcessControlDependencies
} from '../backend/domains/workspace/execution/process-control.js';

function createFixture(platform: NodeJS.Platform, closeCode: number | null = 0) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
  const signals: Array<[number, NodeJS.Signals]> = [];
  let spawnCall: { file: string; args: string[]; options: unknown } | undefined;
  const dependencies: ProcessControlDependencies = {
    platform,
    spawn: (file, args, options) => {
      spawnCall = { file, args, options };
      if (closeCode !== null) queueMicrotask(() => child.emit('close', closeCode));
      return child;
    },
    findTaskkill: () => 'C:\\Windows\\System32\\taskkill.exe',
    childEnv: () => ({ PATH: 'C:\\Windows\\System32' }),
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      return false;
    }
  };

  return {
    child,
    signals,
    terminate: createProcessTerminator(dependencies),
    get spawnCall() { return spawnCall; },
    dependencies
  };
}

describe('process tree termination', () => {
  it('ignores invalid process identifiers', async () => {
    const fixture = createFixture('linux');

    await fixture.terminate(0);
    await fixture.terminate(Number.MAX_SAFE_INTEGER + 1);

    expect(fixture.signals).toEqual([]);
    expect(fixture.spawnCall).toBeUndefined();
  });

  it('uses taskkill for Windows trees and accepts an already-finished process', async () => {
    const fixture = createFixture('win32', 128);

    await fixture.terminate(4312, false);

    expect(fixture.spawnCall).toMatchObject({
      file: 'C:\\Windows\\System32\\taskkill.exe',
      args: ['/PID', '4312', '/T']
    });
    expect(fixture.signals).toEqual([]);
  });

  it('falls back to the process id when the Windows tree helper fails', async () => {
    const fixture = createFixture('win32', 1);

    await fixture.terminate(4312, true);

    expect(fixture.spawnCall?.args).toEqual(['/PID', '4312', '/T', '/F']);
    expect(fixture.signals).toEqual([[4312, 'SIGKILL']]);
  });

  it('signals a POSIX process group and falls back to its leader', async () => {
    const fixture = createFixture('linux');

    await fixture.terminate(4312, false);

    expect(fixture.signals).toEqual([[-4312, 'SIGTERM'], [4312, 'SIGTERM']]);
    expect(fixture.spawnCall).toBeUndefined();
  });

  it('ends a timed-out Windows helper before falling back to the target process', async () => {
    const fixture = createFixture('win32', null);

    await fixture.terminate(4312, true, 50);

    expect(fixture.child.kill).toHaveBeenCalledOnce();
    expect(fixture.signals).toEqual([[4312, 'SIGKILL']]);
  });
});
