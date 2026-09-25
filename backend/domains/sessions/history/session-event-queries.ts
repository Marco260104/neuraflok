import { cleanProviderReply } from '../../../../contracts/messaging/provider-reply.js';
import {
  injectedUserMessage,
  positionOf,
  recordedRequestTurn,
  responseTurnId,
  chronological,
  projectTimeline,
  type TimelineTurns
} from '../../../../contracts/chronology.js';
import { continuationMarkerOf, workSequence, type SessionEvent, type ToolEditReview } from '../../../../contracts/session.js';
import type { sessionEventQueriesRuntime } from './store.js';

type Runtime = typeof sessionEventQueriesRuntime;

// Owns semantic session-history reads for turn recovery, completion, and browser activity.
export function createSessionEventQueries(runtime: Runtime) {
  const {
    assertSessionId,
    flushSession,
    readAuthoritativeSummary,
    readRecentEventsFromDisk,
    ensureOpen,
    enqueueSessionOperation,
    getOpenSession,
    isCurrentOpenSession,
    getSession,
    readOverflowText,
    readAsset,
    maxEventTail: MAX_EVENT_TAIL,
    messageKey
  } = runtime;
// The latest authored question. A recovery source excludes its injected corrections, which have no native user bubble and cannot grant another error reload.
async function readLatestUserMessage(sessionId: string, _turnId?: string | null): Promise<Extract<SessionEvent, { kind: 'user_message' }> | undefined> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  const summary = await readAuthoritativeSummary(sessionId);
  const [message] = await readRecentEventsFromDisk(sessionId, 1, { kinds: ['user_message'], orderByOrigin: true,
    before: Number.POSITIVE_INFINITY, acceptEvent: (event: SessionEvent) => !injectedUserMessage(event, summary?.timelineTurns) });
  return message?.kind === 'user_message' ? message : undefined;
}

/** An injected instruction belongs to its existing generation, even after native reconciliation. */
function isTurnCorrection(event: SessionEvent, turnId?: string | null, turns?: TimelineTurns): boolean {
  return injectedUserMessage(event, turns) && !!turnId && !!event.turnId &&
    responseTurnId(turns, event.turnId) === responseTurnId(turns, turnId);
}

// Latest lifecycle boundary for one recovery source. Injected same-turn instructions do not replace it; a new question, another turn, or a stop still does. Message revisions retain their authored position so replaying an old question cannot cancel current work.
async function readRecoveryBoundary(sessionId: string, turnId?: string | null): Promise<SessionEvent | undefined> {
  const entry = await ensureOpen(sessionId);
  await flushSession(sessionId);
  // Read under this session's existing queue. Another read or metadata flush must not invalidate the boundary and permanently spend a valid silence grant.
  return enqueueSessionOperation(entry, 'recovery boundary read', async () => {
    const [boundary] = await readRecentEventsFromDisk(sessionId, 1, {
      kinds: ['turn_start', 'turn_end', 'user_message'], orderByOrigin: true,
      before: Number.POSITIVE_INFINITY,
      acceptEvent: event => !isTurnCorrection(event, turnId, entry.summary.timelineTurns)
    });
    return boundary;
  });
}

// Canonical completion evidence shared by activity retirement and input eligibility. No turn is manufactured: an unowned reply must follow the latest recorded question. Committed history and binding changes invalidate the snapshot. Unrelated reads replacing a queue promise do not make a known final into an unfinished response.
async function readCompletedFinal(sessionId: string, conversationId: string, turnId?: string | null): Promise<{
  messageId: string; turnId: string | null; completedAt: number; contentSeq: number; text: string;
} | null> {
  const entry = await ensureOpen(sessionId);
  await flushSession(sessionId);
  const revision = entry.nextSeq;
  if (entry.summary.conversationId !== conversationId) return null;
  const [recent, questions] = await Promise.all([
    readRecentEventsFromDisk(sessionId, 256, { kinds: ['turn_start', 'turn_end', 'user_message', 'assistant_message', 'native_image', 'tool_call', 'page_tool'] }),
    readRecentEventsFromDisk(sessionId, 1, { kinds: ['user_message'], orderByOrigin: true,
      before: Infinity, acceptEvent: event => !injectedUserMessage(event, entry.summary.timelineTurns) })
  ]);
  if (entry.nextSeq !== revision || entry.summary.conversationId !== conversationId) return null;
  const sameTurn = (left: string | null | undefined, right: string | null | undefined) => !!left && !!right &&
    responseTurnId(entry.summary.timelineTurns, left) === responseTurnId(entry.summary.timelineTurns, right);
  // Pixels/media alone are not completion. Require the provider's exact terminal message on a completed lifecycle boundary and its matching recorded image. These facts may arrive in either batch; never manufacture assistant prose.
  const imageEnd = (event: SessionEvent) => event.kind === 'turn_end' && event.outcome === 'completed' &&
    !!event.providerMessageId && !!event.turnId && (!turnId || sameTurn(event.turnId, turnId)) &&
    recent.some(image => image.kind === 'native_image' && image.messageId === event.providerMessageId &&
      image.providerStatus === 'finished_successfully' && sameTurn(image.turnId, event.turnId));
  const final = recent.findLast(event => imageEnd(event) || (event.kind === 'assistant_message' && event.final === true &&
    (!!event.message.text.trim() || !!event.providerMessageId) && !!event.messageId && (!turnId || event.turnId === turnId ||
      (!!event.providerMessageId && sameTurn(event.turnId, turnId)) ||
      (turnId.startsWith('reply:') && event.messageId === turnId.slice(6)))));
  if (!final || (final.kind !== 'assistant_message' && final.kind !== 'turn_end')) return null;
  const messageId = final.kind === 'turn_end' ? final.providerMessageId : final.messageId;
  if (!messageId) return null;
  const seq = final.kind === 'turn_end' ? positionOf(final) : final.finalContentSeq ?? positionOf(final);
  const completedAt = final.kind === 'turn_end' ? final.time : final.finalObservedAt ?? final.time;
  const question = questions[0];
  const correction = (event: SessionEvent) => isTurnCorrection(event, final.turnId, entry.summary.timelineTurns) && positionOf(event) < seq;
  // A repeated question after the answer is not new work; a new request has a new id.
  const ownQuestion = final.turnId ? entry.summary.timelineTurns?.[final.turnId]?.questionId : undefined;
  const nativeFinal = final.kind === 'turn_end' || (final.final === true && !!final.providerMessageId);
  if (question && positionOf(question) >= positionOf(final) && !correction(question)) return null;
  // With no generation identity, require an actual preceding authored boundary.
  if (!final.turnId && (!question || question.time > final.time)) return null;
  if (entry.summary.activeTurnId && !sameTurn(entry.summary.activeTurnId, final.turnId)) return null;
  const boundaries = recent.filter(event => event.kind === 'turn_start' || event.kind === 'turn_end').sort((a, b) => a.seq - b.seq);
  const last = boundaries.at(-1), prior = boundaries.at(-2);
  const nativeReopen = !!final.providerMessageId && last?.kind === 'turn_start' && last.source === 'app' &&
    last.turnId === final.turnId && prior?.kind === 'turn_end' && prior.turnId === final.turnId && prior.outcome === 'completed';
  if (recent.some(event => {
    if (event === final || workSequence(event) <= seq) return false;
    if (event.kind === 'tool_call') {
      if (event.time <= completedAt) return false;
      // A public native final settles its request even when Pro delivers another connector call afterwards. Require proof recorded BEFORE that final; a new request or conflicting generation is fresh work, not a trailing result.
      const owner = event.source === 'mcp' && event.call.attribution === 'request_id'
        ? recordedRequestTurn(entry.summary.requestTurns, event.call.requestId, conversationId) : undefined;
      return !(final.providerMessageId && (final.kind === 'turn_end' || final.state === 'final') && owner && owner.origin < seq &&
        sameTurn(owner.turnId, final.turnId) && event.call.conversationId === conversationId &&
        (!event.turnId || sameTurn(event.turnId, final.turnId)));
    }
    // A final provider response ends a turn even if the page marked it stalled.
    if (event.kind === 'turn_end') return !sameTurn(event.turnId, final.turnId) ||
      (event.outcome !== 'completed' && !(event.outcome === 'stalled' && nativeFinal));
    // A quick answer is not new work just because its send receipt arrived late.
    if (event.kind === 'turn_start') return !(nativeReopen && event === last) &&
      !(event.source !== 'app' && !!final.turnId && event.turnId === final.turnId &&
        entry.summary.timelineTurns?.[final.turnId]?.origin === positionOf(event));
    if (event.kind === 'user_message') return !correction(event) && !(ownQuestion && event.messageId === ownQuestion);
    return event.kind === 'assistant_message' || event.kind === 'page_tool';
  })) return null;
  return { messageId, turnId: final.turnId ?? null, completedAt, contentSeq: seq,
    text: final.kind === 'turn_end' ? '' : cleanProviderReply(final.message.text) };
}

// The recorder matches an authored Compact & Resume request to one completed local generation before marking it complete.
async function readHandoffResponse(sessionId: string, conversationId: string, anchorMessageId: string, token: string): Promise<
  { status: 'complete'; text: string; messageId: string } | { status: 'pending' | 'ambiguous' }
> {
  const pending = { status: 'pending' } as const, ambiguous = { status: 'ambiguous' } as const;
  const entry = await ensureOpen(sessionId);
  await flushSession(sessionId);
  const revision = entry.nextSeq;
  if (entry.summary.conversationId !== conversationId) return pending;
  const anchor = entry.messages.get(`user_message\u0000${anchorMessageId}`);
  const marker = anchor?.kind === 'user_message' ? continuationMarkerOf(anchor.message.text) : null;
  if (!anchor || marker?.kind !== 'HANDOFF' || marker.token !== token) return pending;
  const events = await readRecentEventsFromDisk(sessionId, MAX_EVENT_TAIL, {
    kinds: ['turn_start', 'turn_end', 'user_message', 'assistant_message'], after: positionOf(anchor), orderByOrigin: true
  });
  if (entry.nextSeq !== revision || events.length >= MAX_EVENT_TAIL) return pending;
  const turns = entry.summary.timelineTurns;
  const next = events.findIndex(event => event.kind === 'user_message' && !injectedUserMessage(event, turns));
  const interval = next < 0 ? events : events.slice(0, next);
  const generations = new Set<string>();
  for (const event of interval) {
    if (event.kind === 'user_message') continue;
    if (event.turnId) generations.add(responseTurnId(turns, event.turnId));
    else if (event.kind !== 'assistant_message' || event.final) return ambiguous;
  }
  if (generations.size > 1) return ambiguous;
  const [generation] = generations;
  const boundary = interval.filter(event => event.kind === 'turn_start' || event.kind === 'turn_end').at(-1);
  if (!generation || boundary?.kind !== 'turn_end' || boundary.outcome !== 'completed') return pending;
  const finals = interval.filter((event): event is Extract<SessionEvent, { kind: 'assistant_message' }> =>
    event.kind === 'assistant_message' && event.final === true && !!event.messageId && !!event.message.text.trim());
  if (finals.length > 1) return ambiguous;
  const final = finals[0];
  if (!final) return pending;
  const text = final.message.truncated
    ? final.message.assetId ? await readOverflowText(sessionId, final.message.assetId) : null
    : final.message.text;
  return text?.trim() ? { status: 'complete', text, messageId: final.messageId! } : pending;
}

/** Recorded local execution, not a native tool label or a request-id sighting alone. */
async function turnHasMcpCall(sessionId: string, conversationId: string, turnId: string): Promise<boolean> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  // Attribution repair appends historical calls, often without a known turn. Such a tail cannot erase earlier exact proof. Filter inside one bounded-buffer reverse scan so a missing proof does not repeatedly rescan the journal for each presentation page.
  const calls = await readRecentEventsFromDisk(sessionId, 1, {
    kinds: ['tool_call'], before: Number.POSITIVE_INFINITY,
    acceptEvent: call => call.kind === 'tool_call' && call.turnId === turnId && call.source === 'mcp' &&
      call.call?.conversationId === conversationId && call.call.attribution === 'request_id'
  });
  return calls.length > 0;
}

/** Exact durable ownership proof for a context-limited worker's unresolved pre-silence turn. */
async function requestBelongsToActiveTurn(
  sessionId: string,
  conversationId: string,
  requestId: string,
  expectedTurnId: string,
  requestOriginMax: number
): Promise<boolean> {
  const summary = await getSession(sessionId);
  if (!summary || summary.conversationId !== conversationId || !summary.activeTurnId) return false;
  const owner = recordedRequestTurn(summary.requestTurns, requestId, conversationId);
  if (!owner || owner.origin > requestOriginMax) return false;
  const expected = responseTurnId(summary.timelineTurns, expectedTurnId);
  return responseTurnId(summary.timelineTurns, owner.turnId) === expected &&
    responseTurnId(summary.timelineTurns, summary.activeTurnId) === expected;
}

/** Durable journal boundary used to distinguish pre-park request ownership from later attribution. */
async function requestTurnOwnershipCutoff(
  sessionId: string,
  conversationId: string
): Promise<number | null> {
  const entry = await ensureOpen(sessionId);
  await flushSession(sessionId);
  if (entry.summary.conversationId !== conversationId) return null;
  return Math.max(0, entry.nextSeq - 1);
}

/** Durable terminal boundary for one exact response, with false-end reopening kept authoritative. */
async function turnEndedDurably(
  sessionId: string,
  conversationId: string,
  expectedTurnId: string
): Promise<boolean> {
  const entry = await ensureOpen(sessionId);
  await flushSession(sessionId);
  if (entry.summary.conversationId !== conversationId) return false;
  const sameTurn = (turnId: string | null | undefined): boolean =>
    !!turnId && responseTurnId(entry.summary.timelineTurns, turnId) ===
      responseTurnId(entry.summary.timelineTurns, expectedTurnId);
  // A late exact call can reopen a page-reported end. While that response is active again, the historical end is not terminal authority for a parked ceiling worker.
  if (sameTurn(entry.summary.activeTurnId)) return false;
  const recent = await readRecentEventsFromDisk(sessionId, 256, {
    kinds: ['turn_start', 'turn_end', 'user_message', 'assistant_message', 'tool_call', 'page_tool']
  });
  const latest = recent.at(-1);
  // The terminal boundary must itself still be the newest durable work. This rejects an old replayed end when a newer response exists but never published a local turn_start.
  return Boolean(latest?.kind === 'turn_end' && sameTurn(latest.turnId));
}

// Recorded local execution by any turn that answered the same question as `turnId`. A reload can reopen a question as a new local turn with no work of its own — measured 2026-09-26, three such turns followed a prime whose real turn had run tools for an hour — and judging only the newest turn refused that chat's automatic restart as "no confirmed local tool call". The question the turns share is what the restart continues.
async function questionHasMcpCall(sessionId: string, conversationId: string, turnId: string): Promise<boolean> {
  if (await turnHasMcpCall(sessionId, conversationId, turnId)) return true;
  const turns = (await getSession(sessionId))?.timelineTurns ?? {};
  const question = turns[turnId]?.questionId;
  if (!question) return false;
  const siblings = new Set(Object.entries(turns).filter(([id, turn]) => id !== turnId && turn.questionId === question).map(([id]) => id));
  if (!siblings.size) return false;
  const calls = await readRecentEventsFromDisk(sessionId, 1, {
    kinds: ['tool_call'], before: Number.POSITIVE_INFINITY,
    acceptEvent: call => call.kind === 'tool_call' && !!call.turnId && siblings.has(call.turnId) && call.source === 'mcp' &&
      call.call?.conversationId === conversationId && call.call.attribution === 'request_id'
  });
  return calls.length > 0;
}

/** Late exact attribution can prove chat health without pretending historical work is new. */
async function conversationHasMcpCallSince(
  sessionId: string, conversationId: string, startedAt: number, turnId: string | null
): Promise<boolean> {
  assertSessionId(sessionId);
  await flushSession(sessionId);
  const calls = await readRecentEventsFromDisk(sessionId, 1, {
    kinds: ['tool_call'], before: Number.POSITIVE_INFINITY,
    // Repaired calls may lack a local turn id. Exact conversation and original call time still prove attribution; an explicitly different turn does not.
    acceptEvent: event => event.kind === 'tool_call' && event.source === 'mcp' && event.time >= startedAt &&
      (!event.turnId || event.turnId === turnId) && event.call?.conversationId === conversationId &&
      event.call.attribution === 'request_id'
  });
  return calls.length > 0;
}

// Browser projection joins committed writes without forcing the debounced metadata to disk. A cold store hydrates one bounded journal tail. Thereafter the existing append/message owners maintain it, including revisions whose origin is older than the browser cursor.
async function readActivityEvents(sessionId: string, since: number, limit = 1200): Promise<{
  events: SessionEvent[]; reset: boolean; resumeBoundary: number;
  openingUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null;
  resumeUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null;
}> {
  const entry = await ensureOpen(sessionId);
  return enqueueSessionOperation(entry, 'activity read', async () => {
    if (!entry.activityHydrated) {
      const recent = await readRecentEventsFromDisk(sessionId, MAX_EVENT_TAIL);
      entry.tail = recent.filter((event) => !(messageKey(event) && entry.messages.has(messageKey(event)!)));
      // Old canonical messages do not prove that intervening journal rows fitted inside the byte budget. Only the retained journal suffix establishes cursor coverage.
      entry.tailFrom = entry.tail.reduce((first, event) => Math.min(first, event.seq), entry.nextSeq);
      entry.activityHydrated = true;
    }
    const cap = Math.max(1, Math.min(MAX_EVENT_TAIL, Math.floor(limit)));
    const cursor = Number.isFinite(since) ? Math.max(0, since) : 0;
    const candidates = [...entry.tail, ...entry.messages.values()].sort((a, b) => a.seq - b.seq);
    const reset = cursor < entry.tailFrom && !(cursor === 0 && entry.tailFrom === 1);
    const selected = reset || cursor === 0
      ? candidates.slice(-cap)
      : candidates.filter((event) => event.seq >= cursor).slice(0, cap);
    // All canonical messages remain authoritative after tail eviction and message revision.
    let openingUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null = null;
    let resumeUserMessage: Extract<SessionEvent, { kind: 'user_message' }> | null = null;
    for (const event of candidates) {
      if (event.kind !== 'user_message') continue;
      const position = event.origin ?? event.seq;
      if (!openingUserMessage || position < (openingUserMessage.origin ?? openingUserMessage.seq)) openingUserMessage = event;
      if (continuationMarkerOf(event.message.text)?.kind === 'RESUME' &&
          (!resumeUserMessage || position > (resumeUserMessage.origin ?? resumeUserMessage.seq))) resumeUserMessage = event;
    }
    const resumeBoundary = resumeUserMessage ? resumeUserMessage.origin ?? resumeUserMessage.seq : 0;
    return { events: chronological(projectTimeline(selected, entry.summary.timelineTurns, entry.summary.requestTurns, entry.messages.values())), reset: reset || (cursor === 0 && candidates.length > cap), resumeBoundary,
      openingUserMessage, resumeUserMessage };
  });
}

// Reads one exact tool record that the browser's bounded activity projection has already hydrated. This is deliberately not a history lookup: opening a disclosure must never open a session, scan its journal, or resolve an overflow asset independently of `/activity`.
async function readHydratedActivityCall(
  sessionId: string,
  conversationId: string,
  callId: string,
  detailRevision: number
): Promise<Extract<SessionEvent, { kind: 'tool_call' }> | null> {
  const entry = getOpenSession(sessionId);
  if (!entry || !entry.activityHydrated || entry.summary.conversationId !== conversationId) return null;
  return enqueueSessionOperation(entry, 'activity call detail', async () => {
    // The entry may have been closed/replaced while this read waited behind an accepted write.
    if (!isCurrentOpenSession(sessionId, entry) || !entry.activityHydrated || entry.summary.conversationId !== conversationId) return null;
    const exact = (event: SessionEvent | undefined): event is Extract<SessionEvent, { kind: 'tool_call' }> =>
      event?.kind === 'tool_call' &&
      event.seq === detailRevision &&
      event.call.callId === callId &&
      event.call.conversationId === conversationId;

    // Canonical background-process revisions supersede every ordinary copy. A stale requested revision therefore fails closed here instead of falling back to the launch in `tail`.
    const canonical = entry.messages.get(`tool_call\u0000${callId}`);
    if (canonical) return exact(canonical) ? canonical : null;

    // `tail` is already the bounded in-memory suffix owned by readActivityEvents(). Its public ordering is chronology/origin based, so choose the greatest canonical revision explicitly.
    const newest = entry.tail.reduce<Extract<SessionEvent, { kind: 'tool_call' }> | null>((held, event) =>
      event.kind === 'tool_call' && event.call.callId === callId && (!held || event.seq > held.seq) ? event : held, null);
    return newest && exact(newest) ? newest : null;
  });
}

/** Retrieves one immutable, bounded edit artifact by its durable session/call/index identity. */
async function readToolEditReview(sessionId: string, callId: string, changeIndex: number): Promise<ToolEditReview | null> {
  assertSessionId(sessionId);
  if (!/^[0-9a-f-]{36}$/i.test(callId) || !Number.isSafeInteger(changeIndex) || changeIndex < 0 || changeIndex >= 64) return null;
  await flushSession(sessionId);
  const [event] = await readRecentEventsFromDisk(sessionId, 1, {
    kinds: ['tool_call'], before: Number.POSITIVE_INFINITY,
    acceptEvent: value => value.kind === 'tool_call' && value.call.callId === callId
  });
  if (event?.kind !== 'tool_call' || event.call.callId !== callId) return null;
  const change = event.call.changes?.[changeIndex];
  if (!change?.reviewAssetId) return null;
  const data = await readAsset(sessionId, change.reviewAssetId, 512 * 1024);
  if (!data) return null;
  try {
    const parsed = JSON.parse(data.toString('utf8')) as { before?: unknown; after?: unknown };
    if (typeof parsed.before !== 'string' || typeof parsed.after !== 'string') return null;
    return { callId, changeIndex, path: change.path, added: change.added, removed: change.removed,
      baseText: parsed.before, currentText: parsed.after };
  } catch { return null; }
}

  return {
    readLatestUserMessage,
    readRecoveryBoundary,
    readCompletedFinal,
    readHandoffResponse,
    turnHasMcpCall,
    requestBelongsToActiveTurn,
    requestTurnOwnershipCutoff,
    turnEndedDurably,
    questionHasMcpCall,
    conversationHasMcpCallSince,
    readActivityEvents,
    readHydratedActivityCall,
    readToolEditReview
  };
}
