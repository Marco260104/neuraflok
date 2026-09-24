import type { Chronological, TimelineTurns, TurnIdentity, RequestTurns } from './types.js';
import { positionOf } from './position.js';

export function injectedUserMessage(entry: Chronological, turns?: TimelineTurns): boolean {
  // Browser-delivered app messages use explicit input or generation evidence; inputId alone does not prove injection.
  return entry.kind === 'user_message' && !!entry.inputId &&
    (entry.messageId?.startsWith('input:') === true ||
      (!!entry.turnId && !!turns && Object.hasOwn(turns, entry.turnId)));
}

/** The journal keeps document-local ids; this derived relation names their one response. */
export function responseTurnId(turns: TimelineTurns | undefined, id: string): string {
  const turn = turns?.[id], owner = turn?.responseTurnId;
  return owner && turns?.[owner] && turns[owner].origin < turn.origin ? owner : id;
}

/** Only usable alongside a matching, exactly attributed request. A question alone is insufficient: retries after an end and different native questions remain distinct. */
export function overlappingRequestTurns(
  turns: TimelineTurns | undefined, left: string, right: string, requests: RequestTurns | undefined, requestId: string
): boolean {
  if (!turns) return false;
  const first = responseTurnId(turns, left), second = responseTurnId(turns, right);
  const a = turns[first], b = turns[second];
  if (!a || !b || !a.questionId || a.questionId !== b.questionId) return false;
  // A new exact request can identify a replacement response before the prior document publishes its end.
  if (first !== second && Object.entries(requests ?? {}).some(([id, owner]) => id !== requestId && owner &&
      [first, second].includes(responseTurnId(turns, owner.turnId)))) return false;
  const earlier = a.origin <= b.origin ? a : b, later = earlier === a ? b : a;
  return earlier.endOrigin === undefined || later.origin < earlier.endOrigin;
}

/** Store-owned, rebuildable identity projection. Raw events and MCP attribution stay intact. */
export function applyTurnIdentity(identity: TurnIdentity, event: Chronological): void {
  const origin = positionOf(event);
  if (event.kind === 'user_message' && event.messageId && !injectedUserMessage(event, identity.timelineTurns) &&
      (!identity.nativeQuestion || origin > identity.nativeQuestion.origin)) {
    identity.nativeQuestion = { messageId: event.messageId, origin };
  }
  let turns = identity.timelineTurns ?? {};
  if (event.turnId && event.kind === 'turn_start' && !Object.hasOwn(turns, event.turnId)) {
    identity.timelineTurns = turns = { ...turns, [event.turnId]: { origin, time: event.time,
      ...(identity.nativeQuestion ? { questionId: identity.nativeQuestion.messageId } : {}) } };
  } else if (event.turnId && event.kind === 'turn_end' && turns[event.turnId]) {
    const start = turns[event.turnId]!;
    identity.timelineTurns = turns = { ...turns, [event.turnId]: { ...start,
      endTime: Math.max(start.endTime ?? 0, event.time), endOrigin: Math.min(start.endOrigin ?? Infinity, origin) } };
  }
  if (event.kind !== 'tool_call' || event.source !== 'mcp' || !event.turnId ||
      event.call?.attribution !== 'request_id' || !event.call.requestId || !event.call.conversationId) return;
  const { requestId, conversationId } = event.call;
  const requests = identity.requestTurns ?? {};
  const held = recordedRequestTurn(requests, requestId, conversationId);
  let owner = responseTurnId(turns, event.turnId);
  if (held && responseTurnId(turns, held.turnId) !== owner) {
    if (!overlappingRequestTurns(turns, held.turnId, owner, requests, requestId)) {
      identity.requestTurns = { ...requests, [requestId]: null };
      return;
    }
    const prior = responseTurnId(turns, held.turnId);
    const earlier = turns[prior]!.origin <= turns[owner]!.origin ? prior : owner;
    const later = earlier === prior ? owner : prior;
    const joined = { ...turns };
    for (const [id, turn] of Object.entries(turns)) {
      if (id === later || turn.responseTurnId === later) joined[id] = { ...turn, responseTurnId: earlier };
    }
    identity.timelineTurns = turns = joined;
    owner = earlier;
  }
  if (held === null) {
    if (requests[requestId] !== null) identity.requestTurns = { ...requests, [requestId]: null };
    return;
  }
  if (held && held.turnId === owner && held.origin <= origin) return;
  identity.requestTurns = { ...requests, [requestId]: {
    turnId: owner, conversationId, origin: Math.min(held?.origin ?? Infinity, origin)
  } };
}

export function recordedRequestTurn(
  requests: RequestTurns | undefined, requestId: string | null | undefined, conversationId: string | null | undefined
): RequestTurns[string] | undefined {
  if (!requestId || !requests || !Object.hasOwn(requests, requestId)) return undefined;
  const owner = requests[requestId];
  return owner && owner.conversationId === conversationId ? owner : null;
}
