import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync('browser-extension/src/background/providers/tab-events.js', 'utf8').replace(/^export\s+/gm, '');
const registerLifecycle = vm.runInNewContext(`${source}\nregisterProviderTabLifecycle`, {}) as (
  chrome: Record<string, unknown>,
  dependencies: Record<string, unknown>
) => () => void;

function event() {
  let listener: ((value: { tabId: number }) => void) | null = null;
  const listeners = {
    addListener: vi.fn((next: (value: { tabId: number }) => void) => { listener = next; }),
    removeListener: vi.fn((next: (value: { tabId: number }) => void) => { if (listener === next) listener = null; })
  };
  return { listeners, fire: (value: { tabId: number }) => listener?.(value) };
}

it('refreshes provider presence immediately when reconnecting to an already-open provider tab', async () => {
  const activated = event();
  const maintain = vi.fn(async () => undefined);
  const chrome = {
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://chat.deepseek.com/' })),
      onActivated: activated.listeners,
      onRemoved: event().listeners,
      onUpdated: event().listeners
    }
  };
  const providerRuntime = {
    isProviderUrl: vi.fn((url: string) => url.includes('chat.deepseek.com')),
    onTabRemoved: vi.fn()
  };
  const dispose = registerLifecycle(chrome, { activeTabs: null, providerRuntime, maintain });

  activated.fire({ tabId: 42 });
  await vi.waitFor(() => expect(maintain).toHaveBeenCalledWith(true));
  expect(chrome.tabs.get).toHaveBeenCalledWith(42);

  dispose();
  expect(activated.listeners.removeListener).toHaveBeenCalledTimes(1);
});
