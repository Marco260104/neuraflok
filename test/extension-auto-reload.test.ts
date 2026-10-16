import { expect, it, vi } from 'vitest';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { createExtensionUpdater } from '../browser-extension/src/background/connectivity/update-coordinator.js';

function setup(options: {
  running?: string;
  prepared?: { build?: string; ready?: boolean };
  attempt?: string;
  busy?: boolean;
} = {}) {
  const saved: Record<string, unknown> = options.attempt ? { neuraflokExtensionUpdateAttempt: options.attempt } : {};
  const reload = vi.fn();
  const request = vi.fn(async () => ({
    ok: true,
    data: options.prepared ?? { build: 'bbbbbbbbbbbb', ready: true }
  }));
  const chrome = {
    runtime: { reload },
    storage: {
      local: {
        async get(keys: string | string[]) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(requested.map(key => [key, saved[key]]));
        },
        async set(value: Record<string, unknown>) { Object.assign(saved, value); },
        async remove(key: string) { delete saved[key]; }
      }
    }
  };
  const bridge = { state: { buildId: options.running ?? 'aaaaaaaaaaaa' }, request };
  const updater = createExtensionUpdater({ bridge, chrome, isBusy: () => options.busy === true } as never);
  return { updater, reload, request, saved };
}

it('reloads only after the app prepared the exact offered build for an idle browser', async () => {
  const h = setup();
  await h.updater.update({ build: 'bbbbbbbbbbbb', busy: false });
  await vi.waitFor(() => expect(h.reload).toHaveBeenCalledTimes(1));

  expect(h.request).toHaveBeenCalledWith('/extension/update', { method: 'POST', body: '{}' });
  expect(h.saved.neuraflokExtensionUpdateAttempt).toBe('aaaaaaaaaaaa>bbbbbbbbbbbb');
  expect(h.updater.hold).toBeNull();
});

it.each([
  ['the app is busy', { build: 'bbbbbbbbbbbb', busy: true }, {}, 'app-busy'],
  ['provider work is active', { build: 'bbbbbbbbbbbb', busy: false }, { busy: true }, 'browser-work']
] as const)('waits while %s', async (_label, offer, options, hold) => {
  const h = setup(options);
  await h.updater.update(offer);

  expect(h.updater.hold).toBe(hold);
  expect(h.request).not.toHaveBeenCalled();
  expect(h.reload).not.toHaveBeenCalled();
});

it.each([
  ['the offer is invalid', { build: 'invalid', busy: false }, {}, null],
  ['the offer matches this build', { build: 'aaaaaaaaaaaa', busy: false }, {}, null],
  ['the prepared folder is not ready', { build: 'bbbbbbbbbbbb', busy: false }, { prepared: { build: 'bbbbbbbbbbbb', ready: false } }, 'folder-not-ready'],
  ['the app prepared another build', { build: 'bbbbbbbbbbbb', busy: false }, { prepared: { build: 'cccccccccccc', ready: true } }, 'folder-not-ready'],
  ['this build pair was already tried', { build: 'bbbbbbbbbbbb', busy: false }, { attempt: 'aaaaaaaaaaaa>bbbbbbbbbbbb' }, 'already-tried']
] as const)('does not reload when %s', async (_label, offer, options, hold) => {
  const h = setup(options);
  await h.updater.update(offer);

  expect(h.updater.hold).toBe(hold);
  expect(h.reload).not.toHaveBeenCalled();
  if (hold !== 'folder-not-ready' && hold !== 'already-tried') expect(h.request).not.toHaveBeenCalled();
});

it('clears a stale hold when no build update is offered', async () => {
  const h = setup();
  await h.updater.update({ build: 'bbbbbbbbbbbb', busy: true });
  expect(h.updater.hold).toBe('app-busy');
  await h.updater.update(null);
  expect(h.updater.hold).toBeNull();
});
