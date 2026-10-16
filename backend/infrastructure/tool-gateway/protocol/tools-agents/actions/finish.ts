import type { AgentsToolInputFor } from '../schema.js';
import type { ToolResult } from '../../tool-contracts.js';
import { fail } from '../../kernel.js';
import { stageFinishAgent } from '../../../../../domains/automation/agents.js';
import { recordAgentMessage } from '../../../../../domains/sessions/history/recorder.js';
import { acceptAgentMutation, callerNow } from '../runtime.js';

export async function finish(input: AgentsToolInputFor<'finish'>, startedAt: number): Promise<ToolResult> {
          if (!input.result) {
            return fail(
              'agents action=finish requires result: the report the prime reads in your place — what you changed, what you verified and what is left. Send it as result and call finish again.'
            );
          }
          const staged = stageFinishAgent(await callerNow(startedAt, { runId: input.run_id, member: true }), input.result);
          if (!staged.repeat) {
            await acceptAgentMutation(staged,
              'The worker finish could not cross its durable acceptance barrier. Nothing was published; retry the same finish result.');
          }
          const { info, report, repeat } = staged;
          if (report) await recordAgentMessage(report, 'sent', info.conversationId);
          // A retry is answered as a retry. Repeating "marked finished" would read as a second finish and invite the model to keep going until it gets a different answer, which is how one lost result became a queue of identical reports.
          return {
            content: [
              {
                type: 'text' as const,
                text: repeat
                  ? `${info.id} was already ${info.state}; the previous result was already recorded for the prime, so nothing was ` +
                    'queued again. This acknowledgment does not confirm delivery to the prime. Stop working and stop calling tools.'
                  : info.state === 'finished'
                    ? `${info.id} is finished. Your result was recorded for the prime. This acknowledgment does not confirm delivery to the prime. This chat has also reached its context ` +
                      'limit, so there will be no more work in it: stop working and stop calling tools.'
                    : `${info.id} reported and is now asleep but remains reusable. Your result was recorded for the prime. ` +
                      'This acknowledgment does not confirm delivery to the prime. Your worker slot is free. Stop working and stop calling tools; for related follow-up work the ' +
                      'prime should wake this same chat with agents action=message before spawning a replacement.'
              }
            ],
            structuredContent: { action: 'finish', self: info.id, state: info.state, repeat }
          };
}