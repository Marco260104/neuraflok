import type { AgentsToolInput, AgentsToolInputFor } from '../schema.js';
import type { ToolResult } from '../../tool-contracts.js';
import { finish } from './finish.js';
import { message } from './message.js';
import { spawn } from './spawn.js';
import { status } from './status.js';

export function executeAgentsAction(input: AgentsToolInput, startedAt: number): Promise<ToolResult> {
  if (input.action === 'spawn') return spawn(input as AgentsToolInputFor<'spawn'>, startedAt);
  if (input.action === 'message') return message(input as AgentsToolInputFor<'message'>, startedAt);
  if (input.action === 'finish') return finish(input as AgentsToolInputFor<'finish'>, startedAt);
  return status(input as AgentsToolInputFor<'status'>, startedAt);
}
