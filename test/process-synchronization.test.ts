import { expect, it } from 'vitest';
import { ProcessSignal } from '../backend/domains/workspace/execution/process-synchronization.js';

it('resolves immediately when an observed process signal changes before registration', async () => {
  const signal = new ProcessSignal();
  const observedVersion = signal.currentVersion();
  signal.notifyAll();
  const wait = signal.notified(observedVersion);
  await expect(wait.promise).resolves.toBeUndefined();
  wait.dispose();
});

it('wakes every current waiter and leaves later waiters pending', async () => {
  const signal = new ProcessSignal();
  const first = signal.notified();
  signal.notifyAll();
  await expect(first.promise).resolves.toBeUndefined();
  first.dispose();

  const second = signal.notified();
  let settled = false;
  void second.promise.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  signal.notifyAll();
  await expect(second.promise).resolves.toBeUndefined();
  second.dispose();
});
