import { goalModelEfforts, type GoalModel } from '../../../contracts/automation/goal-model-reasoning.js';
import type { GoalReasoning } from '../../../contracts/types.js';
import { t, ui } from '../../shared/i18n.js';

const labels: Record<GoalReasoning, string> = {
  default: 'Default', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max'
};

export interface GoalReasoningOption {
  value: GoalReasoning;
  disabled: boolean;
}

export interface GoalReasoningSelection {
  options: GoalReasoningOption[];
  selected: GoalReasoning;
}

export function buildGoalReasoningSelection(
  model: GoalModel | undefined,
  custom: boolean,
  selected: GoalReasoning,
  changingModel = false
): GoalReasoningSelection {
  const efforts = goalModelEfforts(model, custom);
  const supported = new Set<GoalReasoning>(['default', ...efforts]);
  const keepSavedChoice = !supported.has(selected) && !changingModel;
  const selectedValue = !supported.has(selected) && changingModel ? 'default' : selected;
  const values: GoalReasoning[] = ['default', ...efforts];
  if (keepSavedChoice) values.push(selected);
  const enabledEfforts = new Set<GoalReasoning>(efforts);
  return {
    options: values.map(value => ({ value, disabled: value !== 'default' && !enabledEfforts.has(value) })),
    selected: selectedValue
  };
}

export function renderGoalReasoning(
  select: HTMLSelectElement,
  model: GoalModel | undefined,
  custom: boolean,
  selected: GoalReasoning,
  changingModel = false
): void {
  const selection = buildGoalReasoningSelection(model, custom, selected, changingModel);
  const currentOptions = [...select.options].map(option => ({ value: option.value, disabled: option.disabled }));
  if (JSON.stringify(currentOptions) !== JSON.stringify(selection.options)) {
    select.replaceChildren(...selection.options.map(({ value, disabled }) => {
      const option = document.createElement('option');
      option.value = value;
      option.disabled = disabled;
      return option;
    }));
  }
  for (const option of select.options) {
    const value = option.value as GoalReasoning;
    ui(option, 'textContent', () => option.disabled ? t('{0} (saved; unavailable)', [t(labels[value])])
      : value === 'default' && model?.reasoning?.defaultEffort ? t('Default ({0})', [t(labels[model.reasoning.defaultEffort])]) : t(labels[value]));
  }
  select.value = selection.selected;
}
