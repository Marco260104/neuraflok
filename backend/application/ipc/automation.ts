import { z } from 'zod';
import { listGoalModels, MODEL_PAGE_SIZE, goalBackendFor, nativeGoalFailure, draftOpeningMessage } from '../../domains/automation/goal.js';
import { clearAgent, persistAgentAuthorityNow, resetSwarm, swarmState } from '../../domains/automation/agents.js';
import { cancelWorkerCommands } from '../../domains/browser/bridge.js';
import { cancelTaskRequest, runTaskRequest } from '../../domains/automation/task-requests/registry.js';
import type { IpcRouteContext } from './types.js';

const agentIdArg = z.string().min(1).max(64).regex(/^[0-9a-z-]+$/i);

export function registerAutomationIpc({ handle, push }: Pick<IpcRouteContext, 'handle' | 'push'>): void {
  handle('goal:models', async (payload) => {
    const { offset, query } = z.object({
      offset: z.number().int().min(0).max(2000).default(0),
      query: z.string().max(160).default('')
    }).parse(payload ?? {});
    return listGoalModels(offset, MODEL_PAGE_SIZE, query);
  });


  handle('swarm:get', async () => swarmState());
  handle('swarm:reset', async () => {
    resetSwarm();
    if (!(await persistAgentAuthorityNow())) {
      throw new Error('The cleared run could not be made durable. Retry clearing the swarm.');
    }
    return swarmState();
  });
  /** Clearing one row in the app: the prime ends the run, a worker frees its own slot. The queued bootstrap is withdrawn here rather than from inside the broker. The broker deliberately knows nothing about HTTP or tabs, and `drop()` reaches `failAgent` from inside a delivery — cancelling from there would re-enter it. An IPC call never is. `tidyCommands()` would retire the command on its own at the next poll; doing it now is what stops a tab opening for a slot the user has just cleared. */
  handle('swarm:clearAgent', async (payload) => {
    const { id, runId } = z.object({ id: agentIdArg, runId: z.string().min(1).max(200).optional() }).parse(typeof payload === 'string' ? { id: payload } : payload);
    const outcome = clearAgent(id, runId);
    if (outcome.cleared !== 'none') {
      if (!(await persistAgentAuthorityNow())) {
        throw new Error('The agent clear could not be made durable. Retry the clear action.');
      }
      if (outcome.cleared === 'worker') cancelWorkerCommands(outcome.reason, id, runId);
    }
    // The prime's report stays in the main process: the renderer needs the outcome, not the message queued for the prime agent.
    return { cleared: outcome.cleared, reason: outcome.reason, swarm: swarmState() };
  });



  handle('tasks:cancel', async payload => cancelTaskRequest(z.object({ requestId: z.string().uuid() }).parse(payload).requestId));
  handle('sessions:goalOpening', async payload => {
    const { text, mode, requestId } = z.object({ text: z.string().trim().min(1).max(16000),
      mode: z.enum(['goal', 'loop']), requestId: z.string().uuid() }).parse(payload);
    const backend = goalBackendFor(mode);
    const publish = (progress: import('../../../contracts/automation/task-progress.js').TaskProgressUpdate) => push('task:progress', { requestId, ...progress });
    return runTaskRequest(requestId, JSON.stringify(['goal', text, mode]), async signal => {
      if (goalBackendFor(mode) !== backend) throw new Error('task_settings_changed');
      const drafted = await draftOpeningMessage(text, mode, publish, signal);
      if ('error' in drafted) throw nativeGoalFailure(drafted.error, backend, drafted.retryAfterMs);
      signal.throwIfAborted(); publish({ phase: 'ready', text: drafted.reply.slice(-8000) });
      return drafted;
    }, publish);
  });

}
