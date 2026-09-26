import { z } from 'zod';
import { currentCall, currentCaller } from '../call-context.js';
import { executionPrincipal } from '../../../../domains/workspace/execution/ownership.js';
import { getConfig } from '../../../settings/config.js';

export const int32Number = z
  .number()
  .refine((value) => Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647);
export const unsignedIntegerNumber = z.number().refine((value) => Number.isSafeInteger(value) && value >= 0);
export const unifiedExecOutputSchema = z
  .object({
    chunk_id: z.string().optional().describe('Output chunk identifier.'),
    wall_time_seconds: z.number().describe('Seconds spent waiting for output.'),
    exit_code: z.number().optional().describe('Process exit code when the command finished during this call.'),
    session_id: z.number().optional().describe('Session ID while running.'),
    completed_session_id: z.number().optional().describe('Use as write_stdin session_id to reread completed output.'),
    benign_exit: z.boolean().optional().describe('Non-zero exit is an expected result, not a failure.'),
    output_replayed: z.boolean().optional().describe('Retained output; command was not run again.'),
    original_token_count: z.number().optional().describe('Approximate token count before truncation.'),
    output: z.string().describe('Command output text, possibly truncated.'),
    supplemental_context: z.string().optional().describe('App context, not process output.')
  })
  .strict();

export function execPrincipal(): string | null {
  const caller = currentCaller();
  return executionPrincipal(
    caller.requestId,
    caller.sessionId ?? null,
    currentCall()?.allowUnattributed ?? getConfig().multiAgent.allowUnattributedCalls
  );
}
