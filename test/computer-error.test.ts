import { expect, it } from 'vitest';
import { ComputerError } from '../backend/infrastructure/device-control/native/errors.js';

it('keeps desktop error progress own, nullable, and detached from caller arrays', () => {
  const routes: Array<'uia' | 'sendinput' | 'focus' | 'shell' | 'local'> = ['uia'];
  const failure = new ComputerError('PARTIAL_BATCH', { completedCount: 1, failedIndex: 2, completedRoutes: routes });
  routes.push('local');

  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toBe('PARTIAL_BATCH');
  expect(failure.completedCount).toBe(1);
  expect(failure.failedIndex).toBe(2);
  expect(failure.completedRoutes).toEqual(['uia']);
  expect(Object.keys(failure)).toEqual(expect.arrayContaining(['completedCount', 'failedIndex', 'completedRoutes']));
});

it('normalizes missing desktop progress to null fields', () => {
  const failure = new ComputerError('NATIVE_FAILURE');

  expect(failure.completedCount).toBeNull();
  expect(failure.failedIndex).toBeNull();
  expect(failure.completedRoutes).toBeNull();
});
