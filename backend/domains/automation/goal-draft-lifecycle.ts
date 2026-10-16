import { resolveOfflineGoalDecision } from '../../../contracts/automation/offline-goal-decision.js';
import { getConfig } from '../../infrastructure/settings/config.js';
import { logInfo, logWarn } from '../../infrastructure/settings/logger.js';
import { getSession } from '../sessions/history/store.js';
import { goalArmedFor } from './goal-activation.js';
import { goalBackendFor, goalDrivingMode } from './goal-switches.js';
import { goalObjectiveFor } from './goal-objectives.js';
import { notifyGoalChange } from './goal-events.js';
import { requestDrivingDecision, webProviderLabel } from './goal-decision.js';
import { GOAL_LOOP_TRAILER, GOAL_OBJECTIVE_OPENING_TURN, GOAL_OBJECTIVE_TRAILER, GOAL_SYSTEM_TRAILER, goalObjectiveMessage } from '../../../contracts/automation/goal-prompts.js';
import { apiProviderKey, configuredApiEndpoint } from '../providers/api-settings.js';
import { conversationMessages } from './goal-context.js';
import { drafts, expireDraftPayload, REQUEST_TIMEOUT_MS, SETTLED_FAILURE, view, type GoalDraft, type GoalDraftView } from './goal-draft-state.js';

export interface StartGoalDraftInput {
  sessionId: string;
  conversationId: string;
  turnId: string;
  clientId?: string;
  deferStart?: boolean;
}

export interface GoalDraftLifecycleDependencies {
  authorizeBrowserHelperRetry(inputId: string, sessionId: string): Promise<boolean>;
  astraFinishOnly(sessionId: string, conversationId: string): Promise<boolean>;
  loopReplyHasAuthority(sessionId: string, conversationId: string, turnId: string): Promise<boolean>;
  handleGoalReply(conversationId: string, turnId?: string): void;
}

export function createGoalDraftLifecycle(dependencies: GoalDraftLifecycleDependencies) {
  async function retryGoalBrowserHelper(sourceSessionId: string, inputId: string): Promise<boolean> {
    const session = await getSession(sourceSessionId);
    if (!session?.conversationId) return false;
    const draft = drafts.get(session.conversationId);
    if (draft && (draft.sessionId !== sourceSessionId || draft.stage !== 'failed')) return false;
    if (draft && !goalArmedFor(session.conversationId)) return false;
    if (!await dependencies.authorizeBrowserHelperRetry(inputId, sourceSessionId)) return false;
    if (draft && drafts.get(session.conversationId) === draft && (await getSession(sourceSessionId))?.conversationId === session.conversationId && goalArmedFor(session.conversationId)) {
      drafts.delete(session.conversationId);
      startGoalDraft({ conversationId: session.conversationId, sessionId: sourceSessionId, turnId: draft.turnId, clientId: draft.clientId });
    }
    return true;
  }

  function startGoalDraft(input: StartGoalDraftInput): GoalDraftView {
    const existing = drafts.get(input.conversationId);
    const clientId = input.clientId ?? '';
    if (existing) expireDraftPayload(existing);
    if (existing && !existing.acknowledged && existing.clientId !== clientId) {
      throw new Error('goal_owned_elsewhere');
    }
    const spentFailure =
      existing?.stage === 'failed' && existing.acknowledged && !SETTLED_FAILURE.test(existing.error ?? '');
    if (existing && existing.turnId === input.turnId && !spentFailure) return view(existing);
    if (existing) {
      existing.abort?.abort();
      drafts.delete(input.conversationId);
    }
    const settings = getConfig().goal;
    const backend = goalBackendFor(goalDrivingMode(input.conversationId));
    const draft: GoalDraft = {
      token: `goal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      backend,
      endpoint: configuredApiEndpoint(),
      reasoning: settings.reasoning,
      systemPrompt: settings.prompt,
      objectiveSystemPrompt: settings.objectivePrompt,
      loopSystemPrompt: settings.loopPrompt,
      mode: goalDrivingMode(input.conversationId),
      objective: goalObjectiveFor(input.conversationId),
      clientId,
      turnId: input.turnId,
      stage: 'sending',
      model: backend === 'web' ? webProviderLabel(input.conversationId) : settings.model,
      text: '',
      reply: '',
      error: null,
      startedAt: Date.now(),
      settledAt: 0,
      acknowledged: false,
      work: null,
      abort: null
    };
    drafts.set(input.conversationId, draft);
    notifyGoalChange();
    if (!input.deferStart) beginGoalDraft(input.conversationId, draft.token);
    return view(draft);
  }

  function beginGoalDraft(conversationId: string, token: string): boolean {
    const draft = drafts.get(conversationId);
    if (!draft || draft.token !== token || draft.acknowledged || draft.work) return false;
    draft.work = run(draft).catch((err: Error) => {
      settle(draft, 'failed', `goal_failed: ${err.message}`);
    });
    return true;
  }

  function discardPreparedGoalDraft(conversationId: string, token: string): boolean {
    const draft = drafts.get(conversationId);
    if (!draft || draft.token !== token || draft.work) return false;
    drafts.delete(conversationId);
    return true;
  }

  function settle(draft: GoalDraft, stage: GoalDraft['stage'], error: string | null = null): void {
    if (drafts.get(draft.conversationId) !== draft) return;
    draft.stage = stage;
    draft.error = error;
    draft.settledAt = Date.now();
    if (stage === 'no-reply') dependencies.handleGoalReply(draft.conversationId, draft.turnId);
    notifyGoalChange();
  }

  async function run(draft: GoalDraft): Promise<void> {
    if (await dependencies.astraFinishOnly(draft.sessionId, draft.conversationId)) return settle(draft, 'no-reply');
    if (draft.mode === 'loop' && !await dependencies.loopReplyHasAuthority(draft.sessionId, draft.conversationId, draft.turnId)) return settle(draft, 'no-reply');
    const { endpoint, reasoning } = draft;
    const key = draft.backend === 'api' ? await apiProviderKey(endpoint.kind) : null;
    if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
    if (draft.backend === 'api' && !key && endpoint.kind !== 'custom') return settle(draft, 'failed', 'no_api_key');
    const messages = await conversationMessages(draft.sessionId);
    if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
    if (!draft.objective && (messages.length === 0 || !messages.some((message) => message.role === 'user'))) {
      return settle(draft, 'failed', 'no_conversation');
    }

    const abort = new AbortController();
    draft.abort = abort;
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    try {
      const decision = draft.backend === 'templates' ? resolveOfflineGoalDecision(messages.filter((message) => message.role === 'assistant').at(-1)?.content ?? '', Math.floor(Math.random() * 200), Math.floor(Math.random() * 200)) : await requestDrivingDecision({
        backend: draft.backend,
        endpoint,
        reasoning,
        sourceSessionId: draft.sessionId,
        sourceConversationId: draft.conversationId,
        key: key ?? '',
        model: draft.model,
        mode: draft.mode,
        system:
          draft.mode === 'loop'
            ? draft.objective
              ? [draft.loopSystemPrompt, goalObjectiveMessage(draft.objective)]
              : [draft.loopSystemPrompt]
            : draft.objective
              ? [draft.objectiveSystemPrompt, goalObjectiveMessage(draft.objective)]
              : [draft.systemPrompt],
        messages: messages.length > 0 ? messages : [{ role: 'user', content: GOAL_OBJECTIVE_OPENING_TURN }],
        trailer:
          draft.mode === 'loop'
            ? GOAL_LOOP_TRAILER
            : draft.objective
              ? GOAL_OBJECTIVE_TRAILER
              : GOAL_SYSTEM_TRAILER,
        signal: abort.signal,
        publish: (text) => {
          draft.stage = 'answering';
          if (drafts.get(draft.conversationId) === draft) { draft.text = text; notifyGoalChange(); }
        }
      });
      if (draft.acknowledged || drafts.get(draft.conversationId) !== draft) return;
      if (await dependencies.astraFinishOnly(draft.sessionId, draft.conversationId)) return settle(draft, 'no-reply');
      if (decision.action === 'http' || decision.action === 'invalid') {
        logWarn(`goal: draft for ${draft.conversationId} failed — ${decision.error}`);
        return settle(draft, 'failed', decision.error);
      }
      if (decision.action === 'stop') {
        if (draft.mode === 'loop') {
          logWarn(`goal: the loop would not write a message in ${draft.conversationId} with ${draft.model}`);
          return settle(draft, 'failed', 'loop_stop_refused');
        }
        logInfo(`goal: ${draft.model} says the goal is met in ${draft.conversationId}; nothing was sent`);
        draft.reply = '';
        return settle(draft, 'no-reply');
      }
      draft.reply = decision.reply;
      logInfo(`goal: drafted ${decision.reply.length} characters for ${draft.conversationId} with ${draft.model}`);
      settle(draft, 'ready');
    } catch (err) {
      const detail = (err as Error).message;
      const failure = abort.signal.aborted
        ? 'timeout_or_cancelled'
        : detail === 'reply_too_long' || detail === 'stream_record_too_long' || detail.startsWith('goal_browser_')
          ? detail
          : `request_failed: ${detail}`;
      logWarn(`goal: draft for ${draft.conversationId} failed — ${failure}`);
      settle(draft, 'failed', failure);
    } finally {
      clearTimeout(timer);
      draft.abort = null;
    }
  }

  return { retryGoalBrowserHelper, startGoalDraft, beginGoalDraft, discardPreparedGoalDraft };
}
