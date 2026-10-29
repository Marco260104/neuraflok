import { initBrowserSetup } from './features/browser/setup-browser.js';
import { initWebModelLoading, markInitialBootComplete, webModelLoadingPhase } from './features/browser/web-model-loading.js';
import { createConnectionCapsule } from './features/browser/connection-capsule.js';
import { dismissBootSplash, mountBrandAssets, updateBootSplashStatus } from './brand-assets.js';
import { mountProviderMarks } from './features/browser/provider-marks.js';
import { currentLanguage, ui, t, initLanguage, onLanguageChange } from './shared/i18n.js';
import { createProviderStatusView } from './features/settings/provider-status-view.js';
import { createUpdateStatusView } from './features/settings/update-status-view.js';
import { createSetupWizard } from './features/setup/setup-wizard.js';
import { initUsage, refreshUsage } from './features/settings/usage.js';
import { initSidebarLayout } from './features/workspace/sidebar-layout/controller.js';
import { initViewMenu } from './features/settings/view-menu.js';
import { initBrowserPreferences } from './features/settings/browser-preferences.js';
import { initAppearance } from './features/settings/appearance.js';
import { initKeychainNotice } from './features/settings/keychain-notice.js';
import { initSkillsLibrary } from './features/settings/skill-library/composition.js';
import { initWhatsNew } from './features/settings/whats-new.js';
import { initSettingsSearch } from './features/settings/search/controller.js';
import { createGeneralPreferencesView } from './features/settings/general-preferences-view.js';
import { initLegalSettings } from './features/settings/legal-view.js';
import type { AppearanceSettings } from '../contracts/appearance-settings.js';
// Renderer. No Node, no filesystem, no network — everything goes through window.api. The DOM skeleton lives in index.html; this fills it in and never rebuilds a control the user might be typing into. The permission rows are the one exception: they are generated from CAPABILITIES so a new capability appears without touching markup. Two rules the layout depends on. The window is a fixed frame, so nothing here may change the height of anything outside its own scroll pane — that is why only one permission group is expanded at a time. And the two live numbers tick locally every second, so "verified 8s ago" keeps counting between the 15s reports from the main process instead of freezing at a number that is quietly going stale.

import type { AppApi } from '../backend/preload/index.js';
import { requiresApprovedFilesystemRoot } from '../contracts/capabilities.js';
import { usesApiProvider } from '../contracts/chat-protocol.js';
import { WEB_PROVIDERS, selectableWebProviderOrDefault } from '../contracts/web-providers.js';
import type { AppState, Capability } from '../contracts/types.js';
import {
  DESKTOP_CAPABILITIES
} from '../contracts/types.js';
import { $, run, toast } from './shared/dom.js';
import { chatApply, chatVisible, initChat, openChatSearch, openChatView } from './features/chat/chat.js';
import { publishStopNoticeTexts } from './features/chat/stop-notices.js';
import { publishMainTexts } from './shared/main-texts.js';
import { initPermissionSettings } from './features/settings/permissions.js';
import { initApprovedRoots } from './features/workspace/approved-roots.js';
import { initActivityFeed } from './features/activity/activity-feed.js';
import { createSettingsPersistence } from './features/settings/settings-persistence.js';
import { initWorkspaceNavigation } from './application/workspace-navigation.js';
import { initWebProviderActions } from './application/web-provider-actions.js';
import { initDiagnosticsActions } from './application/diagnostics-actions.js';
import { initFolderDropActions } from './application/folder-drop-actions.js';
import { initActivityLogHydration } from './features/activity/activity-log-hydration.js';
import { initDonationPage } from './features/donation/donation-page.js';
import { bindTopbarSocialLinks } from './features/workspace/social-links.js';

declare global {
  interface Window {
    api: AppApi;
  }
}

const api = window.api;
let workspaceNavigation: ReturnType<typeof initWorkspaceNavigation> | null = null;
function showTab(name: string): void {
  if (!workspaceNavigation) throw new Error('Workspace navigation is not initialized');
  workspaceNavigation.showTab(name);
}
mountBrandAssets();
// Initial splash dismissal is deferred until startup completes.
// First: main announces a Keychain read before it starts and may not get through again until it ends.
initKeychainNotice(api);
initLanguage();
initDonationPage();
initLegalSettings();
publishStopNoticeTexts(texts => api.setStopNoticeTexts(texts));
// The tray menu and desktop notices come from the main process, which has no catalogs.
publishMainTexts(texts => api.setMainTexts?.(texts));
// The browser extension shows its texts in the app's language, not Chrome's; the app hands it on.
const publishUiLanguage = (): void => { void Promise.resolve(api.setUiLanguage?.(currentLanguage())).catch(() => undefined); };
publishUiLanguage();
onLanguageChange(publishUiLanguage);
const settingsSearch = initSettingsSearch({
  open: tab => showTab(tab),
  shown: () => document.querySelector<HTMLElement>('.app')!.dataset.screen === 'settings'
});
const browserSetup = initBrowserSetup({
  open: (provider, mode) => run(api.openWebProvider(provider, mode)),
  showBrowser: () => run(api.showIntegratedBrowser())
});
const webModelLoading = initWebModelLoading({
  showBrowser: () => run(api.showIntegratedBrowser())
});
// Escape the translucent sidebar's backdrop-filter containing block.
document.body.append($('connectionPopover'));
const appearance = initAppearance(patch => { void save(patch); });


let state: AppState | null = null;
/** Guards against saving while we are writing values into the controls. */
let applying = false;
const permissionSettings = initPermissionSettings({
  getState: () => state,
  isApplying: () => applying,
  save: patch => save(patch)
});
const {
  accessLevel,
  accessWorks,
  buildGroups,
  paintAccess,
  paintCommandPolicyMode,
  paintDesktopAccess,
  paintGroups,
  readCommandAllowlist,
  toolsOn
} = permissionSettings;
const approvedRoots = initApprovedRoots({ api,getState:() => state,apply });
const { paintRoots } = approvedRoots;

// Applies persisted form state without erasing a value the user is currently editing. `state:changed` is primarily a live status push, but it carries the whole config object. A focused field can therefore differ from the last persisted config for several seconds before its `change` event saves it. Only that exact dirty case is protected; an idle/focused-but-clean field still follows persisted state normally.
function applyValue(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, next: string, previous?: string): void {
  const dirty = document.activeElement === control && previous !== undefined && control.value !== previous;
  if (!dirty) control.value = next;
}

function applyChecked(control: HTMLInputElement, next: boolean, previous?: boolean): void {
  const dirty = document.activeElement === control && previous !== undefined && control.checked !== previous;
  if (!dirty) control.checked = next;
}
const generalPreferencesView = createGeneralPreferencesView({ applyValue, applyChecked });
// Tabs section.

let openSkillsLibrary: () => void = () => undefined;

let zoomFactor = 1;
let zoomEdited = false;
void api.getZoom().then(result => {
  if (zoomEdited || !result.ok || typeof result.data !== 'number' || !Number.isFinite(result.data)) return;
  zoomFactor = result.data;
});
async function zoom(next: number): Promise<void> {
  zoomEdited = true;
  const result = await run(api.setZoom(Math.min(1.5, Math.max(.75, next))));
  if (result !== null) zoomFactor = result;
  viewMenu.refresh();
}
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || !['+', '=', '-', '0'].includes(event.key)) return;
  event.preventDefault(); void zoom(event.key === '0' ? 1 : zoomFactor + (event.key === '-' ? -.1 : .1));
});
const settingsPersistence = createSettingsPersistence({
  api,
  getState: () => state,
  isApplying: () => applying,
  readCommandAllowlist,
  apply,
  refresh
});

function save(over: { readOnly?: boolean; theme?: 'light' | 'dark'; appearance?: AppearanceSettings } = {}): Promise<void> {
  return settingsPersistence.save(over);
}

// Helpers section.

const setupWizard = createSetupWizard({
  getState: () => state,
  applyCurrent: () => { if (state) apply(state); },
  showTab,
  browserSetup
});

const updateStatusView = createUpdateStatusView();

function missingStep(next: AppState): { step: string; text: string } | null {
  const { config } = next;
  if (config.roots.length === 0 && requiresApprovedFilesystemRoot(config)) {
    return { step: 'folder', text: t("Choose a folder to share — step 2.") };
  }
  return null;
}

// Prevents connection actions until a provider session is ready.
function apiProviderConfigured(next: AppState): boolean {
  const goal = next.config.goal;
  const provider = next.config.providers?.api;
  if (!goal || !provider || typeof goal.model !== 'string') return false;
  return Boolean(goal.model.trim() && (provider.kind === 'custom'
    ? provider.baseUrl.trim()
    : provider.kind === 'openai' ? next.hasOpenAiModelKey === true : next.hasGoalKey));
}

function apiProviderWorkspaceLabel(next: AppState): string {
  return apiProviderConfigured(next) ? t('Model ready') : t('Set up a model');
}

// Render section.

const providerStatusView = createProviderStatusView({
  getState: () => state,
  apiProviderConfigured,
  apiProviderWorkspaceLabel,
  toolsOn
});

function paintConnectionCapsule(next: AppState): void {
  const apiExecutor = usesApiProvider(next.config.ui.chatExecutor);
  const apiConfigured = apiProviderConfigured(next);
  const selectedProvider = selectableWebProviderOrDefault(next.config.ui.webProvider);
  const selectedSession = providerStatusView.providerPresence(next.bridge, selectedProvider);
  const workspaceConnected = apiExecutor ? apiConfigured : next.bridge.present && selectedSession?.signedIn === true;
  const workspaceLabel = apiExecutor ? apiProviderWorkspaceLabel(next) : providerStatusView.webProviderWorkspaceLabel(next);
  const connectionTone = apiExecutor ? apiConfigured ? 'is-configured' : '' : workspaceConnected ? 'is-connected' : next.bridge.present ? '' : 'is-error';
  connectionCapsule.paint({ connected: workspaceConnected, tone: connectionTone, label: workspaceLabel });
}

function refreshConnectionStatus(): void {
  if (!state) return;
  paintConnectionCapsule(state);
  providerStatusView.paintClock();
}

const connectionCapsule = createConnectionCapsule(refreshConnectionStatus);

function apply(next: AppState): void {
  const previousState = state;
  state = next;
  applying = true;
  const { config } = next;
  const apiExecutor = usesApiProvider(config.ui.chatExecutor);
  const missing = missingStep(next);

  // Theme section.
  const appearanceUi = settingsPersistence.requestedSettings()?.ui ?? config.ui;
  appearance.apply(appearanceUi);

  // Provider status capsule section.
  const selectedProvider = selectableWebProviderOrDefault(config.ui.webProvider);
  paintConnectionCapsule(next);
  webModelLoading.paint(next);
  ui($('headerSub'), 'textContent', () => apiExecutor
      ? `${config.providers.api.kind === 'custom' ? 'Custom endpoint' : config.providers.api.kind === 'openai' ? 'OpenAI' : 'OpenRouter'} · ${config.goal.model}`
      : `${WEB_PROVIDERS[selectedProvider].label} · browser session`);

  // App and extension update status.
  updateStatusView.paint(next);

  // Health numbers and facts section.
  providerStatusView.paintClock();
  $('facts').replaceChildren(...providerStatusView.facts(next));

  // Permissions section.
  $('readOnlyBtn').classList.toggle('is-on', config.readOnly);
  $('readOnlyBtn').setAttribute('aria-pressed', String(config.readOnly));
  // The lock reads like a state; the title says which way a click goes and what it changes.
  ui($('readOnlyBtn'), 'title', () => config.readOnly
    ? t('Read-only is on: connected providers can only look. Click to allow changes again.')
    : t('Switch to read-only: connected providers can look at files and the screen, but cannot change files, run programs or control this computer.'));
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-cap]')) {
    const cap = input.dataset.cap as Capability;
    const supported = (next.platform?.desktopAutomation ?? true) || !DESKTOP_CAPABILITIES.includes(cap) || cap === 'screen' || cap === 'control';
    applyChecked(input, supported && config.capabilities[cap], previousState?.config.capabilities[cap]);
  }
  applyChecked(
    $<HTMLInputElement>('homeMaEnabled'),
    config.multiAgent.enabled,
    previousState?.config.multiAgent.enabled
  );
  applyChecked(
    $<HTMLInputElement>('commandAllowlistEnabled'),
    config.commandAllowlist.enabled,
    previousState?.config.commandAllowlist.enabled
  );
  const previousCommandPolicyMode = previousState?.config.commandAllowlist.mode;
  const focusedCommandPolicyMode = (document.activeElement as HTMLElement | null)?.dataset.commandPolicyMode;
  if (!focusedCommandPolicyMode || previousCommandPolicyMode === undefined || focusedCommandPolicyMode === previousCommandPolicyMode) {
    paintCommandPolicyMode(config.commandAllowlist.mode);
  }
  applyValue(
    $<HTMLTextAreaElement>('commandAllowlistRules'),
    config.commandAllowlist.rules.join('\n'),
    previousState?.config.commandAllowlist.rules.join('\n')
  );
  readCommandAllowlist();
  paintGroups();
  paintDesktopAccess(next);

  // Folders section.
  paintRoots(config.roots);
  $('rootsEmpty').hidden = config.roots.length > 0;

  // Nav badge section.
  $('setupBadge').hidden = missing === null;

  // Setup section.
  generalPreferencesView.paint(next, previousState);

  setupWizard.apply({
    next,
    missingStep,
    paintAccess,
    accessLevel,
    accessWorks,
    addFolder
  });
  chatApply(next, previousState?.config);

  applying = false;
}

window.setInterval(refreshConnectionStatus, 1000);

permissionSettings.bindAccessChoiceControls();

const { addLogLine, paintAgentFilter, stickToNewestFeeds } = initActivityFeed();
workspaceNavigation = initWorkspaceNavigation({
  openSkillsLibrary: () => openSkillsLibrary(),
  refreshUpdate: () => api.refreshUpdate(),
  refreshUsage,
  resetSettingsSearch: () => settingsSearch.reset(),
  openChatView,
  chatVisible,
  stickToNewestFeeds
});

// Wiring section.

initDiagnosticsActions({ api, getState: () => state, apply, providerStatusView });

async function addFolder(): Promise<void> {
  const next = await run(api.addRoot());
  if (next) apply(next);
}

$('readOnlyBtn').addEventListener('click', () => {
  if (!state) return;
  const current = settingsPersistence.requestedSettings()?.readOnly ?? state.config.readOnly;
  void save({ readOnly: !current });
});

$('addFolder').addEventListener('click', () => void addFolder());
$('wizAddFolder').addEventListener('click', () => void addFolder());
$('wizManageFolders').addEventListener('click', () => {
  showTab('home');
  $('foldersCard').scrollIntoView({ block: 'nearest' });
  $('addFolder').focus({ preventScroll: true });
});
initFolderDropActions({ api, apply });

$('updateGet').addEventListener('click', () => void run(api.downloadUpdate()));

// Install the update that is already downloaded. The app quits to do it — that is the only moment an installer can replace files nothing is holding open — so say so before it happens rather than leaving a window that vanishes on a click looking like a crash. Both buttons are the same action; either can be the one pressed.
function installUpdate(): void {
  toast(t("Installing the update. NEURAFLOK will close and restart as the new version."));
  void run(api.installUpdate());
}

$('updateInstall').addEventListener('click', installUpdate);
$('installUpdate').addEventListener('click', installUpdate);
$('readyStart').addEventListener('click', () => showTab('chat'));
initWebProviderActions({ api, getState: () => state, apply, save: () => save(), showTab });
for (const id of [
  'webProvider',
  'chatExecutor',
  'browserWebProvider',
  'startAtLogin',
  'minimizeToTray',
  'developerMode',
  'followOutput',
  'mentionCore',
  'controlApiEnabled',
  'controlApiAllowActions',
  'privacyScreenshots',
]) {
  $(id).addEventListener('change', () => void save());
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const external = target.closest<HTMLElement>('[data-link-external]');
  if (external?.dataset.linkExternal) {
    event.preventDefault();
    void run(api.openLink(external.dataset.linkExternal, { external: true }));
    return;
  }
  const link = target.closest<HTMLElement>('[data-link]');
  if (link?.dataset.link) {
    if (link instanceof HTMLAnchorElement) event.preventDefault();
    void run(api.openLink(link.dataset.link));
  }
});
bindTopbarSocialLinks(document, url => {
  void run(api.openLink(url, { external: true }));
});
$('updateExtension')?.addEventListener('click', () => {
  const stepBrowser = setupWizard.step('browser');
  if (stepBrowser) stepBrowser.hidden = false;
  setupWizard.openStep('browser');
});

api.onStateChanged(apply);
const activityLogHydration = initActivityLogHydration({ api, addLogLine });
api.onSwarmChanged(paintAgentFilter);

async function refresh(): Promise<void> {
  const next = await run(api.getState());
  if (next) apply(next);
}

buildGroups();
mountProviderMarks();
initSidebarLayout();
const viewMenu = initViewMenu({
  search: openChatSearch,
  integratedBrowser: () => (state?.config.ui.chatBrowser ?? 'integrated') === 'integrated',
  showIntegratedBrowser: () => void run(api.showIntegratedBrowser()),
  zoom: { step: delta => zoom(zoomFactor + delta), reset: () => zoom(1), percent: () => zoomFactor * 100 }
});
initUsage();
openSkillsLibrary = initSkillsLibrary(api);
initBrowserPreferences();
initChat({ save: () => save(), state: () => state });

void (async () => {
  const isTestEnv = typeof window !== 'undefined' && (window.location?.hostname === 'local.test' || Boolean((window as any).__VITEST__));
  try {
    updateBootSplashStatus('Cargando componentes...');
    // Micro-yield so initial splash frame renders without jank
    if (!isTestEnv) {
      const rAF = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(cb, 0);
      await new Promise(r => rAF(() => setTimeout(r, 60)));
    }

    updateBootSplashStatus('Cargando sistema...');
    await refresh();
    // A first run has nothing set up, so open on the wizard rather than an empty Home.
    showTab(state && missingStep(state)?.step === 'folder' ? 'setup' : 'chat');
    // Show What's New after an update, but not during first-run setup.
    const started = state as AppState | null;
    if (started && missingStep(started)?.step !== 'folder') initWhatsNew(started.update.current, started.config.ui.lastSeenVersion);
    await activityLogHydration.loadStartupSnapshot();
    const swarm = await run(api.getSwarm());
    if (swarm) paintAgentFilter(swarm);

    // If using web models, wait for the web model to be ready or sign-in needed
    const currentAppState = state as AppState | null;
    if (currentAppState && !isTestEnv && !usesApiProvider(currentAppState.config.ui.chatExecutor)) {
      updateBootSplashStatus('Cargando modelos...');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3500);
        let done = false;
        const check = (currentState: AppState | null) => {
          if (!currentState || done) return;
          const phase = webModelLoadingPhase(currentState);
          if (phase === 'ready' || phase === 'signin' || phase === 'hidden') {
            done = true;
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        };
        const unsubscribe = api.onStateChanged((next) => check(next));
        check(currentAppState);
      });
    }

    updateBootSplashStatus('Todo listo');
    await new Promise(r => setTimeout(r, 260));
  } finally {
    markInitialBootComplete();
    dismissBootSplash();
  }
})();
// Failsafe timer so splash is never stuck if backend init stalls
window.setTimeout(() => dismissBootSplash(), 10000);
