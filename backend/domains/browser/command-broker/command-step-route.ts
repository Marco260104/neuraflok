import type http from 'node:http';
import { continuationByToken } from '../../sessions/continuity/continuation.js';
import type { CommandRouteRuntime } from './routes-runtime.js';
import { createRouteResponders } from './route-responses.js';

export async function handleCommandStepRoute(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, runtime: CommandRouteRuntime): Promise<boolean> {
  if (route !== '/commands/step' || req.method !== 'POST') return false;
  const { respond, respondTooLarge } = createRouteResponders(runtime, origin);
  let body: Record<string, unknown>;
  try {
    body = (await runtime.readBody(req)) as Record<string, unknown>;
  } catch (err) {
    if ((err as Error).message === 'body_too_large') return respondTooLarge(res, origin);
    return respond(res, 400, { error: 'bad_request' }, origin);
  }
  const step = runtime.COMMAND_STEPS.find(candidate => candidate === body['step']);
  const command = runtime.commands.find(entry => entry.id === body['id']);
  // A wake reports its wait before it redeems, so it has no owner yet; every later step needs one.
  const allowed = step && runtime.REVIVAL_WAIT_STEPS.has(step) ? command?.owner === null : command?.owner != null && command.owner === body['client'];
  if (!step || !command || !allowed) return respond(res, 200, { ok: false }, origin);
  command.progress = { ...command.progress, step, stepAt: Date.now() };
  if (command.spec.type === 'resume' && command.timer && continuationByToken(command.spec.token)?.automatic) runtime.armDeadline(command);
  return respond(res, 200, { ok: true }, origin);
}
