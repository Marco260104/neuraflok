import { expect, it, vi } from 'vitest';
import { loadFreshDevelopmentRenderer } from '../backend/application/window-load.js';

it('clears cached assets before opening the development renderer', async () => {
  const calls: string[] = [];
  const loaded = await loadFreshDevelopmentRenderer(
    async () => { calls.push('clear-cache'); },
    async () => { calls.push('load-renderer'); return 'loaded'; }
  );
  expect(calls).toEqual(['clear-cache', 'load-renderer']);
  expect(loaded).toBe('loaded');
});

it('opens the development renderer even if clearing its cache fails', async () => {
  const load = vi.fn(async () => 'loaded');
  await expect(loadFreshDevelopmentRenderer(async () => { throw new Error('cache unavailable'); }, load))
    .resolves.toBe('loaded');
  expect(load).toHaveBeenCalledOnce();
});
