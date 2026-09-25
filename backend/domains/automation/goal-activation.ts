import { goalObjectiveFor } from './goal-objectives.js';
import { goalSwitchFor } from './goal-switches.js';

export function goalArmedFor(conversationId: string): boolean {
  const control = goalSwitchFor(conversationId);
  if (control.own) return control.enabled;
  return control.enabled || goalObjectiveFor(conversationId) !== '';
}
