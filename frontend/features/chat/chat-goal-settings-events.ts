import { MAX_GOAL_SYSTEM_PROMPT_CHARS } from '../../../contracts/automation/goal-settings.js';
import {
  DEFAULT_GOAL_LOOP_SYSTEM_PROMPT,
  DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
  DEFAULT_GOAL_SYSTEM_PROMPT,
} from '../../../contracts/automation/goal-prompts.js';
import { DEFAULT_HANDOFF_PROMPT, MAX_HANDOFF_PROMPT_CHARS } from '../../../contracts/sessions/continuity-brief.js';
import type { AppState, Config } from '../../../contracts/types.js';
import { $, run, toast } from '../../shared/dom.js';
import { ui, t } from '../../shared/i18n.js';
import type { ChatGoalModelPicker } from './chat-goal-model-picker.js';

export function createChatGoalSettingsEvents(applyGoal: (state: AppState, previous?: Config) => void, goalModelPicker: ChatGoalModelPicker) {
  const api = window.api;

  function wireGoal(save: () => Promise<void>): void {
    $<HTMLTextAreaElement>('handoffPrompt').maxLength =
      MAX_HANDOFF_PROMPT_CHARS;
    $('handoffPromptEdit').addEventListener('click', () => {
      const panel = $('handoffPromptPanel');
      panel.hidden = !panel.hidden;
      $('handoffPromptEdit').textContent = panel.hidden
        ? 'Edit prompt'
        : 'Close prompt';
      if (!panel.hidden) $<HTMLTextAreaElement>('handoffPrompt').focus();
    });
    $('handoffPromptReset').addEventListener('click', async () => {
      $<HTMLTextAreaElement>('handoffPrompt').value = DEFAULT_HANDOFF_PROMPT;
      await save();
      toast('Handoff prompt restored to default');
    });
    $<HTMLTextAreaElement>('goalPrompt').maxLength =
      MAX_GOAL_SYSTEM_PROMPT_CHARS;
    $('goalPromptEdit').addEventListener('click', () => {
      const panel = $('goalPromptPanel');
      panel.hidden = !panel.hidden;
      ui($('goalPromptEdit'), 'textContent', () =>
        panel.hidden ? t('Edit prompt') : t('Close prompt'),
      );
      if (!panel.hidden) $<HTMLTextAreaElement>('goalPrompt').focus();
    });
    $('goalPromptReset').addEventListener('click', async () => {
      $<HTMLTextAreaElement>('goalPrompt').value = DEFAULT_GOAL_SYSTEM_PROMPT;
      await save();
      toast(t('Goal prompt (no task) restored to default'));
    });
    $<HTMLTextAreaElement>('goalObjectivePrompt').maxLength =
      MAX_GOAL_SYSTEM_PROMPT_CHARS;
    $('goalObjectivePromptEdit').addEventListener('click', () => {
      const panel = $('goalObjectivePromptPanel');
      panel.hidden = !panel.hidden;
      ui($('goalObjectivePromptEdit'), 'textContent', () =>
        panel.hidden ? t('Edit prompt') : t('Close prompt'),
      );
      if (!panel.hidden) $<HTMLTextAreaElement>('goalObjectivePrompt').focus();
    });
    $('goalObjectivePromptReset').addEventListener('click', async () => {
      $<HTMLTextAreaElement>('goalObjectivePrompt').value =
        DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT;
      await save();
      toast(t('Goal prompt (with a task) restored to default'));
    });
    $<HTMLTextAreaElement>('goalLoopPrompt').maxLength =
      MAX_GOAL_SYSTEM_PROMPT_CHARS;
    $('goalLoopPromptEdit').addEventListener('click', () => {
      const panel = $('goalLoopPromptPanel');
      panel.hidden = !panel.hidden;
      ui($('goalLoopPromptEdit'), 'textContent', () =>
        panel.hidden ? t('Edit prompt') : t('Close prompt'),
      );
      if (!panel.hidden) $<HTMLTextAreaElement>('goalLoopPrompt').focus();
    });
    $('goalLoopPromptReset').addEventListener('click', async () => {
      $<HTMLTextAreaElement>('goalLoopPrompt').value =
        DEFAULT_GOAL_LOOP_SYSTEM_PROMPT;
      await save();
      toast(t('Loop prompt restored to default'));
    });
    goalModelPicker.wire((model) => {
      void save();
      toast(t('Goal model set to {0}', [model]));
    });
    // On blur, like every other key in this app: not saved keystroke by keystroke, and the field is emptied the moment it has been handed over.
    $('goalKey').addEventListener('blur', async () => {
      const input = $<HTMLInputElement>('goalKey');
      const submitted = input.value;
      const key = submitted.trim();
      // Whitespace is not a key. Passing it through trim as an empty string used to invoke the remove-key path and then claim a key was stored.
      if (key === '') return;
      const next = await run(api.setGoalKey(key));
      if (next) {
        goalModelPicker.invalidate();
        // A blur can be followed immediately by refocus + new typing while IPC is in flight. Clear only the exact value that successfully crossed the secret-store boundary.
        if (input.value === submitted) input.value = '';
        applyGoal(next);
        toast(t('OpenRouter key stored'));
      }
    });
    $('goalKeyRemove').addEventListener('click', async () => {
      const next = await run(api.setGoalKey(''));
      if (next) {
        goalModelPicker.invalidate();
        applyGoal(next);
        toast(t('OpenRouter key removed'));
      }
    });
    $('goalOpenAiKey').addEventListener('blur', async () => {
      const input = $<HTMLInputElement>('goalOpenAiKey');
      const submitted = input.value;
      const key = submitted.trim();
      if (key === '') return;
      const next = await run(api.setOpenAiModelKey(key));
      if (next) {
        goalModelPicker.invalidate();
        if (input.value === submitted) input.value = '';
        applyGoal(next);
        toast(t('OpenAI model key stored'));
      }
    });
    $('goalOpenAiKeyRemove').addEventListener('click', async () => {
      const next = await run(api.setOpenAiModelKey(''));
      if (next) {
        goalModelPicker.invalidate();
        applyGoal(next);
        toast(t('OpenAI model key removed'));
      }
    });
    // Same blur-to-save discipline as the OpenRouter key above. Empty submits nothing: a keyless local endpoint is a supported configuration, not a key being removed.
    $('goalCustomKey').addEventListener('blur', async () => {
      const input = $<HTMLInputElement>('goalCustomKey');
      const submitted = input.value;
      const key = submitted.trim();
      if (key === '') return;
      const next = await run(api.setCustomProviderKey(key));
      if (next) {
        if (input.value === submitted) input.value = '';
        applyGoal(next);
        toast(t('Custom provider key stored'));
      }
    });
    $('goalCustomKeyRemove').addEventListener('click', async () => {
      const next = await run(api.setCustomProviderKey(''));
      if (next) {
        applyGoal(next);
        toast(t('Custom provider key removed'));
      }
    });
  }
  return wireGoal;
}
