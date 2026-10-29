import { expect, it, vi } from 'vitest';
import { loadFreshIntegratedExtension } from '../backend/domains/browser/embedded/extension-loading.js';

it('clears a cached service worker before loading the current integrated extension', async () => {
  const calls: string[] = [];
  const extension = { id: 'current-extension', version: '0.1.0' };
  const loaded = await loadFreshIntegratedExtension(
    async () => { calls.push('clear-service-workers'); },
    async () => { calls.push('load-current-extension'); return extension; }
  );
  expect(calls).toEqual(['clear-service-workers', 'load-current-extension']);
  expect(loaded).toBe(extension);
});

it('still loads the current extension if clearing stale workers is unavailable', async () => {
  const load = vi.fn(async () => ({ id: 'current-extension' }));
  await expect(loadFreshIntegratedExtension(async () => { throw new Error('storage unavailable'); }, load))
    .resolves.toEqual({ id: 'current-extension' });
  expect(load).toHaveBeenCalledOnce();
});
