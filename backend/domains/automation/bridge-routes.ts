import type http from 'node:http';
import { isProModel } from '../../../contracts/model-capabilities.js';
import { logWarn } from '../../infrastructure/settings/logger.js';
import { findSessionByConversation } from '../sessions/history/store.js';
import {
  ackGoalDraftNow,
  deferSilenceGoalReplyNow,
  draftOpeningMessage,
  goalKeyPresent,
  goalPendingReplyFor,
  goalViewFor
} from './goal.js';

type ReadBody = (req: http.IncomingMessage) => Promise<unknown>;
type SendJson = (res: http.ServerResponse, status: number, body: unknown, origin: string | null) => void;
type SendTooLarge = (res: http.ServerResponse, origin: string | null) => void;

export interface GoalOpeningRouteSupport {
  readBody: ReadBody;
  json: SendJson;
  tooLarge: SendTooLarge;
  goalMode(): 'goal' | 'loop';
}

export interface GoalAcknowledgementRouteSupport {
  readBody: ReadBody;
  json: SendJson;
  tooLarge: SendTooLarge;
  conversationId(value: unknown): string | null;
  extendedSilenceWindowFor(conversationId: string): Promise<boolean>;
  recoveryBusyMs(pro: boolean): number;
}

export interface GoalObjectiveRouteSupport {
  readBody: ReadBody;
  json: SendJson;
  tooLarge: SendTooLarge;
  conversationId(value: unknown): string | null;
  saveObjective(conversationId: string, text: string, mode: 'goal' | 'loop' | null): Promise<unknown>;
}

export async function handleGoalAcknowledgementRoute(
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string | null,
  support: GoalAcknowledgementRouteSupport
): Promise<boolean> {
  if (route !== '/goal/ack' || req.method !== 'POST') return false;

  let body: Record<string, unknown>;
  try {
    body = (await support.readBody(req)) as Record<string, unknown>;
  } catch (error) {
    if ((error as Error).message === 'body_too_large') support.tooLarge(res, origin);
    else support.json(res, 400, { error: 'bad_request' }, origin);
    return true;
  }

  const id = support.conversationId(body['conversationId']);
  if (!id) {
    support.json(res, 400, { error: 'bad_conversation_id' }, origin);
    return true;
  }

  const token = typeof body['token'] === 'string' ? body['token'] : '';
  const clientId = typeof body['clientId'] === 'string' ? body['clientId'].slice(0, 100) : '';
  try {
    if (body['nativeBusy'] === true) {
      const draft = goalViewFor(id, clientId);
      if (!draft || draft.token !== token || draft.stage !== 'ready') {
        support.json(res, 200, { acknowledged: false, deferred: false }, origin);
        return true;
      }
      const session = await findSessionByConversation(id, { requireUnique: true });
      const selection = session?.selectedModel;
      const pro = (selection?.conversationId === id && isProModel(selection.model, selection.reasoningEffort)) ||
        await support.extendedSilenceWindowFor(id);
      const deferred = await deferSilenceGoalReplyNow(id, draft.turnId, Date.now() + support.recoveryBusyMs(pro), { token, clientId });
      support.json(res, 200, {
        acknowledged: false,
        deferred,
        ...(deferred ? { listenUntil: goalPendingReplyFor(id)?.listenUntil } : {})
      }, origin);
      return true;
    }

    support.json(res, 200, { acknowledged: await ackGoalDraftNow(id, token, clientId) }, origin);
  } catch (error) {
    logWarn(`bridge: Goal acknowledgement for ${id} is not durable yet — ${error instanceof Error ? error.message : String(error)}`);
    support.json(res, 503, { error: 'goal_ack_not_durable', retryable: true }, origin);
  }
  return true;
}

export async function handleGoalObjectiveRoute(
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string | null,
  support: GoalObjectiveRouteSupport
): Promise<boolean> {
  if (route !== '/goal/objective' || req.method !== 'POST') return false;

  let body: Record<string, unknown>;
  try {
    body = (await support.readBody(req)) as Record<string, unknown>;
  } catch (error) {
    if ((error as Error).message === 'body_too_large') support.tooLarge(res, origin);
    else support.json(res, 400, { error: 'bad_request' }, origin);
    return true;
  }

  const id = support.conversationId(body['conversationId']);
  if (!id) {
    support.json(res, 400, { error: 'bad_conversation_id' }, origin);
    return true;
  }

  const text = typeof body['text'] === 'string' ? body['text'] : '';
  const mode = body['mode'] === 'goal' || body['mode'] === 'loop' ? body['mode'] : null;
  try {
    support.json(res, 200, await support.saveObjective(id, text, mode), origin);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'goal_objective_not_durable';
    const refused = ['goal_worker_chat', 'conversation_superseded', 'chat_blocked'].includes(reason);
    support.json(res, refused ? 409 : 503, { error: reason, ...(!refused ? { retryable: true } : {}) }, origin);
  }
  return true;
}

export async function handleGoalOpeningRoute(
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string | null,
  support: GoalOpeningRouteSupport
): Promise<boolean> {
  if (route !== '/goal/open' || req.method !== 'POST') return false;

  let body: Record<string, unknown>;
  try {
    body = (await support.readBody(req)) as Record<string, unknown>;
  } catch (error) {
    if ((error as Error).message === 'body_too_large') support.tooLarge(res, origin);
    else support.json(res, 400, { error: 'bad_request' }, origin);
    return true;
  }

  const text = typeof body['text'] === 'string' ? body['text'] : '';
  if (!text.trim()) {
    support.json(res, 400, { error: 'no_objective' }, origin);
    return true;
  }

  const mode = body['mode'] === 'goal' || body['mode'] === 'loop' ? body['mode'] : null;
  if (!(await goalKeyPresent(mode ?? support.goalMode()))) {
    support.json(res, 409, { error: 'no_api_key' }, origin);
    return true;
  }

  const drafted = await draftOpeningMessage(text, mode);
  support.json(res, 'error' in drafted ? 502 : 200, drafted, origin);
  return true;
}
