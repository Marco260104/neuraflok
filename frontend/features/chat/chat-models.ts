import type { Config } from '../../../contracts/types.js';
import { isReasoningEffort, type ReasoningEffort } from '../../../contracts/session.js';
import { t } from '../../shared/i18n.js';

type ModelObservation = { model: string; reasoningEffort?: ReasoningEffort; observedAt: number };

let selectionScope: string | null = null;
let selection: ModelObservation | null = null;
let onSelectionChange: (() => void) | undefined;

const effortNames: Record<ReasoningEffort, string> = {
  none: 'Instant',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
  pro: 'Pro'
};

export function chatModelName(model: string, reasoningEffort: string | undefined): string {
  const name = model.trim() || t('Unknown model');
  if (!reasoningEffort) return name;
  const label = isReasoningEffort(reasoningEffort) ? effortNames[reasoningEffort] : reasoningEffort;
  return `${name} · ${t(label)}`;
}

export function applyComposerSessionModel(scope: string | null, observation: ModelObservation | null): void {
  if (selectionScope !== scope) {
    selectionScope = scope;
    selection = observation;
  } else if (observation && (!selection || observation.observedAt >= selection.observedAt)) {
    selection = observation;
  }
  onSelectionChange?.();
}

export function observedComposerModel(): { model: string; reasoningEffort?: ReasoningEffort } | null {
  if (!selection?.model.trim()) return null;
  const reasoningEffort = selection.reasoningEffort && isReasoningEffort(selection.reasoningEffort)
    ? selection.reasoningEffort
    : undefined;
  return { model: selection.model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export function applyChatModels(config: Config, previous?: Config): void {
  const model = document.getElementById('workerModel') as HTMLInputElement | null;
  const reasoning = document.getElementById('workerReasoning') as HTMLSelectElement | null;
  const currentModel = config.multiAgent.defaultModel ?? '';
  const currentReasoning = config.multiAgent.defaultReasoning ?? '';
  if (model && !(document.activeElement === model && previous && model.value !== (previous.multiAgent.defaultModel ?? ''))) {
    model.value = currentModel;
  }
  if (reasoning && !(document.activeElement === reasoning && previous && reasoning.value !== (previous.multiAgent.defaultReasoning ?? ''))) {
    reasoning.value = currentReasoning;
  }
}

export function initChatModels(onPaint?: () => void): void {
  onSelectionChange = onPaint;
}
