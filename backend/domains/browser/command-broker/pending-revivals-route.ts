import type http from 'node:http';
import { conversationId } from '../companion-payload.js';
import type { CommandRouteRuntime } from './routes-runtime.js';
import { createRouteResponders } from './route-responses.js';

export async function handlePendingRevivalsRoute(route: string, req: http.IncomingMessage, res: http.ServerResponse, origin: string | null, runtime: CommandRouteRuntime): Promise<boolean> {
  if (route !== '/commands/revivals/pending' || req.method !== 'POST') return false;
  const { respond, respondTooLarge } = createRouteResponders(runtime, origin);
  let body: Record<string, unknown>;
  try {
    body = (await runtime.readBody(req)) as Record<string, unknown>;
  } catch (err) {
    if ((err as Error).message === 'body_too_large') return respondTooLarge(res, origin);
    return respond(res, 400, { error: 'bad_request' }, origin);
  }
  const rawEntries = Array.isArray(body['entries']) ? body['entries'] : null;
  if (!rawEntries || rawEntries.length > 100) {
    return respond(res, 400, { error: 'bad_revival_entries' }, origin);
  }

  runtime.tidyCommands();
  const pending: string[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    const wanted = typeof candidate['id'] === 'string' ? candidate['id'].slice(0, 128) : '';
    const reportedConversation = conversationId(candidate['conversationId']);
    if (!wanted || !reportedConversation) continue;

    const command = runtime.commands.find((entry) => entry.id === wanted);
    if (!command || command.spec.type !== 'revive' || runtime.revivalDeliveryProven(command)) continue;
    if (command.spec.conversationId !== reportedConversation) continue;
    const revival = runtime.revivalFor(command.spec.agent, command.spec.runId);
    if (!revival || revival.conversationId !== reportedConversation) continue;
    pending.push(wanted);
  }
  return respond(res, 200, { pending }, origin);
}
