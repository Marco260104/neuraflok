import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExtensionAlarms } from '../backend/domains/browser/embedded/extension-alarms.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => vi.useRealTimers());

it('delivers the existing one-shot maintenance alarm and permits rearming from its receipt', async () => {
  const received: string[] = [];
  const alarms = new ExtensionAlarms(alarm => {
    received.push(alarm.name);
    if (received.length === 1) alarms.call('alarms.create', [alarm.name, { delayInMinutes: 0.5 }]);
  });
  alarms.call('alarms.create', ['maintenance', { delayInMinutes: 0.5 }]);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(received).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(received).toEqual(['maintenance']);
  expect(alarms.call('alarms.get', ['maintenance'])).toEqual({ name: 'maintenance', scheduledTime: 1_060_000 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(received).toEqual(['maintenance', 'maintenance']);
  expect(alarms.call('alarms.getAll', [])).toEqual([]);
});

it('replacing or clearing a schedule cannot deliver its retired incarnation', async () => {
  const deliver = vi.fn();
  const alarms = new ExtensionAlarms(deliver);
  alarms.call('alarms.create', ['maintenance', { delayInMinutes: 0.5 }]);
  await vi.advanceTimersByTimeAsync(20_000);
  alarms.call('alarms.create', ['maintenance', { delayInMinutes: 1 }]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(deliver).not.toHaveBeenCalled();
  expect(alarms.call('alarms.clear', ['maintenance'])).toBe(true);
  expect(alarms.call('alarms.clear', ['maintenance'])).toBe(false);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(deliver).not.toHaveBeenCalled();
});

it('stopping the browser cancels all schedules, including periodic alarms', async () => {
  const deliver = vi.fn();
  const alarms = new ExtensionAlarms(deliver);
  alarms.call('alarms.create', ['periodic', { periodInMinutes: 0.5 }]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(deliver).toHaveBeenCalledTimes(1);
  alarms.close();
  await vi.advanceTimersByTimeAsync(100_000);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(alarms.call('alarms.getAll', [])).toEqual([]);
});

it('bounds input and schedule count without disturbing a valid existing alarm', () => {
  const alarms = new ExtensionAlarms(vi.fn());
  for (let i = 0; i < 64; i++) alarms.call('alarms.create', [String(i), { delayInMinutes: 1 }]);
  expect(() => alarms.call('alarms.create', ['extra', { delayInMinutes: 1 }])).toThrow('Too many');
  expect(() => alarms.call('alarms.create', ['0', { delayInMinutes: NaN }])).toThrow('finite');
  expect(() => alarms.call('alarms.create', ['0', { delayInMinutes: Infinity }])).toThrow('finite');
  expect(() => alarms.call('alarms.create', ['0', { delayInMinutes: -1 }])).toThrow('nonnegative');
  expect(() => alarms.call('alarms.create', ['0', { when: 1, delayInMinutes: 1 }])).toThrow('Specify');
  expect(() => alarms.call('alarms.create', ['0', { delayInMinutes: 1e12 }])).toThrow('too long');
  expect(alarms.call('alarms.get', ['0'])).toEqual({ name: '0', scheduledTime: 1_060_000 });
  alarms.close();
});
