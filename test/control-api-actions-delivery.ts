import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CHAT, appendEvent, call, chatSession, input, makeSession, post, row, seed, sendBody, startInput, text, toolCall, validConversationId, wake } from './control-api-actions-context.js';

describe('what a message row proves', () => {
  const OLD = 20 * 60_000;

  it('never resends a message whose Send may have happened, and a late receipt turns it into sent', async () => {
    const started = Date.now() - OLD;
    const ambiguous = row({ text: 'was it sent?', state: 'browser', owner: 'page', conversationId: CHAT, createdAt: started,
      offeredAt: started, requiresAuthorization: true, sendAuthorizedAt: started + 1000 });
    await seed([ambiguous]);

    // Reading the outbox retires a send that never got a receipt; the row is then unknown, not failed.
    const listed = await call('GET', '/v1/inputs');
    expect(listed.body.inputs[0]).toMatchObject({ id: ambiguous.id, state: 'cancelled', delivery: 'unconfirmed' });
    expect(listed.body.inputs[0].error).toContain('will not be resent');

    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const retry = await post('/v1/inputs', { id: ambiguous.id, sessionId: chatSession, text: 'was it sent?' });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ replayed: true, input: { delivery: 'unconfirmed' } });
      expect(sends).not.toHaveBeenCalled();
    } finally {
      sends.mockRestore();
    }
    expect(wake()).not.toHaveBeenCalled();

    // The page confirms later: the same row now carries the receipt, and only then is it sent.
    expect(await input.acknowledgeBrowserInput(ambiguous.id, 'page', CHAT, 'native-late')).toBe(true);
    const confirmed = (await call('GET', '/v1/inputs')).body.inputs[0];
    expect(confirmed).toMatchObject({ id: ambiguous.id, delivery: 'sent', messageId: 'native-late' });
    expect(wake()).not.toHaveBeenCalled();
  });

  it('takes a final or a repeated question elsewhere in the chat for nothing', async () => {
    const prooflessConversation = validConversationId('chat-foreign');
    const proofless = await makeSession('Foreign final', prooflessConversation);
    const started = Date.now() - 60_000;
    const unknown = row({ sessionId: proofless, text: 'Run the checks', state: 'browser', owner: 'page', conversationId: prooflessConversation,
      createdAt: started, offeredAt: started, requiresAuthorization: true, sendAuthorizedAt: started + 500 });
    await seed([unknown]);
    // The same words and another answer's final land in that chat, inside the range of the turn.
    await appendEvent(proofless, { kind: 'user_message', source: 'extension', time: started + 1000, messageId: 'someone-else', message: { text: 'Run the checks', truncated: false, chars: 14 } });
    await appendEvent(proofless, { kind: 'turn_start', source: 'extension', time: started + 1100, turnId: 'other-turn' });
    await appendEvent(proofless, { kind: 'assistant_message', source: 'extension', time: started + 2000, messageId: 'other-final', turnId: 'other-turn', final: true, message: { text: 'Done, all green.', truncated: false, chars: 16 } });
    await appendEvent(proofless, { kind: 'turn_end', source: 'extension', time: started + 2100, outcome: 'completed', turnId: 'other-turn' });

    const listed = (await call('GET', '/v1/inputs')).body.inputs[0];
    expect(listed).toMatchObject({ id: unknown.id, delivery: 'unconfirmed', messageId: null, deliveredAt: null });
    // An outbox row carries no reply, and neither does anything an action returns.
    expect(JSON.stringify(listed)).not.toContain('all green');
    const cancelled = await post('/v1/inputs/' + unknown.id + '/cancel');
    expect(cancelled.body.input.delivery).toBe('unconfirmed');
    expect(cancelled.raw).not.toContain('all green');
  });

  it('keeps two chats that were sent the same words apart, each by its own receipt', async () => {
    const twinConversation = validConversationId('chat-twin');
    const other = await makeSession('Twin', twinConversation);
    const confirmed = row({ text: 'Same words', state: 'sent', owner: 'page', conversationId: CHAT, offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6, deliveredAt: 7, messageId: 'native-a', createdAt: 1 });
    const unsure = row({ sessionId: other, text: 'Same words', state: 'browser', owner: 'page-2', conversationId: twinConversation, createdAt: 2,
      offeredAt: Date.now(), requiresAuthorization: true, sendAuthorizedAt: Date.now() });
    await seed([confirmed, unsure]);
    const third = await makeSession('Third twin', 'chat-twin-3');
    const fresh = await post('/v1/inputs', sendBody({ sessionId: third, text: 'Same words' }));
    expect(fresh.status).toBe(202);

    const byId = new Map((await call('GET', '/v1/inputs')).body.inputs.map((entry: { id: string }) => [entry.id, entry]));
    expect(byId.get(confirmed.id)).toMatchObject({ delivery: 'sent', messageId: 'native-a' });
    expect(byId.get(unsure.id)).toMatchObject({ delivery: 'unconfirmed', messageId: null });
    expect(byId.get(fresh.body.input.id)).toMatchObject({ delivery: 'pending' });
    expect(byId.size).toBe(3);
  });

  it('settles an injected message only from the final of its own turn', async () => {
    const t0 = Date.now() - 20_000;
    const ownConversation = validConversationId('chat-inj-own');
    const foreignConversation = validConversationId('chat-inj-foreign');
    const own = await makeSession('Own turn', ownConversation);
    const foreign = await makeSession('Foreign turn', foreignConversation);
    const inject = (sessionId: string, conversationId: string, owner: string) =>
      row({ sessionId, conversationId, text: 'nudge', state: 'tool', owner, createdAt: t0, offeredAt: t0 + 2_000, toolTurnId: 'turn-own' });
    const rowOwn = inject(own, ownConversation, 'req-own');
    const rowForeign = inject(foreign, foreignConversation, 'req-foreign');
    await seed([rowOwn, rowForeign]);
    for (const [sessionId, conversationId, owner] of [[own, ownConversation, 'req-own'], [foreign, foreignConversation, 'req-foreign']] as const) {
      await appendEvent(sessionId, { kind: 'user_message', source: 'extension', time: t0, messageId: 'q-' + owner, message: text('Do the work') });
      await appendEvent(sessionId, { kind: 'turn_start', source: 'extension', time: t0 + 500, turnId: 'turn-own' });
      await appendEvent(sessionId, { kind: 'tool_call', source: 'mcp', time: t0 + 1_000, turnId: 'turn-own',
        call: toolCall({ requestId: owner, conversationId, attribution: 'request_id', callId: 'call-' + owner }) });
    }
    // In one chat the final belongs to the turn the message was injected into; in the other it belongs to a different turn that happens to sit later in the same journal.
    await appendEvent(own, { kind: 'assistant_message', source: 'extension', time: t0 + 5_000, messageId: 'final-own', turnId: 'turn-own', final: true, message: text('Done.') });
    await appendEvent(own, { kind: 'turn_end', source: 'extension', time: t0 + 5_100, outcome: 'completed', turnId: 'turn-own' });
    await appendEvent(foreign, { kind: 'turn_start', source: 'extension', time: t0 + 4_000, turnId: 'turn-other' });
    await appendEvent(foreign, { kind: 'assistant_message', source: 'extension', time: t0 + 5_000, messageId: 'final-other', turnId: 'turn-other', final: true, message: text('Done elsewhere.') });
    await appendEvent(foreign, { kind: 'turn_end', source: 'extension', time: t0 + 5_100, outcome: 'completed', turnId: 'turn-other' });

    const byId = new Map((await call('GET', '/v1/inputs')).body.inputs.map((entry: { id: string }) => [entry.id, entry]));
    expect(byId.get((rowOwn as { id: string }).id)).toMatchObject({ state: 'sent', delivery: 'sent', messageId: expect.stringMatching(/^input:/) });
    expect(byId.get((rowForeign as { id: string }).id)).toMatchObject({ state: 'tool', delivery: 'unconfirmed', messageId: null, deliveredAt: null });
  });

  it('tells the messages the app filed itself from the ones a person or agent sent', async () => {
    const recovery = row({ text: 'Keep working until the request is complete.', state: 'failed', error: 'After-turn pickup was withdrawn before Send.',
      requiresAuthorization: true, offeredAt: 5, recovery: { questionId: 'q1', pro: false, busyUntil: 0, phase: 'ready' } });
    // A silence boundary can ride a message a person typed, so it alone does not make a row automatic.
    const typed = row({ text: 'typed by a person', silenceBoundary: { turnId: 't1', conversationId: CHAT, workSeq: 1 } });
    await seed([recovery, typed]);
    const listed = new Map((await call('GET', '/v1/inputs')).body.inputs.map((entry: { id: string }) => [entry.id, entry]));
    expect(listed.get(recovery.id)).toMatchObject({ automatic: true, state: 'failed', delivery: 'not_sent' });
    expect(listed.get(typed.id)).toMatchObject({ automatic: false });
  });
});

describe('logging', () => {
  it('records that a message was admitted or cancelled, without its text', async () => {
    const { getLog } = await import('../backend/infrastructure/settings/logger.js');
    const secret = 'sk-proj-' + randomBytes(24).toString('hex');
    const sent = await post('/v1/inputs', sendBody({ text: 'Use ' + secret }));
    await post('/v1/inputs/' + sent.body.input.id + '/cancel');
    const lines = getLog().map((entry) => entry.message).filter((message) => message.includes(sent.body.input.id));
    expect(lines.some((message) => message.includes('admitted'))).toBe(true);
    expect(lines.some((message) => message.includes('cancelled'))).toBe(true);
    expect(lines.join('\n')).not.toContain(secret);
  });
});
