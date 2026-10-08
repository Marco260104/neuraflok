import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it, vi } from 'vitest';

const source = readFileSync('browser-extension/src/background/providers/session-observer.js', 'utf8').replace(/^export\s+/gm, '');
const createObserver = vm.runInNewContext(`${source}\ncreateProviderSessionObserver`, { URL }) as (options: Record<string, unknown>) => {
  inspect(): Promise<Record<string, { open: boolean; signedIn: boolean | null; tabId: number | null }>>;
};

it('reports exact signed-in page evidence and restores an unresponsive provider adapter', async () => {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    deepseek: [{ id: 10, url: 'https://chat.deepseek.com/', status: 'complete' }],
    kimi: [{ id: 20, url: 'https://www.kimi.com/en/', status: 'complete' }],
    qwen: [],
    glm: [{ id: 40, url: 'https://z.ai/chat', status: 'complete' }]
  };
  const providerTabs = {
    list: vi.fn(async (provider: string) => rows[provider] || []),
    usable: (tab: Record<string, unknown>) => Number.isInteger(tab?.id) && tab.status !== 'loading' && tab.discarded !== true && tab.frozen !== true,
    pageType: (provider: string, action: string) => provider === 'deepseek'
      ? `neuraflok-deepseek-${action}` : `neuraflok-provider-${action}`,
    providerForUrl: (value: string) => new URL(value).hostname === 'chat.deepseek.com' ? 'deepseek' : null
  };
  const tabReply = vi.fn(async (tabId: number, message: { type: string }) => {
    if (tabId === 10) return { signedIn: true };
    if (tabId === 20 && message.type === 'neuraflok-provider-status' && tabReply.mock.calls.filter(([id]) => id === 20).length > 1) {
      return { provider: 'kimi', signedIn: true };
    }
    if (tabId === 40) return { provider: 'kimi', signedIn: true };
    return null;
  });
  const restoreProviderTab = vi.fn(async () => true);
  const observer = createObserver({
    chrome: { tabs: { get: async (id: number) => ({ id, url: 'https://chat.deepseek.com/', status: 'complete' }) } },
    providerTabs,
    deepseekPages: new Map(),
    reviveDeepseekTab: vi.fn(async () => null),
    restoreDeepseekTab: vi.fn(async () => true),
    restoreProviderTab,
    tabReply
  });

  await expect(observer.inspect()).resolves.toEqual({
    deepseek: { open: true, signedIn: true, tabId: 10 },
    kimi: { open: true, signedIn: true, tabId: 20 },
    qwen: { open: false, signedIn: null, tabId: null },
    glm: { open: true, signedIn: null, tabId: 40 }
  });
  expect(restoreProviderTab).toHaveBeenCalledWith('kimi', 20);
  expect(restoreProviderTab).toHaveBeenCalledWith('glm', 40);
});

it('revalidates a recent page announcement before using it as a provider tab', async () => {
  const providerTabs = {
    list: async () => [],
    usable: (tab: Record<string, unknown>) => Number.isInteger(tab?.id) && tab.status !== 'loading',
    pageType: () => 'neuraflok-deepseek-status',
    providerForUrl: (value: string) => new URL(value).hostname === 'chat.deepseek.com' ? 'deepseek' : null
  };
  const deepseekPages = new Map([[30, { at: Date.now(), signedIn: true }]]);
  const observer = createObserver({
    chrome: { tabs: { get: async () => ({ id: 30, url: 'https://chat.deepseek.com/', status: 'complete' }) } },
    providerTabs,
    deepseekPages,
    reviveDeepseekTab: async () => null,
    restoreDeepseekTab: async () => true,
    restoreProviderTab: async () => true,
    tabReply: async () => ({ signedIn: true })
  });

  await expect(observer.inspect()).resolves.toMatchObject({
    deepseek: { open: true, signedIn: true, tabId: 30 }
  });

  const invalid = createObserver({
    chrome: { tabs: { get: async () => ({ id: 30, url: 'https://example.com/', status: 'complete' }) } },
    providerTabs,
    deepseekPages,
    reviveDeepseekTab: async () => null,
    restoreDeepseekTab: async () => true,
    restoreProviderTab: async () => true,
    tabReply: async () => null
  });
  await expect(invalid.inspect()).resolves.toMatchObject({
    deepseek: { open: false, signedIn: null, tabId: null }
  });
  expect(deepseekPages.has(30)).toBe(false);
});
