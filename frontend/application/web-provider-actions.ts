import type { AppApi } from '../../backend/preload/index.js';
import type { AppState } from '../../contracts/types.js';
import { WEB_PROVIDERS, isWebProviderId, type WebProviderId } from '../../contracts/web-providers.js';
import { $, run, toast } from '../shared/dom.js';
import { t } from '../shared/i18n.js';

interface WebProviderActionsDependencies {
  api: AppApi;
  getState: () => AppState | null;
  apply: (state: AppState) => void;
  save: () => Promise<void>;
  showTab: (name: string) => void;
}

export function initWebProviderActions(dependencies: WebProviderActionsDependencies): void {
  const { api, getState, apply, save, showTab } = dependencies;

  function chooseWebProvider(value: string, persist = true): void {
    const provider: WebProviderId = isWebProviderId(value) ? value : 'deepseek';
    const settings = $<HTMLSelectElement>('webProvider');
    const changed = settings.value !== provider;
    settings.value = provider;
    $<HTMLSelectElement>('browserWebProvider').value = provider;
    if (changed && persist) void save();
  }

  async function openWebProvider(value: string, mode?: 'connect' | 'activate'): Promise<void> {
    const provider: WebProviderId = isWebProviderId(value) ? value : 'deepseek';
    chooseWebProvider(provider);
    const activeMode = mode ?? (getState()?.bridge.webProviders?.[provider]?.signedIn === true ? 'activate' : 'connect');
    await run(api.openWebProvider(provider, activeMode));
  }

  $('connectionPopoverDeepseek').addEventListener('click', () => {
    void openWebProvider($<HTMLSelectElement>('webProvider').value);
  });
  $('webModelOptions').addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-model-pick-web], [data-model-connect], [data-model-disconnect]');
    if (!target || target.disabled) return;
    const value = target.dataset.modelPickWeb ?? target.dataset.modelConnect ?? target.dataset.modelDisconnect;
    if (!isWebProviderId(value)) return;
    if (target.dataset.modelDisconnect) {
      if (!window.confirm(t('Remove the saved {0} session from NEURAFLOK?', [WEB_PROVIDERS[value].label]))) return;
      void run(api.disconnectWebProvider(value)).then((next) => {
        if (!next) return;
        apply(next);
        toast(t('{0} disconnected from NEURAFLOK.', [WEB_PROVIDERS[value].label]));
        $<HTMLDetailsElement>('chatModelPicker').open = false;
      });
      return;
    }
    if (target.dataset.modelConnect) {
      void openWebProvider(value, target.dataset.mode === 'activate' ? 'activate' : 'connect');
      return;
    }
    const executorSetting = $<HTMLSelectElement>('chatExecutor');
    const executorChanged = executorSetting.value !== 'web';
    chooseWebProvider(value, true);
    if (executorChanged) {
      executorSetting.value = 'web';
      executorSetting.dispatchEvent(new Event('change', { bubbles: true }));
    }
    void save();
    $<HTMLDetailsElement>('chatModelPicker').open = false;
  });
  $('apiModelOptions').addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-model-pick-api]');
    if (!target || target.disabled) return;
    const setting = $<HTMLSelectElement>('chatExecutor');
    setting.value = 'api';
    setting.dispatchEvent(new Event('change', { bubbles: true }));
    void save();
    $<HTMLDetailsElement>('chatModelPicker').open = false;
  });
  $('manageModelsOpen').addEventListener('click', () => {
    showTab('settings');
    window.setTimeout(() => {
      const provider = $<HTMLSelectElement>('goalProvider');
      provider.scrollIntoView({ block: 'center' });
      provider.focus();
    }, 0);
    $<HTMLDetailsElement>('chatModelPicker').open = false;
  });
  $('browserWebProvider').addEventListener('change', () => chooseWebProvider($<HTMLSelectElement>('browserWebProvider').value));
  $('webProvider').addEventListener('change', () => {
    chooseWebProvider($<HTMLSelectElement>('webProvider').value, false);
    void save();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-select-provider]')) {
    button.addEventListener('click', () => chooseWebProvider(button.dataset.selectProvider || 'deepseek'));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-open-provider]')) {
    button.addEventListener('click', () => void openWebProvider(button.dataset.openProvider || 'deepseek',
      button.dataset.mode === 'activate' ? 'activate' : 'connect'));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-disconnect-provider]')) {
    button.addEventListener('click', async () => {
      const value = button.dataset.disconnectProvider;
      if (!isWebProviderId(value)) return;
      if (!window.confirm(t('Remove the saved {0} session from NEURAFLOK?', [WEB_PROVIDERS[value].label]))) return;
      const next = await run(api.disconnectWebProvider(value));
      if (next) {
        apply(next);
        toast(t('{0} disconnected from NEURAFLOK.', [WEB_PROVIDERS[value].label]));
      }
    });
  }
}
