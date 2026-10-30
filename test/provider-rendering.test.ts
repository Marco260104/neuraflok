import { expect, it, vi } from 'vitest';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { createActiveTabs } from '../browser-extension/src/background/browser/active-tabs/owner.js';
// @ts-expect-error Browser extension modules are plain JavaScript loaded directly by MV3.
import { registerProviderTabLifecycle } from '../browser-extension/src/background/providers/tab-events.js';

function setup() {
  let tab = { id: 7, url: 'https://chat.deepseek.com/', status: 'complete' };
  let documentId = 'provider-document';
  let update: ((id: number, change: Record<string, unknown>, currentTab: { id: number; url: string; status: string }) => void) | null = null;
  let remove: ((id: number) => void) | null = null;
  const attached = new Set<number>();
  const chrome = {
    storage: { session: { get: async () => ({}), set: async () => undefined, remove: async () => undefined } },
    tabs: {
      get: async () => ({ ...tab }),
      onUpdated: {
        addListener: (listener: typeof update) => { update = listener; },
        removeListener: vi.fn()
      },
      onRemoved: {
        addListener: (listener: typeof remove) => { remove = listener; },
        removeListener: vi.fn()
      },
      onActivated: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    },
    scripting: {
      executeScript: vi.fn(async () => [{ frameId: 0, documentId, result: tab.url }])
    },
    debugger: {
      attach: vi.fn(async ({ tabId }: { tabId: number }) => { attached.add(tabId); }),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => { attached.delete(tabId); }),
      getTargets: async () => [...attached].map(tabId => ({ tabId, attached: true })),
      sendCommand: vi.fn(async () => ({}))
    }
  };
  const activeTabs = createActiveTabs(chrome as never);
  registerProviderTabLifecycle(chrome as never, { activeTabs, providerRuntime: { onTabRemoved: vi.fn() } });
  const protect = () => activeTabs.set('provider:request', [tab], (candidate: { id: number }) => candidate.id === 7);
  const changed = (change: Record<string, unknown>) => update?.(7, change, { ...tab });
  return {
    chrome, activeTabs, attached, protect, changed,
    navigate(url: string, replacement = false) {
      tab = { ...tab, url };
      if (replacement) documentId = 'replacement-document';
      changed({ url });
    },
    reload() { tab = { ...tab, status: 'loading' }; changed({ status: 'loading' }); },
    remove() { remove?.(7); }
  };
}

it('keeps the exact provider document lease when Send promotes its single page route', async () => {
  const h = setup();
  await h.protect();
  expect(h.activeTabs.documentId(7)).toBe('provider-document');

  h.navigate('https://chat.deepseek.com/a/chat/s/new-conversation');
  await vi.waitFor(() => expect(h.activeTabs.documentId(7)).toBe('provider-document'));

  expect([...h.attached]).toEqual([7]);
  expect(h.chrome.debugger.detach).not.toHaveBeenCalled();
  expect(h.chrome.scripting.executeScript).toHaveBeenLastCalledWith({
    target: { tabId: 7, documentIds: ['provider-document'] }, injectImmediately: true, func: expect.any(Function)
  });

  await h.activeTabs.set('provider:request', []);
  expect([...h.attached]).toEqual([]);
});

it.each(['replacement', 'reload', 'foreign'] as const)('releases provider rendering on %s without borrowing another document', async kind => {
  const h = setup();
  await h.protect();
  if (kind === 'reload') h.reload();
  else h.navigate(kind === 'foreign' ? 'https://example.com/' : 'https://chat.deepseek.com/', kind === 'replacement');

  await vi.waitFor(() => expect(h.attached.size).toBe(0));
  expect(h.activeTabs.documentId(7)).toBeNull();
  expect(h.chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
});
