import type http from 'node:http';
import { registerGoalDecisionChat } from '../../automation/goal.js';
import { findSessionByConversation } from '../history/store.js';
import { runningToolCalls } from '../../../infrastructure/tool-gateway/protocol/call-context.js';
import {
  acknowledgeBrowserInput,
  advanceRecoveryInput,
  authorizeBrowserInput,
  bindBrowserInputProject,
  claimBrowserInput,
  completeBrowserDecision,
  deferSilenceInput,
  endRecoveryInput,
  failBrowserInput,
  listInputs,
  pendingBrowserInputs,
  publishBrowserDecision,
  collectRecordedBrowserDecision
} from './input.js';

type ReadBody = (req: http.IncomingMessage) => Promise<unknown>;
type SendJson = (res: http.ServerResponse, status: number, body: unknown, origin: string | null) => void;

export interface InputBridgeRouteSupport {
  readBody: ReadBody;
  json: SendJson;
  conversationId(value: unknown): string | null;
  recoveryInputAllowed(sessionId: string, conversationId: string): boolean;
  staleCompanion(req: http.IncomingMessage): boolean;
  openingHeldElsewhere(inputId: string, browser: string | null): boolean;
  browserOf(req: http.IncomingMessage): string | null;
  changed(): void;
}

const INPUT_ROUTES = new Set([
  '/input/claim',
  '/input/bind',
  '/input/ack',
  '/input/fail',
  '/input/answer',
  '/input/progress',
  '/input/attachment'
]);

function respond(
  support: InputBridgeRouteSupport,
  res: http.ServerResponse,
  origin: string | null,
  status: number,
  body: unknown
): true {
  support.json(res, status, body, origin);
  return true;
}

export async function handleInputBridgeRoute(
  route: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string | null,
  support: InputBridgeRouteSupport
): Promise<boolean> {
  if (req.method !== 'POST' || !INPUT_ROUTES.has(route)) return false;

  const body = await support.readBody(req) as Record<string, unknown>;
  if (!body || typeof body.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.id) || typeof body.owner !== 'string' || body.owner.length > 160) {
    return respond(support, res, origin, 400, { error: 'invalid_input_claim' });
  }

  if (route === '/input/attachment') {
    const rows = await listInputs();
    const entry = rows.find(row => row.id === body.id && row.owner === body.owner && row.state === 'browser' && row.sendAuthorizedAt === undefined);
    const companion = entry?.companionInputId ? rows.find(row => row.id === entry.companionInputId &&
      row.state === 'browser' && row.sendAuthorizedAt === undefined && row.owner === entry.owner &&
      row.sessionId === entry.sessionId && row.conversationId === entry.conversationId && row.completedTurnId === entry.completedTurnId) : undefined;
    const attachment = [...entry?.attachments ?? [], ...companion?.attachments ?? []].find(file => file.id === body.attachmentId);
    if (!attachment || entry?.conversationId !== body.conversationId || typeof body.offset !== 'number') {
      return respond(support, res, origin, 409, { error: 'attachment_not_owned' });
    }
    const { readInputAttachmentChunk } = await import('./attachments/index.js');
    return respond(support, res, origin, 200, { chunk: await readInputAttachmentChunk(attachment, body.offset) });
  }

  if (route === '/input/fail') {
    const accepted = await failBrowserInput(body.id, body.owner, typeof body.error === 'string' ? body.error : 'Unable to prepare the provider page',
      typeof body.detail === 'string' && /^[a-z-]{1,40}$/.test(body.detail) ? body.detail : undefined);
    return respond(support, res, origin, 200, { ok: accepted });
  }

  if (route === '/input/progress') {
    const target = support.conversationId(body.conversationId);
    const temporary = (await listInputs()).some(row => row.id === body.id && row.owner === body.owner && row.lifetime === 'temporary-planner');
    const accepted = (!!target || temporary) && typeof body.partial === 'string' &&
      await publishBrowserDecision(body.id, body.owner, target, body.partial);
    return respond(support, res, origin, 200, { ok: accepted });
  }

  if (route === '/input/bind') {
    const target = support.conversationId(body.conversationId);
    if (!target) return respond(support, res, origin, 400, { error: 'bad_conversation_id' });
    return respond(support, res, origin, 200, { ok: await bindBrowserInputProject(body.id, body.owner, target) });
  }

  if (route === '/input/answer' || route === '/input/ack') {
    const entry = (await listInputs()).find(row => row.id === body.id && row.owner === body.owner);
    if (!entry) return respond(support, res, origin, 409, { error: 'input_not_owned' });
    const deliveredConversation = support.conversationId(body.conversationId);
    if ((!deliveredConversation && entry.lifetime !== 'temporary-planner') ||
        (entry.conversationId && entry.conversationId !== deliveredConversation) ||
        !['browser', 'decision', 'sent', ...(entry.purpose !== 'decision' && route === '/input/ack' ? ['cancelled'] : [])].includes(entry.state)) {
      return respond(support, res, origin, 409, { error: 'input_not_pending' });
    }
    if (entry.purpose === 'decision' && entry.lifetime !== 'temporary-planner') {
      const helperConversation = support.conversationId(body.conversationId);
      if (!helperConversation) return respond(support, res, origin, 409, { error: 'helper_conversation_not_ready' });
      await registerGoalDecisionChat(helperConversation, entry.decisionSourceSessionId);
    }
    if (route === '/input/answer') {
      const accepted = typeof body.response === 'string' &&
        await completeBrowserDecision(body.id, body.owner, body.response, deliveredConversation);
      return respond(support, res, origin, 200, { ok: accepted });
    }
    const acknowledged = await acknowledgeBrowserInput(body.id, body.owner, deliveredConversation,
      typeof body.messageId === 'string' ? body.messageId : undefined);
    if (acknowledged && deliveredConversation) await collectRecordedBrowserDecision(deliveredConversation);
    return respond(support, res, origin, 200, { ok: acknowledged });
  }

  const target = body.conversationId === null ? null : support.conversationId(body.conversationId);
  if (body.conversationId !== null && !target) return respond(support, res, origin, 400, { error: 'bad_conversation_id' });
  if (body.recoveryAction === 'stop' || body.recoveryAction === 'stopped' || body.recoveryAction === 'reloaded') {
    const session = target ? await findSessionByConversation(target) : null;
    const accepted = !!target && support.recoveryInputAllowed(session?.id ?? '', target) &&
      await advanceRecoveryInput(body.id, body.owner, target, body.recoveryAction);
    if (accepted) support.changed();
    return respond(support, res, origin, 200, { ok: accepted });
  }
  if (body.recoveryVeto === 'page-final') {
    const accepted = !!target && await endRecoveryInput(body.id, target);
    if (accepted) support.changed();
    return respond(support, res, origin, 200, { ok: accepted });
  }
  if (typeof body.silenceBusyTurnId === 'string') {
    const accepted = !!target && await deferSilenceInput(body.id, target, body.silenceBusyTurnId);
    if (accepted) support.changed();
    return respond(support, res, origin, 200, { ok: accepted });
  }
  if (body.authorize === true) {
    return respond(support, res, origin, 200, { ok: await authorizeBrowserInput(body.id, body.owner, target) });
  }
  if (target && runningToolCalls(target) > 0 &&
      !(await pendingBrowserInputs()).some(row => row.id === body.id && row.conversationId === target && row.directTurn)) {
    return respond(support, res, origin, 200, { input: null });
  }
  if (support.staleCompanion(req)) return respond(support, res, origin, 200, { input: null });
  if (!target && support.openingHeldElsewhere(body.id, support.browserOf(req))) {
    return respond(support, res, origin, 200, { input: null });
  }
  const input = await claimBrowserInput(body.id, body.owner, target, body.requiresAuthorization === true);
  return respond(support, res, origin, 200, { input });
}
