import { continuationByToken, describe, expect, it, pair, readEvents, request, SAMPLE_BRIEF, sessionStoreModule } from '../../test-context.js';

describe('capturing a sent handoff from the recorder', () => {
  async function sentHandoff(conversationId: string): Promise<{ token: string; sessionId: string; anchor: string }> {
    await request('POST', '/events', {
      body: { conversationId, events: [{ kind: 'user_message', time: Date.now(), text: 'build the site', messageId: `m-${conversationId}` }] }
    });
    const filed = await request('POST', '/compact', { body: { conversationId } });
    const token = filed.body.token as string;
    expect(token).toBeTruthy();
    expect((await request('POST', '/compact', { body: { conversationId, token, sourceAttempt: true } })).body.allowed).toBe(true);
    expect((await request('POST', '/compact', { body: { conversationId, token, sourceDispatch: true } })).body.armed).toBe(true);
    const anchor = `handoff-${conversationId}`;
    await request('POST', '/events', {
      body: { conversationId, events: [{ kind: 'user_message', time: Date.now(), text: `[[NEURAFLOK-HANDOFF:${token}]]\n\nwrite the brief`, messageId: anchor }] }
    });
    return { token, sessionId: continuationByToken(token)!.sessionId, anchor };
  }

  /** One local generation: a streaming id that the remount replaced, then its final and end. */
  const generation = (turnId: string, finalId: string, text: string) => [
    { kind: 'turn_start', time: Date.now(), turnId },
    { kind: 'assistant_message', time: Date.now(), turnId, messageId: `${turnId}-streaming`, text: text.slice(0, 40), state: 'streaming', final: false },
    { kind: 'assistant_message', time: Date.now(), turnId, messageId: finalId, text, state: 'final', final: true },
    { kind: 'turn_end', time: Date.now(), turnId, outcome: 'completed' }
  ];

  it('captures a completed handoff whose streaming and final assistant ids differ after remount', async () => {
    await pair();
    const conversationId = 'c0c0c0c0-7870-4000-8000-000000000001';
    const { token, sessionId, anchor } = await sentHandoff(conversationId);
    const brief = `carry on\n\n${SAMPLE_BRIEF}`;
    await request('POST', '/events', { body: { conversationId, events: generation('handoff-turn', 'assistant-final', brief) } });

    const bound = await request('POST', '/compact', { body: { conversationId, token, sourceMessageId: anchor } });
    expect(bound.status).toBe(200);
    expect(bound.body).toMatchObject({ bound: true, stored: true });
    expect(continuationByToken(token)?.state).not.toBe('awaiting-summary');
    const handoffId = continuationByToken(token)?.handoffId;
    expect(handoffId).toBeTruthy();
    expect((await sessionStoreModule.readHandoff(sessionId, handoffId!))?.text).toContain('carry on');
  });

  it('keeps over 120 KB of a final handoff through recording and capture', async () => {
    await pair();
    const conversationId = 'c0c0c0c0-7870-4000-8000-000000000005';
    const { token, sessionId, anchor } = await sentHandoff(conversationId);
    const brief = `TASK: Synthetic large handoff\n${'Do not lose any step. '.repeat(7_000)}\nEND_OF_BRIEF`;
    expect(brief.length).toBeGreaterThan(120_000);
    const recorded = await request('POST', '/events', { body: { conversationId, events: [
      { kind: 'turn_start', time: Date.now(), turnId: 'long-handoff-turn' },
      { kind: 'assistant_message', time: Date.now(), turnId: 'long-handoff-turn', messageId: 'long-handoff-final',
        text: brief, state: 'final', final: true },
      { kind: 'turn_end', time: Date.now(), turnId: 'long-handoff-turn', outcome: 'completed' }
    ] } });
    expect(recorded.status).toBe(200);
    const event = (await readEvents(sessionId, { kinds: ['assistant_message'] })).find(
      row => row.kind === 'assistant_message' && row.messageId === 'long-handoff-final');
    expect(event?.kind).toBe('assistant_message');
    if (!event || event.kind !== 'assistant_message') throw new Error('The long final was not recorded');
    expect(event.message.truncated).toBe(false);
    expect(event.message.text).toBe(brief);

    const bound = await request('POST', '/compact', { body: { conversationId, token, sourceMessageId: anchor } });
    expect(bound.status).toBe(200);
    expect(bound.body.stored).toBe(true);
    const handoffId = continuationByToken(token)?.handoffId;
    expect(handoffId).toBeTruthy();
    const saved = await sessionStoreModule.readHandoff(sessionId, handoffId!);
    // The handoff formatter bounds long briefs while preserving their final actions.
    expect(saved?.text).toContain('TASK: Synthetic large handoff');
    expect(saved?.text).toContain('… the middle of this brief was longer');
    expect(saved?.text.length).toBeLessThanOrEqual(96_000);
    expect(saved?.text.endsWith('END_OF_BRIEF')).toBe(true);
  });

  it('refuses a later Retry final that reused the same handoff user message', async () => {
    await pair();
    const conversationId = 'c0c0c0c0-7870-4000-8000-000000000002';
    const { token, anchor } = await sentHandoff(conversationId);
    await request('POST', '/events', { body: { conversationId, events: [
      ...generation('handoff-turn', 'assistant-first', `first answer\n\n${SAMPLE_BRIEF}`),
      ...generation('retry-turn', 'assistant-retry', `retried answer\n\n${SAMPLE_BRIEF}`)
    ] } });

    const bound = await request('POST', '/compact', { body: { conversationId, token, sourceMessageId: anchor } });
    expect(bound.status).toBe(200);
    expect(bound.body.stored).toBeUndefined();
    expect(continuationByToken(token)).toMatchObject({ state: 'awaiting-summary', handoffId: null });
  });
});
