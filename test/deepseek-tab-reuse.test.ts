import { expect, it, vi } from 'vitest';
// @ts-expect-error Browser extension scripts are plain JavaScript and are exercised directly here.
import { createDeepseekTabReuse } from '../browser-extension/src/background/providers/execution/deepseek-tab-reuse.js';

it('reuses an idle provider tab without closing other chat windows', async () => {
  const conversations = new Map([
    [11, 'ds-old-chat-one'],
    [22, 'ds-old-chat-two']
  ]);
  const tabs = [
    { id: 11, windowId: 101, url: 'https://chat.deepseek.com/a/chat/s/one', status: 'complete', lastAccessed: 20 },
    { id: 22, windowId: 202, url: 'https://chat.deepseek.com/a/chat/s/two', status: 'complete', lastAccessed: 10 }
  ];
  const removeTab = vi.fn(async () => undefined);
  const updateTab = vi.fn(async () => undefined);
  const reuse = createDeepseekTabReuse({
    chrome: { tabs: { get: async (id: number) => tabs.find(tab => tab.id === id), remove: removeTab, update: updateTab } },
    queryProviderTabs: async () => tabs,
    usableProviderTab: (tab: { id?: number }) => Number.isInteger(tab.id),
    restoreDeepseekTab: async () => true,
    tabReply: async (tabId: number, message: { type: string }) => {
      const conversationId = conversations.get(tabId);
      return message.type === 'neuraflok-deepseek-status'
        ? { signedIn: true, generating: false, conversationId }
        : { signedIn: true, generating: false, hasConversation: true, conversationId };
    },
    isDeepseekUrl: (url: string) => url.startsWith('https://chat.deepseek.com/'),
    readProviderTab: async (conversationId: string) => ({
      provider: 'deepseek',
      tab: conversationId === 'ds-old-chat-one' ? 11 : 22,
      url: conversationId === 'ds-old-chat-one'
        ? 'https://chat.deepseek.com/a/chat/s/one'
        : 'https://chat.deepseek.com/a/chat/s/two'
    }),
    conversationPageUrl: (value: string) => value.split('?')[0]?.replace(/\/$/, '') || null
  });

  const result = await reuse({ conversationId: 'ds-new-chat' }, true);

  expect(result).toMatchObject({ tab: { id: 11 }, rebindSavedConversation: true });
  expect(removeTab).not.toHaveBeenCalled();
  expect(updateTab).not.toHaveBeenCalled();
});
