import type { AgentsToolInputFor } from '../schema.js';
import type { ToolResult } from '../../tool-contracts.js';
import { adoptAgent, fail } from '../../kernel.js';
import { PRIME_ID, requestWorkerBootstraps, stageSpawn } from '../../../../../domains/automation/agents.js';
import { currentCall, currentCaller } from '../../call-context.js';
import { acceptAgentMutation, callerNow } from '../runtime.js';

export async function spawn(input: AgentsToolInputFor<'spawn'>, startedAt: number): Promise<ToolResult> {
          if (!input.workers) return fail('agents action=spawn requires workers.');
          // Reserve under exact chat proof or the permitted transport request, atomically. The request remains the reachable prime before browser attachment; later proof changes its frontend projection without recreating workers or replaying spawn.
          const staged = stageSpawn({
            workers: input.workers,
            context: input.context ?? null,
            caller: await callerNow(startedAt, { exact: true, runId: input.run_id })
          });
          await acceptAgentMutation(staged,
            'The worker run could not cross its durable acceptance barrier. The spawn was rolled back; retry this same request.');
          const { created, becamePrime, runId, defaultNotes } = staged;
          if (currentCall()) currentCall()!.caller.runId = runId;
          // Browser tabs are a publication side effect, never part of planning. They become visible only after the exact broker revision above is durable.
          requestWorkerBootstraps(created.map((worker) => worker.id), runId);
          await adoptAgent(PRIME_ID);
          const invited = created.filter((worker) => worker.state === 'invited');
          const sleeping = created.filter((worker) => worker.state === 'sleeping' && worker.revivable);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  (becamePrime ? `This ${currentCaller().conversationId ? 'conversation' : 'request'} is now the prime agent of run ${runId}. ` : '') +
                  `${created.length} worker(s) matched: ${created.map((info) => `${info.id} (${info.label}, ${info.state}${info.model ? `, model ${info.model}` : ''}${info.reasoningEffort ? `, reasoning ${info.reasoningEffort}` : ''})`).join(', ')}. ` +
                  (invited.length > 0 ? 'New worker chats are opening with their briefs already in them. ' : '') +
                  (defaultNotes?.length ? `${defaultNotes.join(' ')} ` : '') +
                  (sleeping.length > 0
                    ? `${sleeping.map((worker) => worker.id).join(', ')} already finished that earlier piece and is sleeping in its existing chat; wake it with action=message instead of spawning a duplicate. `
                    : '') +
                  'Carry on with your own work — results and ' +
                  'messages arrive at the end of later tool results, so there is nothing to wait for and never anything ' +
                  'to poll. A short correction with action=message while a worker is still going is far cheaper than ' +
                  'the alternative.'
              }
            ],
            structuredContent: {
              action: 'spawn',
              run_id: runId,
              self: PRIME_ID,
              became_prime: becamePrime,
              workers: created.map((info) => ({ id: info.id, label: info.label, state: info.state, model: info.model, reasoning_effort: info.reasoningEffort }))
            }
          };
}