import { OFFLINE_GOAL_CONTINUATIONS, OFFLINE_GOAL_MARKER_INSTRUCTION } from './offline-goal-catalog.js';

export type OfflineGoalDecision =
  | { action: 'stop' }
  | { action: 'continue'; reply: string }
  | { action: 'invalid'; error: 'goal_marker_missing' };

const MARKER_ACTIONS = new Map<string, 'stop' | 'continue'>([
  ['[[NEURAFLOK_GOAL:COMPLETE]]', 'stop'],
  ['[[NEURAFLOK_GOAL:CONTINUE]]', 'continue'],
  ['[[NEURAL_JAM_GOAL:COMPLETE]]', 'stop'],
  ['[[NEURAL_JAM_GOAL:CONTINUE]]', 'continue']
]);

function lastMarkerLine(text: string): string | undefined {
  return text.trim().split(/\r?\n/).at(-1)?.trim();
}

function catalogIndex(slot: number): number {
  return Number.isFinite(slot) ? Math.abs(Math.trunc(slot)) % OFFLINE_GOAL_CONTINUATIONS.length : 0;
}

export function resolveOfflineGoalDecision(final: string, firstSlot: number, secondSlot = firstSlot + 1): OfflineGoalDecision {
  const action = MARKER_ACTIONS.get(lastMarkerLine(final) ?? '');
  if (action === 'stop') return { action };
  if (action !== 'continue') return { action: 'invalid', error: 'goal_marker_missing' };

  const first = catalogIndex(firstSlot);
  let second = catalogIndex(secondSlot);
  if (second === first) second = (first + 1) % OFFLINE_GOAL_CONTINUATIONS.length;
  const reply = `${OFFLINE_GOAL_CONTINUATIONS[first]} ${OFFLINE_GOAL_CONTINUATIONS[second]}${OFFLINE_GOAL_MARKER_INSTRUCTION}`;
  return { action: 'continue', reply };
}
