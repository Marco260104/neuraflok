import type { AppState } from '../../../contracts/types.js';
import {
  WEB_PROVIDERS,
  WEB_PROVIDER_IDS,
  isSelectableWebProvider,
  selectableWebProviderOrDefault,
  type WebProviderId,
} from '../../../contracts/web-providers.js';
import { $ } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';

/** Connects provider accounts in the private Chromium profile. */
export function initBrowserSetup(actions: {
  open(provider: WebProviderId, mode: 'connect' | 'activate'): Promise<unknown>;
  showBrowser(): Promise<unknown>;
}): { render(state: AppState): { ready: boolean; choosingLocation: boolean } } {
  const render = (state: AppState): { ready: boolean; choosingLocation: boolean } => {
    const selectedProvider: WebProviderId = selectableWebProviderOrDefault(state.config.ui.webProvider);
    const companionReady = state.bridge.running && state.bridge.paired && state.bridge.integratedExtension?.present === true;

    $('browserLocationStage').hidden = false;

    const selector = $<HTMLSelectElement>('browserWebProvider');
    if (document.activeElement !== selector) selector.value = selectedProvider;
    const group = selector.querySelector<HTMLOptGroupElement>('optgroup');
    if (group) group.label = t('Coming soon');
    for (const label of document.querySelectorAll<HTMLElement>('[data-coming-soon-label]')) {
      label.textContent = t('Coming soon');
    }
    let activeCount = 0;
    for (const id of WEB_PROVIDER_IDS) {
      const sighting = state.bridge.webProviders?.[id] ?? null;
      const selectable = isSelectableWebProvider(id);
      const signedIn = sighting?.signedIn === true;
      const pageOpen = sighting?.open === true;
      if (selectable && signedIn) activeCount += 1;
      const row = document.querySelector<HTMLElement>(`[data-browser-provider="${id}"]`)!;
      row.dataset.state = !selectable
        ? 'coming-soon'
        : signedIn ? 'ready' : pageOpen ? sighting?.signedIn === false ? 'login' : 'checking' : 'off';
      const status = $<HTMLElement>(`browserProviderStatus${id[0]!.toUpperCase()}${id.slice(1)}`);
      status.textContent = !selectable ? t('Coming soon') : signedIn ? t('Session active') : pageOpen && sighting?.signedIn === false
        ? t('Sign in required') : pageOpen ? t('Checking session') : t('Not detected');
      const open = row.querySelector<HTMLButtonElement>('[data-setup-open-provider]')!;
      open.textContent = !selectable ? t('Coming soon') : signedIn ? t('Open') : t('Connect');
      open.dataset.mode = selectable ? signedIn ? 'activate' : 'connect' : 'coming-soon';
      open.disabled = !selectable;
    }

    const selected = state.bridge.webProviders?.[selectedProvider];
    const selectedReady = selected?.signedIn === true;
    const actionLabel = selectedReady ? t('Open') : t('Connect');
    $('browserProviderAction').textContent = `${actionLabel} ${WEB_PROVIDERS[selectedProvider].label}`;
    $<HTMLButtonElement>('openBrowserProvider').disabled = !isSelectableWebProvider(selectedProvider);
    $('openBrowserProvider').setAttribute('aria-label', `${actionLabel} ${WEB_PROVIDERS[selectedProvider].label}`);
    $('browserLocationStage').dataset.activeSessions = String(activeCount);
    $('browserConnectionLost').hidden = companionReady;
    $('browserReviewExtension').textContent = t('Open the internal browser');
    $('browserConnectionLost').querySelector('p')!.textContent = state.bridge.running
      ? t('The private browser starts automatically when you connect a provider.')
      : t('The local browser bridge could not start. Restart NEURAFLOK and try again.');
    $('browserConnectionLost').dataset.tone = state.bridge.running ? 'info' : 'error';
    return { ready: companionReady && selectedReady, choosingLocation: true };
  };

  $('browserReviewExtension').addEventListener('click', () => { void actions.showBrowser(); });
  $('openBrowserProvider').addEventListener('click', () => {
    const value = $<HTMLSelectElement>('browserWebProvider').value;
    if (!isSelectableWebProvider(value)) return;
    const provider = value;
    const signedIn = document.querySelector<HTMLElement>(`[data-browser-provider="${provider}"]`)?.dataset.state === 'ready';
    void actions.open(provider, signedIn ? 'activate' : 'connect');
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-setup-open-provider]')) {
    button.addEventListener('click', () => {
      const provider = button.dataset.setupOpenProvider;
      if (!isSelectableWebProvider(provider)) return;
      void actions.open(provider, button.dataset.mode === 'activate' ? 'activate' : 'connect');
    });
  }
  return { render };
}
