import { beforeEach, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ ui: { chatExecutor: 'web' as 'web' | 'api', webProvider: 'deepseek' as string } }));
const status = vi.hoisted(() => ({
  deepseek: { open: false, signedIn: null as boolean | null, tabId: null, lastSeenAt: null },
  kimi: { open: false, signedIn: null as boolean | null, tabId: null, lastSeenAt: null },
  qwen: { open: false, signedIn: null as boolean | null, tabId: null, lastSeenAt: null },
  glm: { open: false, signedIn: null as boolean | null, tabId: null, lastSeenAt: null }
}));
const startBridge = vi.hoisted(() => vi.fn(async () => 1));
const openProvider = vi.hoisted(() => vi.fn(async () => undefined));
const listeners = vi.hoisted(() => new Set<() => void>());

vi.mock('../backend/infrastructure/settings/config.js', () => ({ getConfig: () => config }));
vi.mock('../backend/domains/browser/bridge.js', () => ({
  startBridge: () => startBridge(),
  webProvidersStatus: () => status,
  onBridgeChange: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}));
vi.mock('../backend/domains/browser/embedded/selection.js', () => ({
  loadIntegratedBrowser: async () => ({ openProvider })
}));

import { connectSelectedWebModel, resetWebModelConnectForTests, selectedWebProvider } from '../backend/domains/browser/web-model-connect.js';

beforeEach(() => {
  resetWebModelConnectForTests();
  config.ui.chatExecutor = 'web';
  config.ui.webProvider = 'deepseek';
  status.deepseek.signedIn = null;
  status.deepseek.open = false;
  startBridge.mockClear().mockResolvedValue(1);
  openProvider.mockClear().mockResolvedValue(undefined);
  listeners.clear();
});

it('opens the selected web provider in the background at startup', async () => {
  await connectSelectedWebModel();
  expect(startBridge).toHaveBeenCalledOnce();
  expect(openProvider).toHaveBeenCalledWith('deepseek', { reveal: false, hideAfterSignIn: true });
  expect(selectedWebProvider()).toBe('deepseek');
});

it('skips the private browser when the API executor is selected', async () => {
  config.ui.chatExecutor = 'api';
  await connectSelectedWebModel();
  expect(startBridge).not.toHaveBeenCalled();
  expect(openProvider).not.toHaveBeenCalled();
});

it('reveals the provider page once the companion reports that sign-in is required', async () => {
  await connectSelectedWebModel();
  expect(openProvider).toHaveBeenCalledTimes(1);
  status.deepseek.signedIn = false;
  status.deepseek.open = true;
  for (const listener of listeners) listener();
  await Promise.resolve();
  expect(openProvider).toHaveBeenLastCalledWith('deepseek', { reveal: true, hideAfterSignIn: true });
});
