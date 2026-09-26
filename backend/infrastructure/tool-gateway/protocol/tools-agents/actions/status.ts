import type { AgentsToolInputFor } from '../schema.js';
import type { ToolResult } from '../../tool-contracts.js';
import { agentFamiliesForCaller, PRIME_ID, statusForCaller } from '../../../../../domains/automation/agents.js';
import { callerNow, measureSleepingWorkers } from '../runtime.js';

export async function status(input: AgentsToolInputFor<'status'>, startedAt: number): Promise<ToolResult> {
        // Status describes only this exact caller's family. No family is a normal empty result, independent of whether another prime has workers; discovery grants no role.
        const caller = await callerNow(startedAt, { runId: input.run_id });
        await measureSleepingWorkers(caller);
        const status = statusForCaller(caller);
        const me = status.self;
        const state = status.state;
        const families = agentFamiliesForCaller(caller);
        const familyNotice = families.length > 1
          ? `\n\nYour worker families: ${families.map(family => `${family.run_id} (${family.running ? 'active' : 'retained'})`).join(', ')}. Use run_id to select a family; worker names are local to that family.`
          : '';
        if (!me) return {
          content: [{ type: 'text' as const, text: families.length
            ? `Select one of your worker families with run_id.${familyNotice}`
            : 'No workers or retained worker history belong to this caller. Use agents action=spawn if the task needs workers.' }],
          structuredContent: { action: 'status', run_id: null, self: null, agents: [], free_worker_slots: status.freeWorkerSlots,
            ...(families.length > 1 ? { available_runs: families } : {}) }
        };
        const failed = state.agents.filter((info) => info.state === 'failed');
        // The word the model reads here is the whole answer to "may I use this worker again". A sleeping worker is not a spent one, and calling it finished in this table is what sends a prime off to spawn a fourth chat for work its first worker already knows the background to.
        const shown = (info: { state: string; revivable: boolean }): string =>
          info.state === 'sleeping'
            ? info.revivable
              ? 'sleeping (reusable; wake with action=message)'
              : 'sleeping'
            : info.state === 'waking'
              ? 'waking (your message is being delivered to its chat)'
              : info.state === 'finished'
                ? 'finished (not reusable)'
              : info.state;
        const asleep = state.agents.filter((info) => info.state === 'sleeping' && info.revivable);
        const slots = status.freeWorkerSlots;
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `You are ${me.id}.\n` +
                state.agents
                  .map(
                    (info) =>
                      `${info.id}  ${info.role}  ${shown(info)}  waiting ${info.pending}  ${info.label}` +
                      (info.model ? `  model ${info.model}` : '') +
                      (info.reasoningEffort ? `  reasoning ${info.reasoningEffort}` : '') +
                      (info.result
                        ? `\n    ${info.state === 'failed' ? 'failure' : info.state === 'finished' ? 'result' : 'latest result'}: ${info.result.slice(0, 300)}`
                        : '')
                  )
                  .join('\n') +
                (me.id === PRIME_ID
                  ? `\n\n${slots} of your worker slots ${slots === 1 ? 'is' : 'are'} free.` +
                    (asleep.length > 0
                      ? ` REUSE FIRST: ${asleep.map((info) => info.id).join(', ')} ${asleep.length === 1 ? 'is' : 'are'} asleep and ` +
                        'can be woken with agents action=message, in the chat they already have and with everything ' +
                        'they learned there still in it. For related follow-up work, do this before action=spawn' +
                        (slots === 0 ? ', once a slot frees up.' : '.')
                      : '')
                  : '') +
                // Said in words as well as in the table: a failed worker will not report, and waiting for it is the mistake this line prevents.
                (failed.length > 0
                  ? `\n\n${failed.map((info) => info.id).join(', ')} will not report. Do that work yourself or wake ` +
                    'another worker; do not wait for them.'
                  : '') +
                // A status check is a glance, not a stopping point. Without this the table reads like an answer to hand back to the user, and a prime that has just looked at its workers stops mid-run to report what it saw.
                familyNotice + '\n\nThis is the current status. Continue working.'
            }
          ],
          structuredContent: {
            action: 'status',
            run_id: status.runId,
            self: me.id,
            free_worker_slots: slots,
            ...(families.length > 1 ? { available_runs: families } : {}),
            agents: state.agents.map((info) => ({
              id: info.id,
              role: info.role,
              label: info.label,
              model: info.model,
              reasoning_effort: info.reasoningEffort,
              state: info.state,
              revivable: info.revivable,
              waiting: info.pending,
              result: info.result ?? null
            }))
          }
        };
}