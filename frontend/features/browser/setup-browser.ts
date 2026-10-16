import type { AppState } from '../../../contracts/types.js';
import { isWebProviderId, WEB_PROVIDERS, WEB_PROVIDER_IDS, type WebProviderId } from '../../../contracts/web-providers.js';
import { $ } from '../../shared/dom.js';
import { t } from '../../shared/i18n.js';

/** Connects provider accounts in the private Chromium profile. */
export function initBrowserSetup(actions: {
  open(provider: WebProviderId, mode: 'connect' | 'activate'): Promise<unknown>;
  showBrowser(): Promise<unknown>;
}): { render(state: AppState): { ready: boolean; choosingLocation: boolean } } {
  const render = (state: AppState): { ready: boolean; choosingLocation: boolean } => {
    const selectedProvider: WebProviderId = isWebProviderId(state.config.ui.webProvider) ? state.config.ui.webProvider : 'deepseek';
    const companionReady = state.bridge.running && state.bridge.paired && state.bridge.integratedExtension?.present === true;

    $('browserLocationStage').hidden = false;

    const selector = $<HTMLSelectElement>('browserWebProvider');
    if (document.activeElement !== selector) selector.value = selectedProvider;
    let activeCount = 0;
    for (const id of WEB_PROVIDER_IDS) {
      const sighting = state.bridge.webProviders?.[id] ?? null;
      const signedIn = sighting?.signedIn === true;
      const pageOpen = sighting?.open === true;
      if (signedIn) activeCount += 1;
      const row = document.querySelector<HTMLElement>(`[data-browser-provider="${id}"]`)!;
      row.dataset.state = signedIn ? 'ready' : pageOpen ? sighting?.signedIn === false ? 'login' : 'checking' : 'off';
      const status = $<HTMLElement>(`browserProviderStatus${id[0]!.toUpperCase()}${id.slice(1)}`);
      status.textContent = signedIn ? t('Session active') : pageOpen && sighting?.signedIn === false
        ? t('Sign in required') : pageOpen ? t('Checking session') : t('Not detected');
      const open = row.querySelector<HTMLButtonElement>('[data-setup-open-provider]')!;
      open.textContent = signedIn ? t('Open') : t('Connect');
      open.dataset.mode = signedIn ? 'activate' : 'connect';
    }

    const selected = state.bridge.webProviders?.[selectedProvider];
    const selectedReady = selected?.signedIn === true;
    const actionLabel = selectedReady ? t('Open') : t('Connect');
    $('browserProviderAction').textContent = `${actionLabel} ${WEB_PROVIDERS[selectedProvider].label}`;
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
    const provider = isWebProviderId(value) ? value : 'deepseek';
    const signedIn = document.querySelector<HTMLElement>(`[data-browser-provider="${provider}"]`)?.dataset.state === 'ready';
    void actions.open(provider, signedIn ? 'activate' : 'connect');
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-setup-open-provider]')) {
    button.addEventListener('click', () => {
      const provider = button.dataset.setupOpenProvider;
      if (!isWebProviderId(provider)) return;
      void actions.open(provider, button.dataset.mode === 'activate' ? 'activate' : 'connect');
    });
  }
  return { render };
}
