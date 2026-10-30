import { DEFAULT_GOAL_SYSTEM_PROMPT, DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT, DEFAULT_GOAL_LOOP_SYSTEM_PROMPT } from '../../../contracts/automation/goal-prompts.js';
import { DEFAULT_HANDOFF_LENGTH, DEFAULT_HANDOFF_PROMPT, HANDOFF_LENGTHS, type HandoffLength } from '../../../contracts/sessions/continuity-brief.js';
import type { Config } from '../../../contracts/types.js';
import { $ } from '../../shared/dom.js';
import type { ChatGoalModelPicker } from './chat-goal-model-picker.js';

function urgentThreshold(threshold: number): number {
  return Math.min(4_000_000, Math.max(10_000, Math.round((threshold * 4) / 3)));
}

export function createChatSettingsPatch(modelPicker: ChatGoalModelPicker): (current: Config) => {
  sessions: Config['sessions'];
  compaction: Config['compaction'];
  multiAgent: Config['multiAgent'];
  providers: Config['providers'];
  goal: Config['goal'];
  providerTools: Config['providerTools'];
} {
  function boundedNumber(id: string, fallback: number, min: number, max: number): number {
    const parsed = Number($<HTMLInputElement>(id).value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  return function chatSettingsPatch(current: Config) {
    const threshold = boundedNumber('autoCompactTokens', current.compaction.autoTokens, 10_000, 4_000_000);
    const providerKind = $<HTMLSelectElement>('goalProvider').value;
    return {
      sessions: {
        record: true,
        retainDays: 0,
        advisoryTokens: threshold,
        limitTokens: urgentThreshold(threshold),
      },
      compaction: {
        auto: $<HTMLInputElement>('autoCompact').checked,
        autoTokens: threshold,
        handoffPrompt: $<HTMLTextAreaElement>('handoffPrompt').value.trim() || DEFAULT_HANDOFF_PROMPT,
        handoffLength: (HANDOFF_LENGTHS as readonly string[]).includes($<HTMLSelectElement>('handoffLength').value)
          ? ($<HTMLSelectElement>('handoffLength').value as HandoffLength)
          : DEFAULT_HANDOFF_LENGTH,
      },
      multiAgent: {
        defaultModel: $<HTMLInputElement>('workerModel').value,
        defaultReasoning: $<HTMLSelectElement>('workerReasoning').value as Config['multiAgent']['defaultReasoning'],
        enabled: $<HTMLInputElement>('homeMaEnabled').checked,
        maxWorkers: boundedNumber('maWorkers', current.multiAgent.maxWorkers, 1, 8),
        globalMaxWorkers: boundedNumber('globalMaWorkers', current.multiAgent.globalMaxWorkers ?? 0, 0, 64),
        allowUnattributedCalls: $<HTMLInputElement>('allowUnattributedCalls').checked,
        strictChatAllowlist: $<HTMLInputElement>('strictChatAllowlist').checked,
        recoverAgentTabs: $<HTMLInputElement>('recoverAgentTabs').checked,
        waitForSubAgents: $<HTMLInputElement>('waitForSubAgents').checked,
        endSleepingWorkerProcesses: $<HTMLInputElement>('endSleepingWorkerProcesses').checked,
      },
      providers: {
        api: providerKind === 'custom'
          ? {
              kind: 'custom',
              baseUrl: $<HTMLInputElement>('goalBaseUrl').value,
              protocol: $<HTMLSelectElement>('goalCustomProtocol').value as Config['providers']['api']['protocol'],
              name: $<HTMLInputElement>('goalCustomName').value.trim(),
              chatPath: $<HTMLInputElement>('goalCustomChatPath').value.trim() || 'chat/completions',
              modelsPath: $<HTMLInputElement>('goalCustomModelsPath').value.trim(),
              authHeader: $<HTMLInputElement>('goalCustomAuthHeader').value.trim(),
              authPrefix: $<HTMLInputElement>('goalCustomAuthPrefix').value.trim(),
            }
          : {
              kind: (providerKind || current.providers.api.kind || 'openrouter') as Config['providers']['api']['kind'],
              baseUrl: $<HTMLInputElement>('goalBaseUrl').value,
            },
      },
      goal: {
        enabled: current.goal.enabled,
        mode: current.goal.mode,
        includeToolCalls: $<HTMLInputElement>('goalIncludeToolCalls').checked,
        backend: $<HTMLSelectElement>('goalBackend').value as Config['goal']['backend'],
        loopBackend: $<HTMLSelectElement>('loopBackend').value as Config['goal']['loopBackend'],
        model: providerKind === 'custom'
          ? $<HTMLInputElement>('goalCustomModel').value.trim() || current.goal.model
          : modelPicker.model || current.goal.model,
        reasoning: $<HTMLSelectElement>('goalReasoning').value as Config['goal']['reasoning'],
        prompt: $<HTMLTextAreaElement>('goalPrompt').value.trim() || DEFAULT_GOAL_SYSTEM_PROMPT,
        objectivePrompt: $<HTMLTextAreaElement>('goalObjectivePrompt').value.trim() || DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT,
        loopPrompt: $<HTMLTextAreaElement>('goalLoopPrompt').value.trim() || DEFAULT_GOAL_LOOP_SYSTEM_PROMPT,
      },
      providerTools: current.providerTools ?? { instructions: '' },
    };
  };
}
