import {
  appendEvent,
  createSession,
  decision,
  defaultConfig,
  delta,
  goal,
  prompts,
  referenceTranscript,
  saveConfig,
  settled,
  stream,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

/** A chat with a specific goal is the same engine pointed the other way. The ordinary loop defaults to silence, because in a normal chat the request is whatever the user last typed and inventing more of it is the failure mode. A goal inverts that: the user named the finish line up front and handed the wheel over, so the loop keeps talking until the line is crossed — including, uniquely, when nothing has been said yet at all. */
describe('a chat driven towards a specific goal', () => {
  /** The system messages one request was actually built from, in order. */
  function capture(): { seen: { role: string; content: string }[] } {
    const box = { seen: [] as { role: string; content: string }[] };
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
      box.seen = body.messages;
      return decision('continue', 'the migration is still missing. add it and run the suite');
    }) as never;
    return box;
  }

  it('swaps the continuation gate for the goal, and puts the goal itself in the prompt', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-1' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'start on the port', truncated: false, chars: 17 }
    });
    goal.setGoalObjective('c-obj-1', 'port the whole module to typescript and make the suite green');
    const box = capture();

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-1', turnId: 'g-obj-1' });
    const view = await settled('c-obj-1');

    expect(view.stage).toBe('ready');
    const system = box.seen.filter((message) => message.role === 'system').map((message) => message.content);
    expect(system[0]).toBe(prompts.DEFAULT_GOAL_OBJECTIVE_SYSTEM_PROMPT);
    expect(system[1]).toContain('port the whole module to typescript and make the suite green');
    // The standing instruction is the *other* mode's, and sending both would give the model one prompt telling it where to read the goal from and another telling it there is none.
    expect(system).not.toContain(prompts.DEFAULT_GOAL_SYSTEM_PROMPT);
    // The conversation is still last among the non-system messages, with the goal-flavoured closing reminder after it rather than the gate's.
    expect(referenceTranscript(box.seen)).toEqual([
      { role: 'user', content: 'start on the port' }
    ]);
    expect(box.seen.at(-1)!.content).toBe(prompts.GOAL_OBJECTIVE_TRAILER);
  });

  /** The one case the gate refuses outright. `no_conversation` exists because a half-recovered recording can hold assistant prose with no user row behind it, and asking a model to continue that is asking it to invent the request. A goal *is* the request, written down before the chat existed, so the same emptiness means the opposite thing. */
  it('writes the first message of a chat that has said nothing yet', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-empty' });
    goal.setGoalObjective('c-obj-empty', 'get the release out');
    const box = capture();

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-empty', turnId: 'g-obj-empty' });
    const view = await settled('c-obj-empty');

    expect(view.stage).toBe('ready');
    expect(view.error).toBeNull();
    expect(referenceTranscript(box.seen)).toEqual([
      { role: 'user', content: prompts.GOAL_OBJECTIVE_OPENING_TURN }
    ]);
  });

  it('refuses the same empty conversation when there is no goal to supply the request', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-none' });
    globalThis.fetch = (async () => decision('continue', 'should never be asked')) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-none', turnId: 'g-obj-none' });
    const view = await settled('c-obj-none');

    expect(view.stage).toBe('failed');
    expect(view.error).toBe('no_conversation');
  });

  it('keeps the saved objective when one Goal run says it is reached', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-done' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'ship it', truncated: false, chars: 7 }
    });
    goal.setGoalObjective('c-obj-done', 'get the release out');
    globalThis.fetch = (async () => decision('stop')) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-done', turnId: 'g-obj-done' });
    const view = await settled('c-obj-done');

    expect(view.stage).toBe('no-reply');
    expect(goal.goalObjectiveFor('c-obj-done')).toBe('get the release out');
  });

  it('restores chat-specific objectives after restart without creating a draft', () => {
    goal.setGoalObjective('c-obj-restored', 'keep the overnight build green');
    const saved = goal.snapshotGoalObjectives();
    goal.resetGoalStateForTests();

    goal.restoreGoalObjectives(saved);

    expect(goal.goalObjectiveFor('c-obj-restored')).toBe('keep the overnight build green');
    expect(goal.goalViewFor('c-obj-restored')).toBeNull();
  });

  it('deduplicates Goal obligations by stable assistant reply across reload turn ids', async () => {
    await goal.acceptGoalReplyNow({
      conversationId: 'c-reply-stable',
      sessionId: 'session-reply-stable',
      replyId: 'assistant-message-stable',
      turnId: 'g-before-reload',
      eventSeq: 12,
      blocked: false
    });
    await goal.acceptGoalReplyNow({
      conversationId: 'c-reply-stable',
      sessionId: 'session-reply-stable',
      replyId: 'assistant-message-stable',
      turnId: 'g-after-reload',
      eventSeq: 99,
      blocked: false
    });

    expect(goal.goalPendingReplyFor('c-reply-stable')).toEqual({
      replyId: 'assistant-message-stable',
      turnId: 'g-before-reload',
      eventSeq: 12,
      acceptedAt: expect.any(Number)
    });
  });

  it.each([false, true])('preserves pending source debt across settings invalidation and restart (master Off: %s)', async off => {
    const conversationId = 'settings-pending-source';
    const session = await createSession({ title: 'Goal settings', conversationId });
    await appendEvent(session.id, { source: 'extension', kind: 'user_message', time: Date.now(),
      message: { text: 'Finish the original task', chars: 24, truncated: false } });
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'turn:source-turn',
      turnId: 'source-turn', eventSeq: 0, blocked: false });
    const original = goal.goalPendingReplyFor(conversationId);
    expect(original).not.toBeNull();
    globalThis.fetch = (async () => decision('continue', 'Finish the remaining task')) as never;
    const first = goal.startGoalDraft({ conversationId, sessionId: session.id, turnId: 'source-turn' });
    await settled(conversationId);
    goal.retireGoalDrafts(off);
    expect(goal.ackGoalDraft(conversationId, first.token)).toBe(false);
    goal.restoreGoalReplies(goal.snapshotGoalReplies());
    expect(goal.goalPendingReplyFor(conversationId)).toEqual(off ? null : original);
    if (!off) {
      const next = goal.startGoalDraft({ conversationId, sessionId: session.id, turnId: 'source-turn' });
      expect(next.token).not.toBe(first.token);
      expect((await settled(conversationId)).stage).toBe('ready');
    }
  });

  it('rejects zero-sequence restore records without an exact provisional turn identity', () => {
    goal.restoreGoalReplies({ version: 1, savedAt: Date.now(), replies: [{
      conversationId: 'invalid-provisional', sessionId: 'session', replyId: 'unproved-final',
      turnId: 'source-turn', eventSeq: 0, acceptedAt: Date.now(), state: 'pending'
    }] });
    expect(goal.goalPendingReplyFor('invalid-provisional')).toBeNull();
  });

  it('persists the three-reload Goal pickup stop and refuses a fourth attempt after restore', async () => {
    const conversationId = 'goal-pickup-bound';
    const session = await createSession({ title: 'Bounded Goal pickup', conversationId });
    const acceptedAt = Date.now();
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'goal-reply-bound',
      turnId: 'goal-turn-bound', eventSeq: 42, blocked: false });

    expect(await goal.recordGoalPickupAttemptNow(conversationId, 'goal-reply-bound', acceptedAt + 120_000, acceptedAt + 420_000))
      .toEqual({ attempts: 1, nextAt: acceptedAt + 420_000 });
    expect(await goal.recordGoalPickupAttemptNow(conversationId, 'goal-reply-bound', acceptedAt + 420_000, acceptedAt + 1_020_000))
      .toEqual({ attempts: 2, nextAt: acceptedAt + 1_020_000 });
    expect(await goal.recordGoalPickupAttemptNow(conversationId, 'goal-reply-bound', acceptedAt + 1_020_000, acceptedAt + 1_920_000))
      .toEqual({ attempts: 3, stoppedAt: acceptedAt + 1_020_000 });

    const saved = goal.snapshotGoalReplies();
    goal.resetGoalStateForTests();
    goal.restoreGoalReplies(saved);
    expect(goal.goalPendingReplyFor(conversationId)).toMatchObject({ pickupAttempts: 3, pickupStoppedAt: acceptedAt + 1_020_000 });
    expect(await goal.recordGoalPickupAttemptNow(conversationId, 'goal-reply-bound', acceptedAt + 1_920_000)).toBeNull();
  });

  it('upgrades a decided provisional turn to the stable reply without reopening it', async () => {
    const conversationId = 'c-reply-provisional-upgrade';
    const turnId = 'g-reply-provisional-upgrade';
    const session = await createSession({ title: 'goal', conversationId });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'finish the work', truncated: false, chars: 15 }
    });
    await goal.acceptGoalReplyNow({
      conversationId,
      sessionId: session.id,
      replyId: `turn:${turnId}`,
      turnId,
      eventSeq: 0,
      blocked: false
    });
    globalThis.fetch = (async () => decision('stop')) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId, turnId });
    const decided = await settled(conversationId);
    expect(decided.stage).toBe('no-reply');
    expect(goal.ackGoalDraft(conversationId, decided.token)).toBe(true);
    goal.restoreGoalReplies(goal.snapshotGoalReplies());
    expect(goal.snapshotGoalReplies().replies).toContainEqual(expect.objectContaining({ conversationId, state: 'handled', eventSeq: 0 }));

    // Fiber can publish the stable assistant id after the provider decision. It strengthens the tombstone's identity; it does not turn the already-decided message back into work.
    await goal.acceptGoalReplyNow({
      conversationId,
      sessionId: session.id,
      replyId: 'assistant-stable-provisional-upgrade',
      turnId,
      eventSeq: 12,
      blocked: false
    });
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(goal.snapshotGoalReplies().replies).toContainEqual(
      expect.objectContaining({
        replyId: 'assistant-stable-provisional-upgrade',
        turnId,
        eventSeq: 12,
        state: 'handled'
      })
    );
  });

  it('restores an accepted pending reply after app restart', async () => {
    await goal.acceptGoalReplyNow({
      conversationId: 'c-reply-restored',
      sessionId: 'session-reply-restored',
      replyId: 'assistant-message-restored',
      turnId: 'g-reply-restored',
      eventSeq: 7,
      blocked: false
    });
    const saved = goal.snapshotGoalReplies();
    goal.resetGoalStateForTests();
    goal.restoreGoalReplies(saved);

    expect(goal.goalPendingReplyFor('c-reply-restored')).toMatchObject({
      replyId: 'assistant-message-restored',
      turnId: 'g-reply-restored'
    });
  });

  it('stores a handled tombstone when Goal was off at terminal acceptance', async () => {
    await saveConfig({
      ...defaultConfig(),
      goal: { ...defaultConfig().goal, backend: 'api', loopBackend: 'api', enabled: false }
    });
    await goal.acceptGoalReplyNow({
      conversationId: 'c-reply-disabled',
      sessionId: 'session-reply-disabled',
      replyId: 'assistant-message-disabled',
      turnId: 'g-reply-disabled',
      eventSeq: 4,
      blocked: false
    });

    expect(goal.goalPendingReplyFor('c-reply-disabled')).toBeNull();
    expect(goal.snapshotGoalReplies().replies).toContainEqual(
      expect.objectContaining({ replyId: 'assistant-message-disabled', state: 'handled' })
    );
  });

  it.each(['none', 'page-only', 'other-turn', 'unattributed', 'exact'] as const)('requires exact recorded MCP for automatic Loop, while explicit On may proceed (%s)', async proof => {
    const conversationId = `automatic-loop-proof-${proof}`;
    const session = await createSession({ conversationId });
    await goal.setGoalSwitchNow(conversationId, 'loop', true);
    await appendEvent(session.id, { source: 'extension', time: 1000, kind: 'user_message', message: { text: 'Continue the task', chars: 17, truncated: false } });
    await appendEvent(session.id, { source: 'extension', time: 1100, kind: 'turn_start', turnId: 'source-turn' });
    if (proof === 'page-only') await appendEvent(session.id, { source: 'extension', time: 1200, kind: 'page_tool', turnId: 'source-turn', messageId: 'page-read', label: 'Called read' });
    if (['other-turn', 'unattributed', 'exact'].includes(proof)) await appendEvent(session.id, {
      source: 'mcp', time: 1300, kind: 'tool_call', turnId: proof === 'other-turn' ? 'older-turn' : 'source-turn', call: {
        callId: 'proof-call', tool: 'read', attribution: proof === 'unattributed' ? 'unattributed' : 'request_id',
        requestId: proof === 'unattributed' ? null : 'proof-request', conversationId: proof === 'unattributed' ? null : conversationId,
        attributionMethod: 'request_id', outcome: 'ok', durationMs: 1,
        args: { text: '{}', chars: 2, truncated: false }, result: { text: 'ok', chars: 2, truncated: false },
        summary: { kind: 'read', tone: 'neutral', title: 'Read' }
      }
    });
    await appendEvent(session.id, { source: 'extension', time: 1400, kind: 'turn_end', turnId: 'source-turn', outcome: 'completed' });
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'source-final', turnId: 'source-turn', eventSeq: 100, blocked: false });
    expect(goal.goalPendingReplyFor(conversationId) !== null).toBe(proof === 'exact');
    const fetch = vi.fn(async () => decision('continue', 'Continue the task'));
    globalThis.fetch = fetch;
    expect(await goal.draftFastFollowup(session.id)).toBe(proof === 'exact' ? 'Continue the task' : null);
    expect(fetch).toHaveBeenCalledTimes(proof === 'exact' ? 1 : 0);
    const legacy = goal.snapshotGoalReplies();
    legacy.replies.find(row => row.conversationId === conversationId)!.state = 'pending';
    goal.restoreGoalReplies(legacy);
    expect(await goal.loopReplyHasAuthority(session.id, conversationId, 'source-turn')).toBe(proof === 'exact');
    await goal.setGoalReplyActiveNow(conversationId, false);
    await goal.setGoalReplyActiveNow(conversationId, true);
    expect(goal.goalPendingReplyFor(conversationId)?.replyId).toBe('source-final');
    goal.restoreGoalReplies(goal.snapshotGoalReplies());
    expect(await goal.loopReplyHasAuthority(session.id, conversationId, 'source-turn')).toBe(true);
  });

  it('durably cancels a pending ticket on Off and re-arms that stable final on On', async () => {
    const conversationId = 'c-reply-switch-rearm';
    await goal.acceptGoalReplyNow({
      conversationId,
      sessionId: 'session-reply-switch-rearm',
      replyId: 'assistant-message-switch-rearm',
      turnId: 'g-switch-rearm',
      eventSeq: 14,
      blocked: false
    });
    expect(goal.goalPendingReplyFor(conversationId)).toMatchObject({
      replyId: 'assistant-message-switch-rearm'
    });
    const firstPickupAt = goal.goalPendingReplyFor(conversationId)!.acceptedAt;

    expect(await goal.setGoalReplyActiveNow(conversationId, false)).toBe(true);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    const off = goal.snapshotGoalReplies();
    expect(off.replies).toContainEqual(
      expect.objectContaining({ conversationId, replyId: 'assistant-message-switch-rearm', state: 'handled' })
    );

    // Model the reload boundary: Off is in the durable ledger, not only in the old page.
    goal.resetGoalStateForTests();
    goal.restoreGoalReplies(off);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();

    expect(await goal.setGoalReplyActiveNow(conversationId, true)).toBe(true);
    expect(goal.goalPendingReplyFor(conversationId)).toMatchObject({
      replyId: 'assistant-message-switch-rearm',
      turnId: 'g-switch-rearm'
    });
    expect(goal.goalPendingReplyFor(conversationId)!.acceptedAt).toBeGreaterThan(firstPickupAt);
  });

  it.each(['already-working', 'work-arrived-during-read'])('does not re-arm a handled reply when activation is %s', async scenario => {
    const conversationId = `c-activation-${scenario}`;
    await goal.acceptGoalReplyNow({ conversationId, sessionId: `session-${scenario}`, replyId: 'old-final', turnId: 'old-turn', eventSeq: 14, blocked: false });
    await goal.setGoalReplyActiveNow(conversationId, false);
    const before = goal.snapshotGoalReplies().replies.find(row => row.conversationId === conversationId);
    const current = vi.fn().mockReturnValue(false);
    if (scenario === 'work-arrived-during-read') current.mockReturnValueOnce(true);
    expect(await goal.setGoalReplyActiveNow(conversationId, true, current)).toBe(false);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
    expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === conversationId)).toEqual(before);
    expect(current).toHaveBeenCalledTimes(scenario === 'already-working' ? 1 : 2);
  });

  it.each(['user_message', 'turn_start'] as const)('does not re-arm an older final across a newer %s without active metadata', async kind => {
    const conversationId = `activation-boundary-${kind}`;
    const session = await createSession({ conversationId });
    await goal.acceptGoalReplyNow({ conversationId, sessionId: session.id, replyId: 'older-final', turnId: 'older-turn', eventSeq: 1, blocked: false });
    await goal.setGoalReplyActiveNow(conversationId, false);
    await appendEvent(session.id, { time: Date.now(), source: 'extension', turnId: 'new-turn',
      ...(kind === 'user_message' ? { kind, message: { text: 'new request', chars: 11, truncated: false } } : { kind }) });
    expect(await goal.setGoalReplyActiveNow(conversationId, true)).toBe(false);
    expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
  });

  it('keeps an expired ticket as the stable-final tombstone a later On can re-arm', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-01T08:00:00Z'));
      const conversationId = 'c-reply-expired-rearm';
      await goal.acceptGoalReplyNow({
        conversationId,
        sessionId: 'session-reply-expired-rearm',
        replyId: 'assistant-message-expired-rearm',
        turnId: 'g-expired-rearm',
        eventSeq: 15,
        blocked: false
      });
      expect(await goal.setGoalReplyActiveNow(conversationId, false)).toBe(true);

      vi.advanceTimersByTime(13 * 60 * 60_000);
      expect(goal.goalPendingReplyFor(conversationId)).toBeNull();
      // Exercise the normal snapshot/prune boundary that previously deleted the only exact identity an explicit later activation could safely pick up.
      expect(goal.snapshotGoalReplies().replies).toContainEqual(
        expect.objectContaining({ conversationId, state: 'handled' })
      );

      expect(await goal.setGoalReplyActiveNow(conversationId, true)).toBe(true);
      expect(goal.goalPendingReplyFor(conversationId)).toMatchObject({
        replyId: 'assistant-message-expired-rearm',
        turnId: 'g-expired-rearm'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /** The obligation outlives every way of failing to answer it. The ledger row says one exact turn is owed a decision. Only a decision discharges it — a message the page typed, or NO_REPLY. A dropped stream, a rejected key, an exhausted balance and a clock running out are all this app failing to produce one, and recording a failure to answer as an answer is how a turn ended up silently owed nothing. */
  it('keeps the reply obligation pending through a retryable draft failure', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-owed-after-failure' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });
    await goal.acceptGoalReplyNow({
      conversationId: 'c-owed-after-failure',
      sessionId: session.id,
      replyId: 'assistant-owed-after-failure',
      turnId: 'g-owed-failure',
      eventSeq: 3,
      blocked: false
    });
    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-owed-after-failure', turnId: 'g-owed-failure' });
    const failure = await settled('c-owed-after-failure');
    expect(failure.stage).toBe('failed');
    expect(goal.ackGoalDraft('c-owed-after-failure', failure.token)).toBe(true);

    expect(goal.goalPendingReplyFor('c-owed-after-failure')).toMatchObject({
      replyId: 'assistant-owed-after-failure',
      turnId: 'g-owed-failure'
    });
  });

  it('keeps the reply obligation pending through a settings failure the page will not retry', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-owed-after-settings' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });
    await goal.acceptGoalReplyNow({
      conversationId: 'c-owed-after-settings',
      sessionId: session.id,
      replyId: 'assistant-owed-after-settings',
      turnId: 'g-owed-settings',
      eventSeq: 5,
      blocked: false
    });
    globalThis.fetch = (async () => new Response('{}', { status: 402 })) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-owed-after-settings', turnId: 'g-owed-settings' });
    const failure = await settled('c-owed-after-settings');
    expect(failure.retryable).toBe(false);
    expect(goal.ackGoalDraft('c-owed-after-settings', failure.token)).toBe(true);

    // The user fixing their balance must find the turn it was owed for still owed.
    expect(goal.goalPendingReplyFor('c-owed-after-settings')).toMatchObject({
      turnId: 'g-owed-settings'
    });
  });

  it('keeps the reply obligation pending when the draft payload ages past its ten-minute TTL', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-owed-after-ttl' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });
    await goal.acceptGoalReplyNow({
      conversationId: 'c-owed-after-ttl',
      sessionId: session.id,
      replyId: 'assistant-owed-after-ttl',
      turnId: 'g-owed-ttl',
      eventSeq: 9,
      blocked: false
    });
    globalThis.fetch = (async () => stream([delta('one last correction'), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-owed-after-ttl', turnId: 'g-owed-ttl' });
    expect((await settled('c-owed-after-ttl')).stage).toBe('ready');

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
    try {
      // Reading the view is what runs the payload expiry. It may drop the text; it may not decide, on a clock, that a turn nobody answered has been answered.
      expect(goal.goalViewFor('c-owed-after-ttl')).toBeNull();
      expect(goal.goalPendingReplyFor('c-owed-after-ttl')).toMatchObject({ turnId: 'g-owed-ttl' });
    } finally {
      clock.mockRestore();
    }
  });

  it('discharges the reply obligation only once the page acknowledges a real decision', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-owed-until-typed' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'keep going', truncated: false, chars: 10 }
    });
    await goal.acceptGoalReplyNow({
      conversationId: 'c-owed-until-typed',
      sessionId: session.id,
      replyId: 'assistant-owed-until-typed',
      turnId: 'g-owed-typed',
      eventSeq: 11,
      blocked: false
    });
    globalThis.fetch = (async () => stream([delta('one last correction'), 'data: [DONE]\n'])) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-owed-until-typed', turnId: 'g-owed-typed' });
    const ready = await settled('c-owed-until-typed');
    expect(ready.stage).toBe('ready');
    // Still owed while the page holds the message but has not written it.
    expect(goal.goalPendingReplyFor('c-owed-until-typed')).toMatchObject({ turnId: 'g-owed-typed' });

    expect(goal.ackGoalDraft('c-owed-until-typed', ready.token)).toBe(true);
    expect(goal.goalPendingReplyFor('c-owed-until-typed')).toBeNull();
  });

  /** A chat with no answer of its own follows the app's, and one with an answer keeps it. That inheritance is the whole design. Nothing anyone has ever opened changes behaviour on upgrade, the app-wide switch stays the default every new chat starts from, and a chat that has been told "not you" cannot be talked back into it by a later change somewhere else. */
  it('lets one chat answer the Goal switch for itself, and leaves the rest inheriting', async () => {
    expect(goal.goalSwitchFor('c-switch-quiet')).toEqual({ enabled: true, mode: 'goal', own: false, afterTurn: false });

    expect(await goal.setGoalSwitchNow('c-switch-loud', 'loop', true)).toEqual({ enabled: true, mode: 'loop' });
    expect(goal.goalSwitchFor('c-switch-loud')).toEqual({ enabled: true, mode: 'loop', own: true, afterTurn: false });
    expect(goal.goalDrivingMode('c-switch-loud')).toBe('loop');
    // Its neighbour, and the app-wide setting the neighbour still follows, are untouched.
    expect(goal.goalSwitchFor('c-switch-quiet')).toEqual({ enabled: true, mode: 'goal', own: false, afterTurn: false });
    expect(goal.goalDrivingMode('c-switch-quiet')).toBe('goal');

    // Turning off the mode that is *not* running changes nothing, exactly as the app-wide switch behaves: the two controls are one setting, and only the running one can be shut.
    expect(await goal.setGoalSwitchNow('c-switch-loud', 'goal', false)).toEqual({ enabled: true, mode: 'loop' });
    expect(await goal.setGoalSwitchNow('c-switch-loud', 'loop', false)).toEqual({ enabled: false, mode: 'loop' });
    // Off stays off here while every other chat carries on — the thing the app-wide switch could never do, and the way an old chat is retired when it pops up again.
    expect(goal.goalSwitchEnabledFor('c-switch-loud')).toBe(false);
    expect(goal.goalSwitchEnabledFor('c-switch-quiet')).toBe(true);

    // Mode survives being switched off, so turning Loop back on gives Loop back.
    expect(await goal.setGoalSwitchNow('c-switch-loud', 'loop', true)).toEqual({ enabled: true, mode: 'loop' });
  });

  it('carries one chat\'s switch across a snapshot, a restore and a resume', async () => {
    await goal.setGoalSwitchNow('c-switch-parent', 'loop', true);
    const saved = goal.snapshotGoalSwitches();
    goal.restoreGoalSwitches(null);
    expect(goal.goalSwitchFor('c-switch-parent').own).toBe(false);

    goal.restoreGoalSwitches(saved);
    expect(goal.goalSwitchFor('c-switch-parent')).toEqual({ enabled: true, mode: 'loop', own: true, afterTurn: false });

    // Compact & Resume replaces the conversation and the loop goes on running in its replacement; leaving the override behind would hand chat B back to the app-wide setting.
    expect(goal.moveGoalSwitch('c-switch-parent', 'c-switch-child')).toBe(true);
    expect(goal.goalSwitchFor('c-switch-parent').own).toBe(false);
    expect(goal.goalSwitchFor('c-switch-child')).toEqual({ enabled: true, mode: 'loop', own: true, afterTurn: false });

    // The app's own switch going off is the master stop and reaches every override there is.
    goal.clearAllGoalSwitches();
    expect(goal.goalSwitchFor('c-switch-child').own).toBe(false);
  });

  /** The Off half of the same carry, which is the half that only started meaning anything once a chat's own switch outranked its saved goal. Compact & Resume is the one place a chat changes identity, and both halves of what the user chose have to arrive in the replacement: the sentence, and the answer to whether it is running. An Off left behind would hand chat B back to the app-wide setting with the goal still written down — which is the exact state that reads as on. */
  it('carries a chosen Off, and its goal, into the chat that replaces it', async () => {
    await goal.setGoalSwitchNow('c-off-parent', 'goal', false);
    goal.setGoalObjective('c-off-parent', 'port the module');
    expect(goal.goalSwitchFor('c-off-parent')).toMatchObject({ enabled: false, own: true });
    expect(goal.goalArmedFor('c-off-parent')).toBe(false);

    expect(goal.moveGoalObjective('c-off-parent', 'c-off-child')).toBe(true);
    expect(goal.moveGoalSwitch('c-off-parent', 'c-off-child')).toBe(true);

    // Still stopped, still carrying the sentence it was stopped on, and still this chat's own answer rather than the app-wide one.
    expect(goal.goalSwitchFor('c-off-child')).toMatchObject({ enabled: false, own: true });
    expect(goal.goalObjectiveFor('c-off-child')).toBe('port the module');
    expect(goal.goalArmedFor('c-off-child')).toBe(false);

    // And starting it again in the replacement picks the same goal back up, unretyped.
    await goal.setGoalSwitchNow('c-off-child', 'loop', true);
    expect(goal.goalArmedFor('c-off-child')).toBe(true);
    expect(goal.goalObjectiveFor('c-off-child')).toBe('port the module');
  });

  it('moves the same objective to the replacement chat on resume', () => {
    goal.setGoalObjective('c-obj-parent', 'finish the release unattended');

    expect(goal.moveGoalObjective('c-obj-parent', 'c-obj-child')).toBe(true);
    expect(goal.goalObjectiveFor('c-obj-parent')).toBe('');
    expect(goal.goalObjectiveFor('c-obj-child')).toBe('finish the release unattended');
  });

  /** A goal is a brief somebody writes, and it used to be cut at 4,000 characters — silently, because the sheet reported back what was stored and the reader had no reason to count. A long brief is now stored whole; the request that carries it is bounded by the same body limit as every other route, which is a transport rule rather than a rule about what a goal may say. */
  it('trims what it stores, keeps a long brief whole, and reports back what it stored', () => {
    expect(goal.setGoalObjective('c-obj-trim', '   finish the docs   ')).toBe('finish the docs');
    expect(goal.goalObjectiveFor('c-obj-trim')).toBe('finish the docs');
    expect(goal.setGoalObjective('c-obj-trim', 'x'.repeat(9_000))).toHaveLength(9_000);
    expect(goal.goalObjectiveFor('c-obj-trim')).toHaveLength(9_000);
    expect(goal.setGoalObjective('c-obj-trim', '  ')).toBe('');
    expect(goal.goalObjectiveFor('c-obj-trim')).toBe('');
  });

  /** A draft is frozen with the goal it was started under, so replacing the goal has to reach the request already in flight — otherwise the last thing typed into the chat is a message written against the goal the user just replaced. */
  it('retires the draft in flight when the goal changes', async () => {
    const session = await createSession({ title: 'goal', conversationId: 'c-obj-swap' });
    await appendEvent(session.id, {
      time: 1_000,
      source: 'extension',
      kind: 'user_message',
      message: { text: 'go', truncated: false, chars: 2 }
    });
    globalThis.fetch = (async () => new Promise<Response>(() => undefined)) as never;

    goal.startGoalDraft({ sessionId: session.id, conversationId: 'c-obj-swap', turnId: 'g-obj-swap' });
    expect(goal.goalViewFor('c-obj-swap')).not.toBeNull();
    expect(goal.retireGoalDraftsFor('c-obj-swap')).toBe(true);
    expect(goal.goalViewFor('c-obj-swap')).toBeNull();
    // …and only that chat's, and only once.
    expect(goal.retireGoalDraftsFor('c-obj-swap')).toBe(false);
  });
});
