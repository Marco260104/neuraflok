import { expect, it, vi } from 'vitest';
import { selectVitestProcesses, stopProcesses } from '../scripts/kill-stray-vitest.mjs';

it('selects unique Vitest Node processes and excludes the current process', () => {
  const processes = [
    { pid: 10, executable: 'node', command: 'node node_modules/vitest/vitest.mjs run' },
    { pid: 11, executable: 'node', command: 'node scripts/verify-ui.mjs' },
    { pid: 12, executable: 'powershell.exe', command: 'powershell vitest' },
    { pid: 13, executable: 'node.exe', command: 'node node_modules/.bin/vitest.cmd run' },
    { pid: 13, executable: 'node.exe', command: 'node node_modules/.bin/vitest.cmd run' },
    { pid: 14, executable: 'nodejs', command: 'nodejs node_modules/vitest/vitest.mjs' },
    { pid: 42, executable: 'node', command: 'node node_modules/vitest/vitest.mjs run' },
    { pid: 0, executable: 'node', command: 'node node_modules/vitest/vitest.mjs run' }
  ];

  expect(selectVitestProcesses(processes, 42).map(({ pid }) => pid)).toEqual([10, 13, 14]);
});

it('continues terminating candidates when one process has already exited', () => {
  const terminate = vi.fn((pid: number, _signal: NodeJS.Signals) => {
    if (pid === 11) throw new Error('process exited');
  });

  expect(stopProcesses([{ pid: 10 }, { pid: 11 }, { pid: 12 }], terminate)).toBe(2);
  expect(terminate.mock.calls.map(([pid, signal]) => [pid, signal])).toEqual([
    [10, 'SIGKILL'],
    [11, 'SIGKILL'],
    [12, 'SIGKILL']
  ]);
});
