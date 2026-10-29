import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readRendererMarkup } from '../scripts/read-renderer-markup.cjs';
import { bindChatMainActions } from '../frontend/features/chat/chat-main-actions.js';
import { initWorkspaceNavigation } from '../frontend/application/workspace-navigation.js';

vi.mock('../frontend/features/settings/quick-settings.js', () => ({ initQuickSettings: vi.fn() }));

let dom: JSDOM | undefined;
afterEach(() => {
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
});

it('returns from Support to the new chat when the Chats plus button is used', async () => {
  dom = new JSDOM(await readRendererMarkup(process.cwd()), { url: 'https://local.test/' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);

  const selectNewChat = vi.fn();
  bindChatMainActions({
    api: {}, run: vi.fn(), selectedId: null, selectionGeneration: 0,
    controlledTurnId: null, controlledSessionId: null, controlledSelection: 0,
    hasComposerImages: () => false, sendComposer: vi.fn(), paintDeliveryControls: vi.fn(),
    refreshSessionControls: vi.fn(), selectNewChat, projects: [], expandedProjects: new Set(),
    sessionsLoadGeneration: 0, paintSessions: vi.fn(), handoff: null,
    refreshAll: vi.fn(), toast: vi.fn()
  } as any);

  const navigation = initWorkspaceNavigation({
    openSkillsLibrary: vi.fn(), refreshUpdate: vi.fn(), refreshUsage: vi.fn(),
    resetSettingsSearch: vi.fn(), openChatView: vi.fn(), chatVisible: vi.fn(), stickToNewestFeeds: vi.fn()
  });
  navigation.showTab('donation');
  expect(dom.window.document.querySelector<HTMLElement>('.app')!.dataset.screen).toBe('chat');
  expect(dom.window.document.querySelector('[data-panel="donation"]')!.classList.contains('is-active')).toBe(true);

  dom.window.document.getElementById('newChatInChats')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));

  expect(selectNewChat).toHaveBeenCalledOnce();
  expect(dom.window.document.querySelector<HTMLElement>('.app')!.dataset.screen).toBe('chat');
  expect(dom.window.document.querySelector('[data-panel="chat"]')!.classList.contains('is-active')).toBe(true);
  expect(dom.window.document.querySelector('[data-panel="donation"]')!.classList.contains('is-active')).toBe(false);
});
