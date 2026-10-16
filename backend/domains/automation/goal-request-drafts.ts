import { conversationMessages, type ChatMessage } from './goal-context.js';
import { planProgressText } from './plan-progress-preview.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { logInfo } from '../../infrastructure/settings/logger.js';
import { getSession, readRecentEvents } from '../sessions/history/store.js';
import { GOAL_LOOP_TRAILER, GOAL_OBJECTIVE_OPENING_TURN, GOAL_OBJECTIVE_TRAILER, GOAL_SYSTEM_TRAILER, goalObjectiveMessage } from '../../../contracts/automation/goal-prompts.js';
import { OFFLINE_GOAL_MARKER_INSTRUCTION } from '../../../contracts/automation/offline-goal-catalog.js';
import { resolveOfflineGoalDecision } from '../../../contracts/automation/offline-goal-decision.js';
import type { TaskProgressUpdate } from '../../../contracts/automation/task-progress.js';
import type { GoalBackend, GoalMode } from '../../../contracts/types.js';
import type { TaskRequestError } from './task-requests/errors.js';
import { goalBackendFor, goalDrivingMode } from './goal-switches.js';
import { goalObjectiveFor } from './goal-objectives.js';
import { apiProviderKey, configuredApiEndpoint } from '../providers/api-settings.js';
import { requestDrivingDecision, requestGoalDecision, webProviderLabel, type GoalRequest } from './goal-decision.js';

interface Runtime {
  automaticLoopHasMcpWork: (sessionId: string, conversationId: string, turnId: string) => Promise<boolean>;
  nativeGoalFailure: (error: string, backend: GoalBackend, retryAfterMs?: number) => TaskRequestError;
  retryableGoalFailure: (error: string) => boolean;
  requestTimeoutMs: number;
}

export function createGoalRequestDrafts(runtime: Runtime) {
  async function draftFastFollowup(
    sessionId: string,
    signal: AbortSignal = AbortSignal.timeout(180_000),
    preparedMessages?: ChatMessage[],
    publish?: GoalRequest['publish'],
    mode: GoalMode = 'loop'
  ): Promise<string | null> {
    const backend = goalBackendFor(mode);
    const settings = getConfig().goal;
    const endpoint = configuredApiEndpoint();
    const key = backend === 'api' ? await apiProviderKey(endpoint.kind) : null;
    if (backend === 'api' && !key && endpoint.kind !== 'custom') {
      throw new Error('Configure the selected model provider key for automatic finish follow-ups, or choose Notify me');
    }
    const session = await getSession(sessionId);
    if (!session?.conversationId) throw new Error('This session has no current conversation');
    if (mode === 'loop') {
      const [start] = await readRecentEvents(sessionId, 1, { kinds: ['turn_start'] });
      const source = session.activeTurnId ?? start?.turnId;
      if (!source || !await runtime.automaticLoopHasMcpWork(sessionId, session.conversationId, source)) return null;
    }
    const objective = goalObjectiveFor(session.conversationId);
    const { listInputs } = await import('../sessions/input/input.js');
    const inputs = await listInputs();
    const appInput = inputs
      .filter(entry => entry.sessionId === sessionId && entry.purpose !== 'decision' && !entry.finishOwner && ['tool', 'sent'].includes(entry.state))
      .slice(-5)
      .map(entry => entry.text);
    const messages = preparedMessages ?? await conversationMessages(sessionId, appInput);
    if (!objective && !messages.some(message => message.role === 'user')) throw new Error('No recorded user request is available for Goal');
    const prompt = mode === 'loop' ? settings.loopPrompt : objective ? settings.objectivePrompt : settings.prompt;
    const decision = backend === 'templates'
      ? resolveOfflineGoalDecision(messages.filter(message => message.role === 'assistant').at(-1)?.content ?? '', Math.floor(Math.random() * 200), Math.floor(Math.random() * 200))
      : await requestDrivingDecision({
          sourceSessionId: sessionId,
          sourceConversationId: session.conversationId,
          backend,
          endpoint,
          reasoning: settings.reasoning,
          key: key ?? '',
          model: settings.model,
          mode,
          system: objective ? [prompt, goalObjectiveMessage(objective)] : [prompt],
          messages,
          trailer: mode === 'loop' ? GOAL_LOOP_TRAILER : objective ? GOAL_OBJECTIVE_TRAILER : GOAL_SYSTEM_TRAILER,
          signal,
          publish
        }).catch(error => {
          if (signal.aborted && signal.reason?.name === 'TimeoutError') {
            throw runtime.nativeGoalFailure('timeout_or_cancelled: Goal request timed out', backend);
          }
          signal.throwIfAborted();
          throw runtime.nativeGoalFailure(`request_failed: ${error instanceof Error ? error.message : error}`, backend);
        });
    if (decision.action === 'stop') {
      if (mode === 'loop') throw new Error('loop_stop_refused');
      return null;
    }
    if (decision.action !== 'continue') {
      throw runtime.nativeGoalFailure(
        'error' in decision ? decision.error : 'Goal did not return a usable follow-up',
        backend,
        'retryAfterMs' in decision ? decision.retryAfterMs : undefined
      );
    }
    return decision.reply;
  }

  async function draftTaskPlan(
    prompt: string,
    backend: 'api' | 'web',
    onProgress?: (progress: TaskProgressUpdate) => void,
    signal?: AbortSignal
  ): Promise<string[]> {
    onProgress?.({ phase: 'preparing', text: '' });
    if (!prompt.trim() || prompt.length > 16_000) throw new Error('Enter a task of at most 16000 characters');
    const settings = getConfig().goal;
    const endpoint = configuredApiEndpoint();
    const key = backend === 'api' ? await apiProviderKey(endpoint.kind) : null;
    if (backend === 'api' && !key && endpoint.kind !== 'custom') {
      throw new Error('Configure the selected model provider key or choose a connected web model');
    }
    onProgress?.({ phase: 'generating', text: '' });
    const result = await requestGoalDecision({
      backend,
      endpoint,
      reasoning: settings.reasoning,
      lifetime: 'temporary-planner',
      key: key ?? '',
      model: settings.model,
      mode: 'goal',
      publish: text => onProgress?.({ phase: 'generating', text: planProgressText(text) }),
      system: [
        'You are a task planner, not the executor. Produce 2 to 12 substantial workflow stages; prefer a complete implementation stage followed by a few meaningful verification passes. The executor receives the original user request and the ENTIRE workflow in its first message. Stage 1 must state the complete objective, all implementation requirements and constraints, and the end-to-end execution approach. Never restrict Stage 1 to discovery, planning, a skeleton, or a fraction of the product. If the user requests subagents, include their concrete assignments and early delegation in Stage 1 so they can work in parallel immediately. Later stages are verification and improvement checkpoints, not withheld implementation requirements: where relevant, exercise the actual app with computer use, inspect failures, repair underlying causes, rebuild or reinstall when authorized, and repeat the failed workflows. Include independent subagent code review when requested and a final check of the whole original request. Preserve the user\'s scope, authorization limits, platform, constraints and required evidence; do not invent unrelated work or claim installation/browser checks were performed. Return action continue; its reply must be a JSON string encoding {"stages":["complete implementation workflow", "verification workflow"]}. Keep the entire plan below 12000 characters. Later checkpoints are queued to the same conversation at Session finish, or after a completed turn when the user enables that delivery.'
      ],
      messages: [{ role: 'user', content: prompt.trim() }],
      trailer: 'Produce the staged plan now. Do not execute the task.',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(runtime.requestTimeoutMs)]) : AbortSignal.timeout(runtime.requestTimeoutMs)
    }).catch(error => {
      throw runtime.nativeGoalFailure(`request_failed: ${error instanceof Error ? error.message : error}`, backend);
    });
    signal?.throwIfAborted();
    if (result.action !== 'continue') {
      throw runtime.nativeGoalFailure(
        'error' in result ? result.error : 'No plan was generated',
        backend,
        'retryAfterMs' in result ? result.retryAfterMs : undefined
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(result.reply);
    } catch {
      throw new Error('The planner returned invalid JSON; nothing was queued');
    }
    const stages = (data as { stages?: unknown } | null)?.stages;
    if (!Array.isArray(stages) || stages.length < 2 || stages.length > 12 || stages.some(stage =>
      typeof stage !== 'string' || !stage.trim() || stage.length > 16_000
    ) || JSON.stringify(stages).length > 12_000) {
      throw new Error('The planner returned invalid stages; nothing was queued');
    }
    onProgress?.({ phase: 'ready', text: stages.join('\n\n').slice(-8_000) });
    return stages.map(stage => (stage as string).trim());
  }

  async function draftOpeningMessage(
    objective: string,
    named: GoalMode | null = null,
    onProgress?: (progress: TaskProgressUpdate) => void,
    signal?: AbortSignal
  ): Promise<{ reply: string; model: string } | { error: string; retryable?: boolean; retryAfterMs?: number }> {
    const goal = objective.trim();
    signal?.throwIfAborted();
    onProgress?.({ phase: 'preparing', text: '' });
    if (!goal) return { error: 'no_objective' };
    const settings = getConfig().goal;
    const endpoint = configuredApiEndpoint();
    const backend = goalBackendFor(named ?? goalDrivingMode());
    if (backend === 'templates') return { reply: goal + OFFLINE_GOAL_MARKER_INSTRUCTION, model: 'Offline Goal' };
    const key = backend === 'api' ? await apiProviderKey(endpoint.kind) : null;
    if (backend === 'api' && !key && endpoint.kind !== 'custom') return { error: 'no_api_key' };
    const model = backend === 'web' ? webProviderLabel() : settings.model;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), runtime.requestTimeoutMs);
    try {
      const mode = named ?? goalDrivingMode();
      const decision = await requestDrivingDecision({
        backend,
        endpoint,
        reasoning: settings.reasoning,
        key: key ?? '',
        model,
        mode,
        system: [mode === 'loop' ? settings.loopPrompt : settings.objectivePrompt, goalObjectiveMessage(goal)],
        messages: [{ role: 'user', content: GOAL_OBJECTIVE_OPENING_TURN }],
        trailer: mode === 'loop' ? GOAL_LOOP_TRAILER : GOAL_OBJECTIVE_TRAILER,
        signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal,
        publish: text => onProgress?.({ phase: 'generating', text: text.slice(-8_000) })
      });
      if (decision.action === 'http') {
        return { error: decision.error, retryable: runtime.retryableGoalFailure(decision.error), retryAfterMs: decision.retryAfterMs };
      }
      if (decision.action === 'invalid') {
        return { error: decision.error, retryable: runtime.retryableGoalFailure(decision.error) };
      }
      if (decision.action === 'stop') return { error: 'nothing_to_open_with' };
      logInfo(`goal: drafted an opening message of ${decision.reply.length} characters with ${model}`);
      return { reply: decision.reply, model };
    } catch (err) {
      const detail = (err as Error).message;
      const error = abort.signal.aborted ? 'timeout_or_cancelled' : `request_failed: ${detail}`;
      return { error, retryable: runtime.retryableGoalFailure(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  return { draftFastFollowup, draftTaskPlan, draftOpeningMessage };
}
