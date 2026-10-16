import type { AgentsToolInputFor } from '../schema.js';
import type { ToolResult } from '../../tool-contracts.js';
import { fail } from '../../kernel.js';
import { PRIME_ID, requestWorkerRevivals, stageMessages, stagePrimeMessage } from '../../../../../domains/automation/agents.js';
import { recordAgentMessage } from '../../../../../domains/sessions/history/recorder.js';
import { currentCall } from '../../call-context.js';
import { acceptAgentMutation, callerNow, measureSleepingWorkers } from '../runtime.js';

export async function message(input: AgentsToolInputFor<'message'>, startedAt: number): Promise<ToolResult> {
          if (input.target_run_id) {
            if (input.messages?.length) {
              return fail('agents action=message with target_run_id takes one text message, not messages[].');
            }
            if (input.to && input.to !== PRIME_ID) {
              return fail('agents action=message with target_run_id can address only the destination prime.');
            }
            if (!input.text) {
              return fail('agents action=message with target_run_id requires text.');
            }
            const caller = await callerNow(startedAt, { runId: input.run_id, member: true });
            const staged = stagePrimeMessage(caller, input.target_run_id, input.text);
            await acceptAgentMutation(staged,
              'The prime message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request.',
              'TARGET_RUN_UNAVAILABLE: the destination prime family changed before acceptance. Nothing was queued.');
            if (currentCall()) currentCall()!.caller.runId = staged.sourceRunId;
            await recordAgentMessage(staged.message, 'sent', caller.conversationId);
            return {
              content: [{
                type: 'text' as const,
                text:
                  `Queued for prime family ${staged.targetRunId}. The recipient can reply with target_run_id=${staged.sourceRunId}.`
              }],
              structuredContent: {
                action: 'message',
                run_id: staged.sourceRunId,
                target_run_id: staged.targetRunId,
                queued: [{ to: PRIME_ID }]
              }
            };
          }

          // Two spellings of one operation. A single message is the common case and stays a pair of scalars; `messages` is the same thing in bulk. Both in one call is a request whose intended order nobody can read, so it is refused rather than guessed at.
          const batch = input.messages ?? [];
          const single = input.to && input.text ? [{ to: input.to, text: input.text }] : [];
          if (batch.length > 0 && single.length > 0) {
            return fail('agents action=message takes either to+text or messages, not both.');
          }
          const items = batch.length > 0 ? batch : single;
          if (items.length === 0) return fail('agents action=message requires to and text, or a messages array.');
          // Before any slot is reserved: a sleeping worker whose chat has since crossed the context ceiling is not revivable, and this is the call that would otherwise wake it.
          const caller = await callerNow(startedAt, { runId: input.run_id, member: true });
          await measureSleepingWorkers(caller);
          // One call, one identity resolution, one all-or-nothing delivery: a prime redirecting its whole run cannot end up with two of its three messages sent.
          const staged = stageMessages(caller, items);
          await acceptAgentMutation(staged,
            'The agent message could not cross its durable acceptance barrier. Nothing was queued; retry the same message request.');
          const sent = staged.messages;
          const woken = staged.waking;
          // Reopening a sleeping worker's chat is a browser side effect, so it happens only after the broker revision that reserved its slot is durable — exactly as a spawn's tabs do. Nothing has been typed into that chat yet at this point.
          const runId = staged.runId;
          if (currentCall()) currentCall()!.caller.runId = runId;
          if (woken.length > 0 && runId) requestWorkerRevivals(woken, runId);
          for (const message of sent) await recordAgentMessage(message, 'sent', caller.conversationId);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Queued for ${[...new Set(sent.map((message) => message.to))].join(', ')}.` +
                  (woken.length > 0
                    ? ` Waking ${woken.join(', ')} in ${woken.length === 1 ? 'the same chat' : 'their existing chats'}.`
                    : '')
              }
            ],
            structuredContent: {
              action: 'message',
              run_id: runId,
              queued: sent.map((message) => ({ to: message.to })),
              waking: woken
            }
          };
}