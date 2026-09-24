import type { AgentState } from '../session.js';

export type WorkerOverviewHealth = 'healthy' | 'degraded' | 'unknown';
export type WorkerOverviewActivity = 'starting' | 'working' | 'sleeping' | 'done';

export interface WorkerOverviewHealthInput {
  state: AgentState | null;
  exactIdentity: boolean;
  working: boolean;
  activeTurn: boolean;
}

export interface WorkerOverviewHealthSnapshot {
  health: WorkerOverviewHealth;
  activity: WorkerOverviewActivity;
}

function activityOf(input: WorkerOverviewHealthInput): WorkerOverviewActivity {
  switch (input.state) {
    case 'finished':
    case 'failed': return 'done';
    case 'sleeping': return 'sleeping';
    default:
      if (input.working || input.activeTurn) return 'working';
      return input.state === 'invited' || input.state === 'waking' ? 'starting' : 'working';
  }
}

export function evaluateWorkerOverviewHealth(
  input: WorkerOverviewHealthInput
): WorkerOverviewHealthSnapshot {
  const activeWork = input.working || input.activeTurn;
  const health: WorkerOverviewHealth = !input.exactIdentity
    ? 'unknown'
    : input.state === 'failed' || (input.state === 'detached' && !activeWork)
      ? 'degraded'
      : input.state === null && !activeWork
        ? 'unknown'
        : 'healthy';
  return { health, activity: activityOf(input) };
}
