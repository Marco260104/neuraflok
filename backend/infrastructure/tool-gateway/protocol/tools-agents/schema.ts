import { z } from 'zod';
import { REASONING_EFFORTS } from '../../../../../contracts/session.js';

export const agentsInputSchema = z.object({
  action: z.enum(['spawn', 'message', 'status', 'finish']).describe('What to do.'),
  run_id: z.string().uuid().optional().describe('Select your returned worker family when status lists several; never grants another caller’s workers.'),
  context: z.string().max(4000).optional().describe('spawn: shared instructions prepended to every task, e.g. repo, conventions, edit limits and validation.'),
  workers: z.array(z.object({
    label: z.string().max(60).optional().describe('Name its job in 1-3 words, e.g. "Tests"; shown to the user.'),
    task: z.string().min(1).max(4000).describe('This worker\'s job: objective, relevant files, constraints and expected handoff.'),
    model: z.string().max(80).optional().describe('Omit unless explicitly requested by the user; app settings supply defaults. Use an exact account-observed model id or provider alias. Invalid overrides return observed ids before opening; the browser confirms availability before Send.'),
    reasoning_effort: z.enum(REASONING_EFFORTS).optional().describe('Omit unless explicitly requested by the user; app settings supply defaults. Do not ask just to spawn a worker. This selects reasoning only, never a model.')
  }).strict()).min(1).max(8).optional().describe('spawn: fresh workers to create only after checking status for a suitable sleeping worker; revive one explicitly with message.'),
  messages: z.array(z.object({
    to: z.string().min(1).max(40).describe('Recipient.'),
    text: z.string().min(1).max(4000).describe('What to say.'),
    label: z.string().trim().min(1).max(60).optional().describe('New job name when waking.')
  }).strict()).min(1).max(16).optional().describe('message: atomic batch; prefer this to one call per recipient.'),
  to: z.string().min(1).max(40).optional().describe('message: one recipient; messaging a sleeping worker wakes it.'),
  target_run_id: z.string().min(1).max(36).optional().describe('message: existing prime run id; prime-only, no worker/status access.'),
  text: z.string().min(1).max(4000).optional().describe('message: what to say.'),
  result: z.string().min(1).max(4000).optional().describe('finish: factual handoff under RESULT / CHANGES / VALIDATION / BLOCKERS.')
}).superRefine((input, ctx) => {
  const reject = (field: 'context' | 'workers' | 'messages' | 'to' | 'target_run_id' | 'text' | 'result', message: string): void => {
    if (input[field] !== undefined) ctx.addIssue({ code: 'custom', path: [field], message });
  };
  if (input.action !== 'spawn') {
    reject('context', 'context is only valid with action=spawn');
    reject('workers', 'workers is only valid with action=spawn');
  }
  if (input.action !== 'message') {
    reject('messages', 'messages is only valid with action=message');
    reject('to', 'to is only valid with action=message');
    reject('target_run_id', 'target_run_id is only valid with action=message');
    reject('text', 'text is only valid with action=message');
  }
  if (input.action !== 'finish') reject('result', 'result is only valid with action=finish');
}).strict();

export const agentsToolConfig = {
  title: 'Multi-agent run',
  description:
    'Run NEURAFLOK worker chats. Omit model and reasoning_effort unless the user explicitly requests an override; saved app defaults apply. Do not ask the user to choose them. Reuse a suitable sleeping worker with message before spawn. ' +
    'message: prime↔worker. Reports ride tool results, never restart primes. Use status once to collect pending reports before finalizing; otherwise state that review is pending. Never poll repeatedly. ' +
    'status: your active, sleeping/revivable and terminal workers, including parked families. finish: record the report, then normally sleep.',
  inputSchema: agentsInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
};

export type AgentsToolInput = z.infer<typeof agentsInputSchema>;
export type AgentsToolInputFor<Action extends AgentsToolInput['action']> = Omit<AgentsToolInput, 'action'> & { action: Action };
