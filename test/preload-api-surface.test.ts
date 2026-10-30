import { expect, it, vi } from 'vitest';

const { expose } = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn() }
}));

it('exposes the complete renderer API without exposing Electron IPC', async () => {
  await import('../backend/preload/index.js');
  const [world, value] = expose.mock.calls[0]!;
  const api = value as Record<string, unknown>;

  expect(world).toBe('api');
  expect(Object.keys(api)).toHaveLength(125);
  expect(Object.values(api).every(action => typeof action === 'function')).toBe(true);
  expect(api).toHaveProperty('setCustomProviderHeaders');
  expect(api).not.toHaveProperty('ipcRenderer');
});
