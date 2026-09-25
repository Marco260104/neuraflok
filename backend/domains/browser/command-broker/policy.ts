import type { CommandStep } from './model.js';
import { WORKER_SILENCE_MS } from '../../automation/agents.js';

export const COMMAND_DEADLINE_MS = 90_000;
export const WORKER_REDEEM_MS = 45_000;
export const WORKER_BOOTSTRAP_LIMIT_MS = 120_000;
export const REVIVAL_DEADLINE_MS = 3 * 60_000;
export const REVIVAL_ACTIVITY_MS = REVIVAL_DEADLINE_MS + WORKER_SILENCE_MS;
export const COMMAND_TTL_MS = 30 * 60_000;
export const MAX_COMMANDS = 20;
export const MAX_COMMAND_RECEIPTS = 64;
export const COMMANDS_STATE = 'bridge-commands';
export const STOP_COMMAND_TIMEOUT_MS = 120_000;

export const REVIVAL_WAIT_STEPS = new Set<string>(['revival-waiting', 'revival-busy', 'revival-draft', 'revival-editor']);
export const RESUME_STEP_STALL_MS = 3 * 60_000;
export const RESUME_STALL_STEPS: ReadonlySet<CommandStep> = new Set(['composer', 'model', 'composer-after-model']);

export const COMMAND_STEP_TEXT: Record<CommandStep, string> = {
  'revival-waiting': 'its chat was still answering or its message box was not empty',
  'revival-busy': 'its chat was still answering',
  'revival-draft': 'its message box was not empty',
  'revival-editor': 'its page never showed a usable message box',
  composer: 'waiting for the provider message box',
  model: 'choosing the model and reasoning',
  'composer-after-model': 'waiting for the message box after choosing the model',
  inserting: 'putting the task into the message box',
  sending: 'sending the task'
};
