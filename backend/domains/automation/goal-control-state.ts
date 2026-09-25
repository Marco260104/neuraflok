import { resetGoalControlWritesForTests } from './goal-control-writes.js';
import { resetGoalObjectivesForTests } from './goal-objectives.js';
import { resetGoalSwitchesForTests } from './goal-switches.js';

export function resetGoalControlStateForTests(): void {
  resetGoalObjectivesForTests();
  resetGoalSwitchesForTests();
  resetGoalControlWritesForTests();
}
