import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logInfo } = vi.hoisted(() => ({ logInfo: vi.fn() }));

vi.mock('../backend/infrastructure/settings/logger.js', () => ({ logInfo }));

import { exclusive } from '../backend/infrastructure/device-control/native/operation-lock.js';

describe('desktop operation queue', () => {
  beforeEach(() => logInfo.mockClear());

  it('runs queued operations in order without overlapping them', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const first = exclusive(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
      return 'first';
    });
    const second = exclusive(async () => {
      order.push('second');
      return 'second';
    });

    expect(order).toEqual(['first:start']);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(logInfo).toHaveBeenCalledTimes(2);
  });

  it('continues to the next operation after a task rejects', async () => {
    const failure = new Error('operation failed');
    const first = exclusive(async () => { throw failure; });
    const second = exclusive(async () => 'ready');

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe('ready');
    expect(logInfo).toHaveBeenCalledTimes(2);
  });

  it('releases the queue when duration logging throws', async () => {
    const logFailure = new Error('logger failed');
    logInfo.mockImplementationOnce(() => { throw logFailure; });
    const first = exclusive(async () => 'completed');
    const second = exclusive(async () => 'ready');

    await expect(first).rejects.toBe(logFailure);
    await expect(second).resolves.toBe('ready');
    expect(logInfo).toHaveBeenCalledTimes(2);
  });
});
