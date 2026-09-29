import {
  WEB_PROVIDERS,
  WEB_PROVIDER_IDS,
  isWebProviderId,
  providerForConversationId,
  type WebProviderId,
} from '../../../contracts/web-providers.js';
import { isApiConversationId } from '../../../contracts/chat-protocol.js';
import type { SessionSummary } from '../../../contracts/session.js';
import type { AppState, Config } from '../../../contracts/types.js';
import { $, el } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { providerMark } from '../browser/provider-marks.js';
import { applyChatValue } from './chat-settings-fields.js';

interface Runtime {
  selectedId: string | null;
  sessions: readonly SessionSummary[];
}

export function createChatProviderPicker(runtime: Runtime) {
  function applyWebProviders(state: AppState, previous?: Config): void {
    const configuredProvider = isWebProviderId(state.config.ui.webProvider)
      ? state.config.ui.webProvider
      : 'deepseek';
    const selectedConversation = runtime.selectedId
      ? (runtime.sessions.find((session) => session.id === runtime.selectedId)
          ?.conversationId ?? null)
      : null;
    const boundProvider = selectedConversation
      ? providerForConversationId(selectedConversation)
      : null;
    const provider = boundProvider ?? configuredProvider;
    applyChatValue(
      $<HTMLSelectElement>('webProvider'),
      configuredProvider,
      previous?.ui.webProvider,
    );
    applyChatValue(
      $<HTMLSelectElement>('browserWebProvider'),
      configuredProvider,
      previous?.ui.webProvider,
    );

    const presence = state.bridge.webProviders;
    let activeCount = 0;
    for (const id of WEB_PROVIDER_IDS) {
      const row = presence?.[id] ?? null;
      const signedIn = row?.signedIn === true;
      const open = row?.open === true;
      if (signedIn) activeCount += 1;

      for (const selectId of ['webProvider', 'browserWebProvider']) {
        const select = $<HTMLSelectElement>(selectId);
        const candidate = [...select.options].find((item) => item.value === id);
        if (candidate) candidate.disabled = !signedIn;
      }

      const card = document.querySelector<HTMLElement>(
        `[data-provider-card="${id}"]`,
      );
      if (card) {
        card.dataset.state = signedIn
          ? 'ready'
          : open
            ? row?.signedIn === false
              ? 'login'
              : 'checking'
            : 'off';
        card.dataset.selected = String(provider === id);
        const status = $<HTMLElement>(
          `providerStatus${id[0]!.toUpperCase()}${id.slice(1)}`,
        );
        status.textContent = signedIn
          ? t('Session active')
          : open
            ? row?.signedIn === false
              ? t('Sign in required')
              : t('Checking session')
            : t('Not detected');
        const use = card.querySelector<HTMLButtonElement>(
          '[data-select-provider]',
        );
        if (use) use.disabled = !signedIn;
        const openButton = card.querySelector<HTMLButtonElement>(
          '[data-open-provider]',
        );
        if (openButton) {
          openButton.textContent = signedIn ? t('Open') : t('Connect');
          openButton.dataset.mode = signedIn ? 'activate' : 'connect';
        }
        const disconnect = card.querySelector<HTMLButtonElement>(
          '[data-disconnect-provider]',
        );
        if (disconnect) disconnect.hidden = !signedIn;
      }
    }
    const label = WEB_PROVIDERS[provider].label;
    const row = presence?.[provider] ?? null;
    const signedIn = row?.signedIn === true;
    $('webProviderHint').textContent = signedIn
      ? t('{0} is ready in the browser · {1} sessions active.', [
          label,
          activeCount,
        ])
      : t(
          'Open {0} and sign in in the same browser to use it here · {1} sessions active.',
          [label, activeCount],
        );
    paintChatModelPicker(state, selectedConversation, provider, boundProvider);
  }

  function applyChatExecutor(state: AppState, previous?: Config): void {
    const configuredExecutor = state.config.ui.chatExecutor ?? 'web';
    const selectedConversation = runtime.selectedId
      ? (runtime.sessions.find((session) => session.id === runtime.selectedId)
          ?.conversationId ?? null)
      : null;
    const executor = selectedConversation
      ? isApiConversationId(selectedConversation)
        ? 'api'
        : 'web'
      : configuredExecutor;
    applyChatValue(
      $<HTMLSelectElement>('chatExecutor'),
      configuredExecutor,
      previous?.ui.chatExecutor,
    );
    $('chatModelPicker').dataset.executor = executor;
  }

  function apiProviderName(kind: Config['providers']['api']['kind']): string {
    return kind === 'openai'
      ? 'OpenAI'
      : kind === 'openrouter'
        ? 'OpenRouter'
        : 'Custom endpoint';
  }

  function configuredApiProvider(state: AppState): Config['providers']['api'] {
    return state.config.providers.api;
  }

  function apiModelIsReady(
    state: AppState,
    provider = configuredApiProvider(state),
    modelValue = state.config.goal?.model ?? '',
  ): boolean {
    const model = modelValue.trim();
    if (!model) return false;
    if (provider.kind === 'custom') return Boolean(provider.baseUrl.trim());
    return provider.kind === 'openai'
      ? state.hasOpenAiModelKey === true
      : state.hasGoalKey;
  }

  function paintChatModelPicker(
    state: AppState,
    selectedConversation: string | null,
    selectedWebProvider: WebProviderId,
    _boundProvider: WebProviderId | null,
  ): void {
    ui($('chatModelPickerTrigger'), 'aria-label', () => t('Choose model'));
    ui($('webModelsHeading'), 'textContent', () => t('Web models'));
    ui($('webModelsTag'), 'textContent', () => t('Browser session'));
    ui($('apiModelsHeading'), 'textContent', () => t('Your models'));
    ui($('manageModelsLabel'), 'textContent', () => t('Manage models'));
    const executor = selectedConversation
      ? isApiConversationId(selectedConversation)
        ? 'api'
        : 'web'
      : (state.config.ui.chatExecutor ?? 'web');
    const selectedSummary = runtime.selectedId
      ? runtime.sessions.find((session) => session.id === runtime.selectedId)
      : null;
    const savedApiModel =
      executor === 'api' &&
      selectedConversation &&
      selectedSummary?.selectedModel?.conversationId === selectedConversation
        ? selectedSummary.selectedModel
        : null;
    const displayedApiProvider =
      savedApiModel?.apiProvider ?? configuredApiProvider(state);
    const displayedApiModel =
      savedApiModel?.model ?? state.config.goal?.model ?? '';
    const displayedApiReady = apiModelIsReady(
      state,
      displayedApiProvider,
      displayedApiModel,
    );
    const webOptions = $('webModelOptions');
    webOptions.textContent = '';
    for (const id of WEB_PROVIDER_IDS) {
      const presence = state.bridge.webProviders?.[id] ?? null;
      const signedIn = presence?.signedIn === true;
      const isCurrent = executor === 'web' && selectedWebProvider === id;
      const item = el('div', 'model-picker-item');
      const choose = el('button', 'model-picker-choice') as HTMLButtonElement;
      choose.type = 'button';
      choose.dataset.modelPickWeb = id;
      choose.disabled = !signedIn;
      if (isCurrent) choose.dataset.selected = 'true';
      const icon = providerMark(id);
      icon.classList.add('model-picker-provider-mark');
      const text = el('span', 'model-picker-choice-text');
      text.append(el('b', '', `${WEB_PROVIDERS[id].label} Web`));
      const statusText = signedIn
        ? t('Connected')
        : presence?.open && presence.signedIn === false
          ? t('Sign in required')
          : t('Not connected');
      text.append(el('small', '', statusText));
      choose.append(icon, text);
      if (isCurrent)
        choose.append(el('i', 'ico ph ph-check model-picker-check'));
      item.append(choose);
      const action = el('button', 'model-picker-connect') as HTMLButtonElement;
      action.type = 'button';
      action.dataset.modelConnect = id;
      action.dataset.mode = signedIn ? 'activate' : 'connect';
      action.textContent = signedIn ? t('Open') : t('Connect');
      action.disabled = false;
      item.append(action);
      if (signedIn) {
        const disconnect = el(
          'button',
          'model-picker-disconnect',
        ) as HTMLButtonElement;
        disconnect.type = 'button';
        disconnect.dataset.modelDisconnect = id;
        disconnect.textContent = t('Disconnect');
        disconnect.title = t('Remove the saved {0} session from NEURAFLOK?', [
          WEB_PROVIDERS[id].label,
        ]);
        item.append(disconnect);
      }
      webOptions.append(item);
    }

    const provider =
      executor === 'api' ? displayedApiProvider : configuredApiProvider(state);
    const model = (
      executor === 'api' ? displayedApiModel : (state.config.goal?.model ?? '')
    ).trim();
    const ready =
      executor === 'api' ? displayedApiReady : apiModelIsReady(state);
    const currentApi = executor === 'api';
    const apiOptions = $('apiModelOptions');
    apiOptions.textContent = '';
    const item = el('div', 'model-picker-item');
    const choose = el('button', 'model-picker-choice') as HTMLButtonElement;
    choose.type = 'button';
    choose.dataset.modelPickApi = 'true';
    choose.disabled = !ready;
    if (currentApi) choose.dataset.selected = 'true';
    const icon = el('i', 'ico ph ph-circuitry');
    icon.setAttribute('aria-hidden', 'true');
    const text = el('span', 'model-picker-choice-text');
    text.append(el('b', '', model || t('Choose a model')));
    text.append(
      el(
        'small',
        '',
        ready ? apiProviderName(provider.kind) : t('Set up in Manage models'),
      ),
    );
    choose.append(icon, text);
    if (currentApi)
      choose.append(el('i', 'ico ph ph-check model-picker-check'));
    item.append(choose);
    apiOptions.append(item);

    const currentName =
      executor === 'api'
        ? model || t('Choose a model')
        : `${WEB_PROVIDERS[selectedWebProvider].label} Web`;
    $('chatModelPickerName').textContent = currentName;
    const currentMark =
      executor === 'api'
        ? el('i', 'ico ph ph-circuitry')
        : providerMark(selectedWebProvider);
    $('chatModelPickerMark').replaceChildren(currentMark);
    ui($('chatModelPickerTrigger'), 'title', () =>
      ready && executor === 'api'
        ? `${apiProviderName(provider.kind)} · ${model}`
        : currentName,
    );
    $('chatModelPickerDot').dataset.state =
      executor === 'api'
        ? ready
          ? 'connected'
          : 'offline'
        : state.bridge.webProviders?.[selectedWebProvider]?.signedIn === true
          ? 'connected'
          : 'offline';
    $('chatModelPicker').dataset.locked = 'false';
  }

  return { applyWebProviders, applyChatExecutor };
}
