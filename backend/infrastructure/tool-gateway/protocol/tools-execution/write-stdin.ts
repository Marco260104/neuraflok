import { z } from 'zod';
import { logInfo } from '../../../settings/logger.js';
import { EXEC_OUTPUT_CEILING_POLICY, unifiedExecManager } from '../../../../domains/workspace/execution/manager.js';
import { execOwnershipFailure, noteExecAttended } from '../../../../domains/workspace/execution/ownership.js';
import { UnifiedExecError, projectExecCommandOutput } from '../../../../domains/workspace/execution/unified-exec.js';
import { DEFAULT_WRITE_STDIN_YIELD_TIME_MS } from '../../../../domains/workspace/execution/unified-exec-constants.js';
import {
  MAX_OUTPUT_TOKENS_DESCRIPTION,
  WRITE_STDIN_CHARS_DESCRIPTION,
  WRITE_STDIN_DESCRIPTION,
  WRITE_STDIN_SESSION_ID_DESCRIPTION,
  WRITE_STDIN_YIELD_TIME_DESCRIPTION
} from '../../../../domains/workspace/execution/tool-specs.js';
import { currentCall, currentCaller, noteExec } from '../call-context.js';
import { awaitFreshCallOrigin } from '../../../../domains/sessions/history/recorder.js';
import { toolDeclaration } from '../declaration-cache.js';
import { fail, failIdentity, IDENTITY_EVIDENCE_MS, type SurfaceRegistrar } from '../kernel.js';
import { execPrincipal, int32Number, unifiedExecOutputSchema, unsignedIntegerNumber } from './shared.js';

export function registerWriteStdinTool(reg: SurfaceRegistrar): void {
  reg.register(
    'write_stdin',
    toolDeclaration('write_stdin', () => ({
      description: WRITE_STDIN_DESCRIPTION,
      inputSchema: z
        .object({
          session_id: int32Number.describe(WRITE_STDIN_SESSION_ID_DESCRIPTION),
          chars: z.string().optional().describe(WRITE_STDIN_CHARS_DESCRIPTION),
          yield_time_ms: unsignedIntegerNumber.optional().describe(WRITE_STDIN_YIELD_TIME_DESCRIPTION),
          max_output_tokens: unsignedIntegerNumber.optional().describe(MAX_OUTPUT_TOKENS_DESCRIPTION)
        })
        .strict(),
      outputSchema: unifiedExecOutputSchema
    })),
    async (input) =>
      reg.guarded('command', 'write_stdin', async () => {
        // The ownership registry decides both admission and the reason for refusal. A request-scoped caller can continue a process it opened before proof. Another request must wait for exact correlation; a numeric process id is not custody.
        let asking = execPrincipal();
        let denied = execOwnershipFailure(input.session_id, asking);
        if (denied === 'unidentified') {
          const caller = currentCaller();
          if (caller.requestId) {
            // A later turn in the same chat can reach Core before the page reports this request-id mate. Wait only for that exact correlation, then re-run the same ownership check; the numeric session id never becomes authority by itself.
            await awaitFreshCallOrigin(
              'write_stdin',
              currentCall()?.startedAt ?? Date.now(),
              IDENTITY_EVIDENCE_MS,
              { exact: true, requestId: caller.requestId }
            );
            asking = execPrincipal();
            denied = execOwnershipFailure(input.session_id, asking);
          }
        }
        if (denied) {
          const reason = {
            unavailable: 'EXEC_SESSION_UNAVAILABLE: This process id is not available to this call in the running app. Check the original exec_command response and earlier results for its exit/output before deciding what remains; do not rerun the command solely because its id is unavailable.',
            anonymous: 'EXEC_SESSION_ANONYMOUS: This process was launched without proven chat identity. An identified chat cannot adopt it. Check the original command and its saved output; retrying from this identified chat cannot change its ownership.',
            unidentified: 'EXEC_CALLER_UNIDENTIFIED: The current request has not been proven to own this process, so it cannot access it yet. After exact identity recovers, retry this same session_id once; do not launch a replacement command.',
            'different-owner': 'EXEC_SESSION_OWNER_MISMATCH: This process belongs to a different local session. Only its owning session can poll it or send input; use a process id returned to this session.'
          }[denied];
          const message = `write_stdin failed for session ${input.session_id}: ${reason} No input was sent and no output was read. This refusal concerns this process id, not Read-only mode or permission to edit files or launch other authorized work.`;
          return denied === 'unidentified' ? failIdentity(message) : fail(message);
        }
        // Both sides of the wait. An empty poll blocks for seconds by design, and a caller sitting in one is attending its session rather than neglecting it.
        noteExecAttended(input.session_id);
        try {
          const output = await unifiedExecManager.writeStdin({
            processId: input.session_id,
            input: input.chars ?? '',
            yieldTimeMs: input.yield_time_ms ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
            maxOutputTokens: undefined,
            truncationPolicy: EXEC_OUTPUT_CEILING_POLICY
          });
          noteExecAttended(input.session_id);
          noteExec({
            ...(output.processId === null ? {} : { id: String(output.processId) }),
            running: output.processId !== null,
            exitCode: output.exitCode,
            timedOut: false,
            benignExit: output.benignExit,
            durationMs: output.wallTimeMs
          });
          logInfo(`tool write_stdin ${input.session_id} (${(input.chars ?? '').length} chars)`);
          const projection = projectExecCommandOutput(output);
          return {
            content: [{ type: 'text' as const, text: projection.text }],
            structuredContent: projection.structured
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const retry =
            error instanceof UnifiedExecError && error.kind === 'write_to_stdin'
              ? ` Retry this same session_id (${input.session_id}); do not replace it with a new command.`
              : '';
          return fail(`write_stdin failed: ${message}${retry}`);
        }
      })
  );
}
