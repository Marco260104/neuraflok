import {
  DEFAULT_HANDOFF_LENGTH,
  DEFAULT_HANDOFF_PROMPT,
} from '../../../contracts/sessions/continuity-brief.js';
import {
  browserExtensionRequired,
  type AppState,
  type Config,
} from '../../../contracts/types.js';
import type { SessionSummary } from '../../../contracts/session.js';
import { $, ago } from '../../shared/dom.js';
import { ui, t } from '../../shared/i18n.js';
import { createChatProviderPicker } from './chat-provider-picker.js';
import { createChatGoalModelPicker } from './chat-goal-model-picker.js';
import { createChatSettingsPatch } from './chat-settings-patch.js';
import { applyChatChecked, applyChatValue } from './chat-settings-fields.js';
import { createChatGoalSettingsView } from './chat-goal-settings-view.js';
import { createChatGoalSettingsEvents } from './chat-goal-settings-events.js';

export interface ChatSettingsRuntime {
  visible: boolean;
  selectedId: string | null;
  sessions: SessionSummary[];
  refreshSessionControls: () => Promise<void>;
  paintContextMeter: typeof import('./context-meter.js').paintContextMeter;
  observedComposerModel: typeof import('./chat-models.js').observedComposerModel;
  applyChatModels: typeof import('./chat-models.js').applyChatModels;
  paintSessions: () => void;
  paintAutomationSwitch: () => void;
}

type Runtime = ChatSettingsRuntime;

// Owns chat preferences, provider presentation, and Goal model controls.
export function createChatSettings(runtime: Runtime) {
  const goalModelPicker = createChatGoalModelPicker();
  const chatSettingsPatch = createChatSettingsPatch(goalModelPicker);

  const applyGoal = createChatGoalSettingsView({ paintAutomationSwitch: runtime.paintAutomationSwitch }, goalModelPicker);

  const wireGoal = createChatGoalSettingsEvents(applyGoal, goalModelPicker);

  const providerPicker = createChatProviderPicker(runtime);

  // This hint names the action and explains that its threshold uses a local estimate rather than provider billing data.
  function applyAutoCompactHint(config: Config): void {
    ui($('autoCompactHint'), 'textContent', () =>
      config.compaction.auto
        ? t(
            'Interrupts an active answer at this many tokens, writes a handoff, and opens a fresh chat.',
          )
        : t(
            'Off — compaction is available only through the current provider session.',
          ),
    );
  }

  // Every control on the settings sheet, and the whole of it. A field that is not here does not save: it keeps what was typed until the next repaint and then quietly reverts. `autoCompactTokens` was missing, which made the one number the automatic trigger fires on the one control in the app that never kept what you typed. Recording and age retention are absent because history is always recorded and does not expire by age.
  const CHAT_INPUTS = [
    'chatBrowser',
    'browserBridgePort',
    'chatExecutor',
    'webProvider',
    'goalIncludeToolCalls',
    'planBackend',
    'finishTool',
    'finishLeadMinutes',
    'workerModel',
    'workerReasoning',
    'autoSelectSkills',
    'backgroundChats',
    'browserOnly',
    'goalBackend',
    'loopBackend',
    'autoCompact',
    'autoCompactTokens',
    'maWorkers',
    'globalMaWorkers',
    'allowUnattributedCalls',
    'strictChatAllowlist',
    'recoverAgentTabs',
    'waitForSubAgents',
    'endSleepingWorkerProcesses',
    'autoContinue',
    'goalProvider',
    'goalBaseUrl',
    'goalCustomModel',
    'goalReasoning',
    'handoffPrompt',
    'handoffLength',
    'goalPrompt',
    'goalObjectivePrompt',
    'goalLoopPrompt',
  ];

  // Writes app state into this panel's controls. Called from the renderer's apply().
  function chatApply(state: AppState, previous?: Config): void {
    const { config, bridge } = state;
    if (runtime.visible && runtime.selectedId)
      void runtime.refreshSessionControls();
    runtime.paintContextMeter(
      runtime.sessions.find((session) => session.id === runtime.selectedId) ??
        null,
      config,
      runtime.observedComposerModel(),
    );
    runtime.applyChatModels(config, previous);

    applyChatChecked(
      $<HTMLInputElement>('autoCompact'),
      config.compaction.auto,
      previous?.compaction.auto,
    );
    applyChatValue(
      $<HTMLInputElement>('autoCompactTokens'),
      String(config.compaction.autoTokens),
      previous?.compaction.autoTokens,
    );
    applyChatValue(
      $<HTMLTextAreaElement>('handoffPrompt'),
      config.compaction.handoffPrompt ?? DEFAULT_HANDOFF_PROMPT,
      previous?.compaction.handoffPrompt,
    );
    applyChatValue(
      $<HTMLSelectElement>('handoffLength'),
      config.compaction.handoffLength ?? DEFAULT_HANDOFF_LENGTH,
      previous?.compaction.handoffLength,
    );
    applyAutoCompactHint(config);
    $<HTMLInputElement>('autoCompactTokens').disabled = !config.compaction.auto;

    applyChatValue(
      $<HTMLInputElement>('maWorkers'),
      String(config.multiAgent.maxWorkers),
      previous?.multiAgent.maxWorkers,
    );
    applyChatValue(
      $<HTMLInputElement>('globalMaWorkers'),
      String(config.multiAgent.globalMaxWorkers ?? 0),
      previous?.multiAgent.globalMaxWorkers,
    );
    applyChatChecked(
      $<HTMLInputElement>('allowUnattributedCalls'),
      config.multiAgent.allowUnattributedCalls,
      previous?.multiAgent.allowUnattributedCalls,
    );
    applyChatChecked(
      $<HTMLInputElement>('strictChatAllowlist'),
      config.multiAgent.strictChatAllowlist === true,
      previous?.multiAgent.strictChatAllowlist,
    );
    $<HTMLInputElement>('allowUnattributedCalls').disabled =
      config.multiAgent.strictChatAllowlist === true;
    applyChatChecked(
      $<HTMLInputElement>('recoverAgentTabs'),
      config.multiAgent.recoverAgentTabs,
      previous?.multiAgent.recoverAgentTabs,
    );
    applyChatChecked(
      $<HTMLInputElement>('waitForSubAgents'),
      config.multiAgent.waitForSubAgents === true,
      previous?.multiAgent.waitForSubAgents,
    );
    applyChatChecked(
      $<HTMLInputElement>('endSleepingWorkerProcesses'),
      config.multiAgent.endSleepingWorkerProcesses === true,
      previous?.multiAgent.endSleepingWorkerProcesses,
    );

    // The worker model fields are saved with the rest of the provider settings.
    applyChatValue(
      $<HTMLSelectElement>('goalBackend'),
      config.goal.backend ?? 'web',
      previous?.goal.backend,
    );
    applyChatValue(
      $<HTMLSelectElement>('loopBackend'),
      config.goal.loopBackend ?? 'web',
      previous?.goal.loopBackend,
    );
    applyGoal(state, previous);
    providerPicker.applyChatExecutor(state, previous);
    providerPicker.applyWebProviders(state, previous);

    // Extension bridge. Connecting is automatic, so this reports rather than asks.
    const browserRequired = browserExtensionRequired(config);
    $<HTMLButtonElement>('bridgeUnpair').disabled = !bridge.paired;
    const secureStorageAvailable = state.secureStorage?.available ?? true;
    ui($('bridgeState'), 'textContent', () =>
      !browserRequired
        ? t(
            'Browser-backed features are off. The integrated browser is not needed right now.',
          )
        : !secureStorageAvailable
          ? (state.secureStorage?.detail ??
            t(
              'Secure credential storage is unavailable, so the extension cannot pair safely.',
            ))
          : !bridge.running && bridge.error
            ? t('Browser bridge could not start: {0}', [bridge.error])
            : !bridge.running
              ? t(
                  'The local browser service is off even though recording or multi-agent mode needs it.',
                )
              : bridge.present
                ? t(
                    'Connected. Listening on 127.0.0.1:{0} · last message {1}.',
                    [bridge.port ?? '?', ago(bridge.lastSeenAt)],
                  )
                : bridge.paired
                  ? t(
                      'The companion is paired, but the integrated browser is not currently connected. {0}',
                      [
                        bridge.lastSeenAt === null
                          ? t('It has not checked in since this app started.')
                          : t('Last seen {0}.', [ago(bridge.lastSeenAt)]),
                      ],
                    )
                  : t(
                      'Listening on 127.0.0.1:{0} · no integrated browser is paired or connected yet.',
                      [bridge.port ?? '?'],
                    ),
    );
    $('bridgeState').classList.toggle(
      'is-warn',
      browserRequired && (!bridge.present || !secureStorageAvailable),
    );

    if (runtime.sessions.length > 0) runtime.paintSessions();
  }

  return { CHAT_INPUTS, chatSettingsPatch, chatApply, wireGoal };
}
