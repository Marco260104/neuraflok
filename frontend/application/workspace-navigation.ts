import { $ } from '../shared/dom.js';
import { t, ui } from '../shared/i18n.js';
import { initQuickSettings } from '../features/settings/quick-settings.js';

interface WorkspaceNavigationDependencies {
  openSkillsLibrary: () => void;
  refreshUpdate: () => unknown;
  refreshUsage: () => unknown;
  resetSettingsSearch: () => void;
  openChatView: (name: string) => void;
  chatVisible: (visible: boolean) => void;
  stickToNewestFeeds: () => void;
}

export function initWorkspaceNavigation(dependencies: WorkspaceNavigationDependencies) {
  const permissionSurface = document.querySelector<HTMLElement>('.workspace-permissions > .settings-surface')!;
  const permissionHome = permissionSurface.parentElement!;

  function placePermissions(tab: string): void {
    const target = tab === 'setup' ? $('accessFineSlot') : permissionHome;
    if (permissionSurface.parentElement !== target) target.append(permissionSurface);
  }

  function showTab(name: string): void {
    const quick = document.getElementById('quickSettingsDialog') as HTMLDialogElement | null;
    if (quick?.open && name === 'chat') quick.close();
    if (name === 'skills') dependencies.openSkillsLibrary();
    placePermissions(name);
    const library = name === 'skills';
    const donation = name === 'donation';
    const settings = name !== 'chat' && !library && !donation;
    if (settings && document.querySelector<HTMLElement>('.app')!.dataset.screen !== 'settings') void dependencies.refreshUpdate();
    document.querySelector<HTMLElement>('.app')!.dataset.screen = library ? 'library' : settings ? 'settings' : 'chat';
    const pageTitles: Record<string, string> = {
      chat: 'Workspace', setup: 'Connections', skills: 'Skills', activity: 'Activity',
      home: 'Settings', general: 'Settings', usage: 'Usage', settings: 'Agent settings', donation: 'Support the project',
      appearance: 'Appearance'
    };
    const pageTitle = pageTitles[name] ?? 'Workspace';
    ui($('appPageTitle'), 'textContent', () => t(pageTitle));
    for (const item of document.querySelectorAll<HTMLButtonElement>('[data-workspace-page]')) {
      item.classList.toggle('is-sel', item.dataset.workspacePage === name);
    }
    document.querySelector<HTMLElement>('.sidebar-brand')!.hidden = settings;
    $('sidebarPrimary').hidden = settings;
    $('workspaceSettings').hidden = false;
    const quickOpen = Boolean((document.getElementById('quickSettingsDialog') as HTMLDialogElement | null)?.open);
    $('workspaceSettings').classList.toggle('is-sel', settings || quickOpen);
    $('workspaceSettings').setAttribute('aria-expanded', String(quickOpen));
    if (name === 'usage') void dependencies.refreshUsage();
    $('tabs').hidden = !settings;
    $('settingsFindBox').hidden = !settings;
    dependencies.resetSettingsSearch();
    $('backToChat').hidden = !settings;
    document.querySelector<HTMLElement>('.sidebar-sessions')!.hidden = settings;
    $('newChat').hidden = settings;
    for (const tab of document.querySelectorAll<HTMLElement>('#tabs button')) {
      tab.classList.toggle('is-sel', tab.dataset.tab === name);
    }
    for (const item of document.querySelectorAll<HTMLElement>('[data-sidebar-page]')) {
      item.classList.toggle('is-sel', item.dataset.sidebarPage === name);
    }
    for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
      panel.classList.toggle('is-active', panel.dataset.panel === (name === 'settings' ? 'chat' : name));
    }
    if (name === 'settings') dependencies.openChatView('settings');
    else if (name === 'chat') dependencies.openChatView('timeline');
    dependencies.chatVisible(name === 'chat' || name === 'settings');
    dependencies.stickToNewestFeeds();
  }

  $('backToChat').addEventListener('click', () => showTab('chat'));
  $('railWorkspace').addEventListener('click', () => showTab('chat'));
  initQuickSettings({ showTab });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-workspace-page]:not([data-workspace-page="chat"])')) {
    button.addEventListener('click', () => showTab(button.dataset.workspacePage || 'chat'));
  }
  $('chatSettingsBtn').addEventListener('click', () => showTab('settings'));
  $('sessionList').addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('[data-id], [data-new-project]')) showTab('chat');
  }, { capture: true });
  $('newChat').addEventListener('click', () => showTab('chat'));
  $('newChatInChats')?.addEventListener('click', () => showTab('chat'));
  $('sidebarSkills').addEventListener('click', () => showTab('skills'));
  $('supportProject').addEventListener('click', () => showTab('donation'));
  $('addProject').addEventListener('click', () => showTab('chat'));
  $('composerFolder').addEventListener('click', () => $('addProject').click());
  $('tabs').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
    if (button?.dataset.tab) showTab(button.dataset.tab);
  });

  return { showTab };
}
