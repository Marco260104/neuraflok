import type { AppState, Config } from '../../../contracts/types.js';
import type { ChatGoalModelPicker } from './chat-goal-model-picker.js';
import { $ } from '../../shared/dom.js';
import { t, ui } from '../../shared/i18n.js';
import { applyChatChecked, applyChatValue } from './chat-settings-fields.js';

interface Runtime {
  paintAutomationSwitch: () => void;
}

export function createChatGoalSettingsView(runtime: Runtime, goalModelPicker: ChatGoalModelPicker) {
  // Writes the goal block from app state. Called from chatApply, so it never guesses.
  function applyGoal(state: AppState, previous?: Config): void {
    const { config } = state;
    applyChatChecked(
      $<HTMLInputElement>('goalIncludeToolCalls'),
      config.goal.includeToolCalls === true,
      previous?.goal.includeToolCalls,
    );
    const automation = $<HTMLSelectElement>('chatAutomation');
    automation.disabled = false;
    ui(automation, 'title', () => t('Continue this chat automatically'));
    runtime.paintAutomationSwitch();
    const secureStorageAvailable = state.secureStorage?.available ?? true;
    // This picker owns the last known OpenRouter selection. A custom deployment uses its own input and must not replace that selection during an unrelated repaint. A session opened directly on custom starts with the picker's defined default.
    if (config.providers.api.kind !== 'custom') goalModelPicker.setModel(config.goal.model);
    const reasoningSelect = $<HTMLSelectElement>('goalReasoning');
    const reasoning =
      document.activeElement === reasoningSelect &&
      previous &&
      reasoningSelect.value !== previous.goal.reasoning
        ? (reasoningSelect.value as Config['goal']['reasoning'])
        : config.goal.reasoning;
    if (
      previous &&
      JSON.stringify(previous.providers.api) !==
        JSON.stringify(config.providers.api)
    )
      goalModelPicker.invalidate();
    applyChatValue(
      $<HTMLTextAreaElement>('goalPrompt'),
      config.goal.prompt,
      previous?.goal.prompt,
    );
    applyChatValue(
      $<HTMLTextAreaElement>('goalObjectivePrompt'),
      config.goal.objectivePrompt,
      previous?.goal.objectivePrompt,
    );
    applyChatValue(
      $<HTMLTextAreaElement>('goalLoopPrompt'),
      config.goal.loopPrompt,
      previous?.goal.loopPrompt,
    );
    // Provider credentials remain in the OS-backed main-process secret store.
    const customProvider = config.providers.api.kind === 'custom';
    const openAiProvider = config.providers.api.kind === 'openai';
    const providerBaseUrl = config.providers.api.baseUrl;
    applyChatValue(
      $<HTMLSelectElement>('goalProvider'),
      config.providers.api.kind,
      previous?.providers.api.kind,
    );
    applyChatValue(
      $<HTMLInputElement>('goalBaseUrl'),
      providerBaseUrl,
      previous?.providers.api.baseUrl,
    );
    applyChatValue($<HTMLInputElement>('goalCustomName'), config.providers.api.name ?? '', previous?.providers.api.name);
    const customProtocol = config.providers.api.protocol ?? 'openai-compatible';
    const anthropicProtocol = customProtocol === 'anthropic-messages';
    applyChatValue($<HTMLSelectElement>('goalCustomProtocol'), customProtocol, previous?.providers.api.protocol);
    applyChatValue($<HTMLInputElement>('goalCustomChatPath'), config.providers.api.chatPath ?? (anthropicProtocol ? 'messages' : 'chat/completions'), previous?.providers.api.chatPath);
    applyChatValue($<HTMLInputElement>('goalCustomModelsPath'), config.providers.api.modelsPath ?? 'models', previous?.providers.api.modelsPath);
    applyChatValue($<HTMLInputElement>('goalCustomAuthHeader'), config.providers.api.authHeader ?? (anthropicProtocol ? 'x-api-key' : 'Authorization'), previous?.providers.api.authHeader);
    applyChatValue($<HTMLInputElement>('goalCustomAuthPrefix'), config.providers.api.authPrefix ?? (anthropicProtocol ? '' : 'Bearer'), previous?.providers.api.authPrefix);
    applyChatValue(
      $<HTMLInputElement>('goalCustomModel'),
      config.goal.model,
      previous?.goal.model,
    );
    $('goalCustomPanel').hidden = !customProvider;
    $('goalPickerRow').hidden = customProvider;
    if (customProvider) $('goalModels').hidden = true;
    $('goalKeyField').hidden = customProvider || openAiProvider;
    $('goalOpenAiKeyField').hidden = customProvider || !openAiProvider;
    $('goalModelName').textContent = config.goal.model;
    const goalKey = $<HTMLInputElement>('goalKey');
    ui(goalKey, 'placeholder', () =>
      state.hasGoalKey ? t('•••••••• stored') : 'sk-or-v1-…',
    );
    goalKey.disabled = !secureStorageAvailable;
    ui($('goalKeyState'), 'textContent', () =>
      !secureStorageAvailable
        ? (state.secureStorage?.detail ??
          t('Secure credential storage is unavailable.'))
        : state.hasGoalKey
          ? t(
              'A key is stored with secure OS credential storage. Type a new one to replace it.',
            )
          : t(
              'Stored with secure OS credential storage. It never leaves this app, and the browser is only ever handed the reply.',
            ),
    );
    $('goalKeyState').classList.toggle('is-warn', !secureStorageAvailable);
    $<HTMLButtonElement>('goalKeyRemove').disabled =
      !state.hasGoalKey || !secureStorageAvailable;
    const openAiModelKey = $<HTMLInputElement>('goalOpenAiKey');
    ui(openAiModelKey, 'placeholder', () =>
      state.hasOpenAiModelKey ? t('•••••••• stored') : 'sk-…',
    );
    openAiModelKey.disabled = !secureStorageAvailable;
    ui($('goalOpenAiKeyState'), 'textContent', () =>
      !secureStorageAvailable
        ? (state.secureStorage?.detail ??
          t('Secure credential storage is unavailable.'))
        : state.hasOpenAiModelKey
          ? t(
              'A key is stored with secure OS credential storage. Type a new one to replace it.',
            )
          : t(
              'Stored securely on this device. It is sent only to OpenAI when you use one of its models.',
            ),
    );
    $('goalOpenAiKeyState').classList.toggle(
      'is-warn',
      !secureStorageAvailable,
    );
    $<HTMLButtonElement>('goalOpenAiKeyRemove').disabled =
      !state.hasOpenAiModelKey || !secureStorageAvailable;
    const goalCustomKey = $<HTMLInputElement>('goalCustomKey');
    ui(goalCustomKey, 'placeholder', () =>
      state.hasCustomProviderKey
        ? t('•••••••• stored')
        : t('leave empty for a keyless local server'),
    );
    goalCustomKey.disabled = !secureStorageAvailable;
    ui($('goalCustomKeyState'), 'textContent', () =>
      !secureStorageAvailable
        ? (state.secureStorage?.detail ??
          t('Secure credential storage is unavailable.'))
        : state.hasCustomProviderKey
          ? t(
              'A key is stored with secure OS credential storage. Type a new one to replace it.',
            )
          : t(
              'Optional. Stored with secure OS credential storage and sent only by the app to your configured API endpoint. The browser receives only the reply.',
            ),
    );
    $('goalCustomKeyState').classList.toggle(
      'is-warn',
      !secureStorageAvailable,
    );
    $<HTMLButtonElement>('goalCustomKeyRemove').disabled =
      !state.hasCustomProviderKey || !secureStorageAvailable;
    const customHeaders = $<HTMLTextAreaElement>('goalCustomHeaders');
    customHeaders.disabled = !secureStorageAvailable;
    ui(customHeaders, 'placeholder', () => state.hasCustomProviderHeaders ? t('•••••••• stored') : '{"X-Custom-Tenant":"team-a"}');
    ui($('goalCustomHeadersState'), 'textContent', () =>
      !secureStorageAvailable
        ? (state.secureStorage?.detail ?? t('Secure credential storage is unavailable.'))
        : state.hasCustomProviderHeaders
          ? t('Additional headers are stored securely. Enter new JSON to replace them.')
          : t('Headers are stored securely and sent only to this configured endpoint.'),
    );
    $<HTMLButtonElement>('goalCustomHeadersSave').disabled = !secureStorageAvailable;
    $<HTMLButtonElement>('goalCustomHeadersRemove').disabled = !state.hasCustomProviderHeaders || !secureStorageAvailable;
    goalModelPicker.paintReasoning(reasoning);
    if (goalModelPicker.hasModels()) goalModelPicker.paint();
  }
  return applyGoal;
}
