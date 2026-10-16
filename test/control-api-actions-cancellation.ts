import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CHAT, bridge, chatSession, createSession, input, makeSession, outbox, post, providerBrowserState as providerBrowser, row, seed, sendBody, startInput, wake } from './control-api-actions-context.js';

describe('cancelling', () => {
  it('withdraws a queued message and says it was not sent', async () => {
    const sent = await post('/v1/inputs', sendBody());
    const id = sent.body.input.id;
    const cancelled = await post('/v1/inputs/' + id + '/cancel');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.cancelled).toBe(true);
    expect(cancelled.body.input).toMatchObject({ id, state: 'cancelled', delivery: 'not_sent', cancelledByUser: true });

    const again = await post('/v1/inputs/' + id + '/cancel');
    expect(again.status).toBe(200);
    expect(again.body.cancelled).toBe(false);
    expect(again.body.input.delivery).toBe('not_sent');

    // Sending the same id afterwards names the cancelled row; it is not queued again.
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const replay = await post('/v1/inputs', { id, sessionId: chatSession, text: 'Keep going' });
      expect(replay.status).toBe(200);
      expect(replay.body.input.state).toBe('cancelled');
      expect(sends).not.toHaveBeenCalled();
    } finally {
      sends.mockRestore();
    }
  });

  it('refuses what has already been handed to ChatGPT, and reports it as sent', async () => {
    const delivered = row({ state: 'sent', owner: 'page', conversationId: CHAT, offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6, deliveredAt: 7, messageId: 'native-1' });
    const injected = row({ text: 'injected', state: 'tool', owner: 'req-1', conversationId: CHAT, offeredAt: 5, toolTurnId: 'turn-1' });
    await seed([delivered, injected]);
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput');
    try {
      const afterDelivery = await post('/v1/inputs/' + delivered.id + '/cancel');
      expect(afterDelivery.status).toBe(409);
      expect(afterDelivery.body.error).toBe('not_cancellable');
      expect(afterDelivery.body.input).toMatchObject({ state: 'sent', delivery: 'sent', messageId: 'native-1' });

      const afterOffer = await post('/v1/inputs/' + injected.id + '/cancel');
      expect(afterOffer.status).toBe(409);
      expect(afterOffer.body.input.delivery).toBe('unconfirmed');
      expect((await outbox()).map((entry) => entry.state).sort()).toEqual(['sent', 'tool']);
      // The outbox's cancel is not even asked about a message that is no longer cancellable.
      expect(cancels).not.toHaveBeenCalled();
    } finally {
      cancels.mockRestore();
    }
  });

  it('withdraws a message that was claimed before Send was authorized, and refuses one after', async () => {
    const claimed = row({ text: 'claimed', state: 'browser', owner: 'page', conversationId: CHAT, offeredAt: Date.now(), requiresAuthorization: true });
    const otherSession = await makeSession('Chat four', 'chat-actions-4');
    const authorized = row({ sessionId: otherSession, text: 'authorized', state: 'browser', owner: 'page-2', conversationId: 'chat-actions-4',
      offeredAt: Date.now(), requiresAuthorization: true, sendAuthorizedAt: Date.now() });
    await seed([claimed, authorized]);

    const before = await post('/v1/inputs/' + claimed.id + '/cancel');
    expect(before.status).toBe(200);
    expect(before.body.cancelled).toBe(true);
    expect(before.body.input).toMatchObject({ state: 'cancelled', delivery: 'not_sent' });
    expect(before.body.input.error).toContain('before Send was authorized');

    // Send was authorized: it may be in ChatGPT already, and cancelling would free the chat for a second copy of the same words. It is refused and left exactly as it is.
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput');
    try {
      const after = await post('/v1/inputs/' + authorized.id + '/cancel');
      expect(after.status).toBe(409);
      expect(after.body.error).toBe('not_cancellable');
      expect(after.body.detail).toContain('Send was authorized');
      expect(after.body.input).toMatchObject({ state: 'browser', delivery: 'unconfirmed' });
      expect(cancels).not.toHaveBeenCalled();
    } finally {
      cancels.mockRestore();
    }
    const sameChat = await post('/v1/inputs', { id: randomUUID(), sessionId: otherSession, text: 'authorized' });
    expect(sameChat.status).toBe(409);
    expect(sameChat.body.error).toBe('busy');
  });

  it('reports a cancel that lost a race with Send authorization as unconfirmed, not as cancelled', async () => {
    const browserConversation = 'chat-actions-browser';
    const browserSession = (await createSession({ title: 'Browser chat', conversationId: browserConversation })).id;
    const claimed = row({ sessionId: browserSession, state: 'browser', owner: 'page', conversationId: browserConversation, offeredAt: Date.now(), requiresAuthorization: true });
    await seed([claimed]);
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput').mockImplementation(async (id) => {
      // The page authorizes Send just before the outbox's own cancel runs.
      await input.authorizeBrowserInput(id, 'page', browserConversation);
      return input.cancelInput(id);
    });
    try {
      const reply = await post('/v1/inputs/' + claimed.id + '/cancel');
      expect(reply.status).toBe(409);
      expect(reply.body.error).toBe('delivery_unconfirmed');
      expect(reply.body.input).toMatchObject({ state: 'cancelled', delivery: 'unconfirmed' });
    } finally {
      cancels.mockRestore();
    }
  });

  it('leaves to the app whatever cancelling would do beyond the one message', async () => {
    const reserved = randomUUID();
    const opening = row({ id: reserved, sessionId: reserved, text: 'first message of a new chat', opening: true });
    const pairedSession = await makeSession('Paired', 'chat-paired');
    const first = row({ sessionId: pairedSession, text: 'one', conversationId: 'chat-paired' });
    const second = row({ sessionId: pairedSession, text: 'two', conversationId: 'chat-paired' });
    const workerSession = await makeSession('Worker', 'chat-worker-2', { kind: 'worker', fromSessionId: chatSession, agentId: 'worker-1', task: 't' });
    const workers = row({ sessionId: workerSession, text: 'for a worker', conversationId: 'chat-worker-2' });
    await seed([opening, { ...first, companionInputId: (second as { id: string }).id }, { ...second, companionInputId: (first as { id: string }).id }, workers]);
    const cancels = vi.spyOn(startInput, 'cancelDesktopInput');
    try {
      const refusals = await Promise.all([opening, first, second].map((entry) => post('/v1/inputs/' + (entry as { id: string }).id + '/cancel')));
      expect(refusals.map((reply) => reply.status)).toEqual([409, 409, 409]);
      expect(refusals.map((reply) => reply.body.error)).toEqual(['not_cancellable', 'not_cancellable', 'not_cancellable']);
      expect(refusals[0]!.body.detail).toContain('new chat');
      expect(refusals[1]!.body.detail).toContain('paired');
      const forWorker = await post('/v1/inputs/' + (workers as { id: string }).id + '/cancel');
      expect(forWorker.status).toBe(409);
      expect(forWorker.body.error).toBe('session_not_controllable');
      expect(cancels).not.toHaveBeenCalled();
    } finally {
      cancels.mockRestore();
    }
    const rows = await outbox();
    expect(rows.every((entry) => entry.state === 'queued')).toBe(true);
    // The reserved chat of the opening message is still there.
    const { getSession } = await import('../backend/domains/sessions/history/store.js');
    expect(await getSession(chatSession)).not.toBeNull();
  });

  it('is not Stop: withdrawing a message asks for no stop and creates no stop command', async () => {
    const sent = await post('/v1/inputs', sendBody());
    const stops = vi.spyOn(bridge, 'stopSessionTurn');
    const commands = bridge.pendingCommands().length;
    try {
      const cancelled = await post('/v1/inputs/' + sent.body.input.id + '/cancel');
      expect(cancelled.status).toBe(200);
      expect(stops).not.toHaveBeenCalled();
      expect(bridge.pendingCommands()).toHaveLength(commands);
    } finally {
      stops.mockRestore();
    }
  });

  it('stops a browser startup that is still in flight when its message is cancelled', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    providerBrowser.openProvider.mockImplementationOnce(async () => { await held; });
    const sent = await post('/v1/inputs', sendBody());
    expect(sent.status).toBe(202);
    await vi.waitFor(() => expect(providerBrowser.openProvider).toHaveBeenCalledOnce());
    const cancelled = await post('/v1/inputs/' + sent.body.input.id + '/cancel');
    expect(cancelled.body.cancelled).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(providerBrowser.run).not.toHaveBeenCalled();
    expect(wake()).not.toHaveBeenCalled();
  });

  it('is a 404 for an unknown message, a planner row, and a path that is not an id', async () => {
    const decision = row({ purpose: 'decision', state: 'decision', text: 'planner work' });
    await seed([decision]);
    for (const id of [randomUUID(), decision.id]) {
      const reply = await post('/v1/inputs/' + id + '/cancel');
      expect(reply.status).toBe(404);
      expect(reply.body.error).toBe('input_not_found');
    }
    for (const route of ['/v1/inputs/not-an-id/cancel', '/v1/inputs/' + randomUUID().toUpperCase() + '/cancel']) {
      expect((await post(route)).status, route).toBe(404);
    }
    // Not an action path at all, so a POST there is a wrong method, as it always was.
    expect((await post('/v1/inputs/a/b/cancel')).status).toBe(405);
    // The app retires a planner row by itself on load; what matters is that the API did not.
    expect((await outbox())[0]!.cancelledByUser).not.toBe(true);
  });
});
