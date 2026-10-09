import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { answeringSession, appendEvent, call, chatSession, controlActions, controlApi, actionGate as gate, input, makeSession, observeSessionModel, outbox, post, providerBrowserState as providerBrowser, row, seed, sendBody, setChatBlocked, startInput, validConversationId, wake } from './control-api-actions-context.js';
import type { Reply } from './control-api-actions-context.js';

describe('sending', () => {
  it('admits a message to an existing chat through the desktop send path and reports only what the row proves', async () => {
    const id = randomUUID();
    const reply = await post('/v1/inputs', { id, sessionId: chatSession, text: '  Keep going, check the last commit.  ' });
    expect(reply.status).toBe(202);
    expect(reply.body.replayed).toBe(false);
    expect(reply.body.input).toMatchObject({
      id, sessionId: chatSession, state: 'queued', delivery: 'pending', mode: 'auto', automatic: false,
      text: { text: 'Keep going, check the last commit.', truncated: false }
    });
    for (const hidden of ['owner', 'deliveryText', 'toolImages', 'response', 'recovery', 'directTurn']) {
      expect(Object.keys(reply.body.input)).not.toContain(hidden);
    }

    // The same internal profile the composer uses opens the provider page; it stays hidden.
    await vi.waitFor(() => expect(providerBrowser.openProvider).toHaveBeenCalledTimes(1));
    expect(providerBrowser.openProvider).toHaveBeenCalledWith('deepseek', { reveal: false });
    expect(wake()).not.toHaveBeenCalled();

    const listed = (await call('GET', '/v1/inputs')).body.inputs.find((entry: { id: string }) => entry.id === id);
    expect(listed).toMatchObject({ id, delivery: 'pending', state: 'queued' });
    expect((await outbox()).filter((entry) => entry.id === id)).toHaveLength(1);
  });

  it('explains when the bound web provider is not signed in and admits no outbox row', async () => {
    providerBrowser.presence.deepseek = { open: false, signedIn: false, tabId: null, lastSeenAt: null };
    const reply = await post('/v1/inputs', sendBody());
    expect(reply.status).toBe(409);
    expect(reply.body.error).toBe('provider_not_connected');
    expect(reply.body.detail).toContain('DeepSeek');
    expect(await outbox()).toEqual([]);
    expect(providerBrowser.openProvider).not.toHaveBeenCalled();
  });

  it('answers a repeated id with the row that exists and never sends it again', async () => {
    const body = sendBody({ text: 'Only once' });
    const first = await post('/v1/inputs', body);
    expect(first.status).toBe(202);
    await vi.waitFor(() => expect(providerBrowser.openProvider).toHaveBeenCalledTimes(1));

    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const again = await post('/v1/inputs', body);
      expect(again.status).toBe(200);
      expect(again.body.replayed).toBe(true);
      expect(again.body.input.id).toBe(body.id);
      // A moment later the outbox's own dueAt would differ; the replay does not depend on it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await post('/v1/inputs', body)).status).toBe(200);
      expect(sends).not.toHaveBeenCalled();
      // The text is compared as the outbox stored it, without the padding it trimmed.
      const padded = await post('/v1/inputs', { ...body, text: '  Only once \n' });
      expect(padded.status).toBe(200);
      expect(padded.body.replayed).toBe(true);
      expect(sends).not.toHaveBeenCalled();
    } finally {
      sends.mockRestore();
    }
    expect((await outbox()).filter((entry) => entry.id === body.id)).toHaveLength(1);
    expect(providerBrowser.openProvider).toHaveBeenCalledTimes(1);

    const otherSession = await makeSession('Chat two', 'chat-actions-2');
    for (const different of [{ text: 'A different message' }, { sessionId: otherSession }]) {
      const conflict = await post('/v1/inputs', { ...body, ...different });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toBe('id_conflict');
    }

    // A planner row's id is not a message the caller can name.
    const planner = row({ purpose: 'decision', state: 'decision', text: 'Only once' });
    await seed([planner]);
    const named = await post('/v1/inputs', { id: planner.id, sessionId: chatSession, text: 'Only once' });
    expect(named.status).toBe(409);
    expect(named.body.error).toBe('id_conflict');
    await seed([]);
  });

  it('refuses a second message while one is still awaiting delivery', async () => {
    expect((await post('/v1/inputs', sendBody())).status).toBe(202);
    const second = await post('/v1/inputs', sendBody({ text: 'Another one' }));
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('busy');
    expect(await outbox()).toHaveLength(1);
  });

  it('refuses a chat it cannot or should not send to', async () => {
    const unknown = await post('/v1/inputs', sendBody({ sessionId: '2026-01-01-deadbeef' }));
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('session_not_found');

    const worker = await makeSession('Worker', 'chat-worker', { kind: 'worker', fromSessionId: chatSession, agentId: 'worker-1', task: 't' });
    const helper = await makeSession('Helper', 'chat-helper', { kind: 'helper', fromSessionId: chatSession, agentId: null, task: '' });
    for (const sessionId of [worker, helper]) {
      const reply = await post('/v1/inputs', sendBody({ sessionId }));
      expect(reply.status).toBe(409);
      expect(reply.body.error).toBe('session_not_controllable');
    }
    const unattached = await makeSession('No chat yet', null);
    const noChat = await post('/v1/inputs', sendBody({ sessionId: unattached }));
    expect(noChat.status).toBe(409);
    expect(noChat.body.error).toBe('no_chat');
    expect(await outbox()).toEqual([]);
    expect(wake()).not.toHaveBeenCalled();
  });

  it('queues a follow-up while a local provider is answering', async () => {
    const answering = await answeringSession('Answering', 'chat-answering', 'turn-live');
    const queued = await post('/v1/inputs', sendBody({ sessionId: answering }));
    expect(queued.status).toBe(202);
    // Local web/API executors never inject into or interrupt a live provider generation.
    expect((await outbox())[0]).toMatchObject({ mode: 'after-turn', afterTurn: true,
      queuedTurn: { turnId: 'turn-live' } });
    expect((await outbox())[0]).not.toHaveProperty('directTurn');
  });

  it('queues after-turn when a local provider starts answering just before admission', async () => {
    const lateConversation = validConversationId('chat-late');
    const late = await makeSession('Late turn', lateConversation);
    await observeSessionModel(late, lateConversation, 'deepseek-chat', Date.now());
    const real = startInput.sendDesktopInput;
    const sends = vi.spyOn(startInput, 'sendDesktopInput').mockImplementation(async (args) => {
      // The provider starts answering between the caller's check and the outbox's own.
      await appendEvent(late, { kind: 'turn_start', source: 'extension', time: Date.now(), turnId: 'turn-late' });
      return real(args);
    });
    try {
      const reply = await post('/v1/inputs', sendBody({ sessionId: late }));
      expect(reply.status).toBe(202);
      const rows = await outbox();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: 'queued', mode: 'after-turn', afterTurn: true,
        queuedTurn: { conversationId: lateConversation, turnId: 'turn-late' } });
      expect(wake()).not.toHaveBeenCalled();
    } finally {
      sends.mockRestore();
    }
  });

  it('answers an admission that outlives its deadline as unknown, and never runs one it turned away', async () => {
    controlApi.setActionLimitsForTests({ deadlineMs: 150 });
    const real = startInput.sendDesktopInput;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sends = vi.spyOn(startInput, 'sendDesktopInput').mockImplementation(async (args) => { await held; return real(args); });
    try {
      const slowSession = await makeSession('Slow', 'chat-slow');
      const slow = await post('/v1/inputs', sendBody({ sessionId: slowSession }));
      expect(slow.status).toBe(504);
      expect(slow.body.error).toBe('timeout');
      expect(slow.body.detail).toContain('GET /v1/inputs');
      // Actions run one at a time, so the next one waits behind it. It is turned away before it starts, and it is told so, because it will not run once the first one finishes.
      const queued = await post('/v1/inputs', sendBody());
      expect(queued.status).toBe(504);
      expect(queued.body.detail).toContain('will not run');
    } finally {
      release();
      sends.mockRestore();
    }
    await vi.waitFor(async () => expect(await outbox()).toHaveLength(1), { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await outbox()).map((entry) => entry.sessionId)).not.toContain(chatSession);
    controlApi.setActionLimitsForTests({});
    await seed([]);
    expect((await post('/v1/inputs', sendBody())).status).toBe(202);
  });

  it('turns away actions beyond the few allowed to wait', async () => {
    const real = startInput.sendDesktopInput;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sends = vi.spyOn(startInput, 'sendDesktopInput').mockImplementation(async (args) => { await held; return real(args); });
    try {
      const sessions = await Promise.all(Array.from({ length: 6 }, (_, index) => makeSession('Queue ' + index, 'chat-queue-' + index)));
      setTimeout(release, 400);
      const replies = await Promise.all(sessions.map((sessionId) => post('/v1/inputs', sendBody({ sessionId }))));
      expect(replies.map((reply) => reply.status).sort()).toEqual([202, 202, 202, 202, 503, 503]);
      expect(replies.find((reply) => reply.status === 503)!.body.error).toBe('busy');
    } finally {
      release();
      sends.mockRestore();
    }
  });

  it('checks the switch again when a queued action gets its turn', async () => {
    const real = startInput.sendDesktopInput;
    let release!: () => void, entered!: () => void, queued!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    const secondQueued = new Promise<void>((resolve) => { queued = resolve; });
    const queuedId = randomUUID();
    const sends = vi.spyOn(startInput, 'sendDesktopInput').mockImplementation(async (args) => { entered(); await held; return real(args); });
    const dispatched = vi.spyOn(controlActions, 'serveAction');
    const emit = http.Server.prototype.emit;
    const received = vi.spyOn(http.Server.prototype, 'emit').mockImplementation(function (this: http.Server, event: string | symbol, ...args: unknown[]) {
      const result = Reflect.apply(emit, this, [event, ...args]) as boolean;
      if (event === 'request') {
        const request = args[0] as http.IncomingMessage;
        if (request.headers['x-test-input-id'] === queuedId) {
          // The real readBody listener was installed by emit above. Its resolved continuation queues the action before this microtask, while the first action is still held.
          request.once('end', () => queueMicrotask(queued));
        }
      }
      return result;
    });
    const pending: Promise<Reply>[] = [];
    try {
      const other = await makeSession('Second in line', 'chat-second');
      const first = post('/v1/inputs', sendBody());
      pending.push(first);
      // Elapsed time does not prove that the first request passed the final permission gate.
      await Promise.race([firstEntered, first.then(reply => { throw new Error(`First action returned ${reply.status} before admission`); })]);
      const second = post('/v1/inputs', sendBody({ id: queuedId, sessionId: other }), { 'x-test-input-id': queuedId });
      pending.push(second);
      await Promise.race([secondQueued, second.then(reply => { throw new Error(`Queued action returned ${reply.status} before waiting`); })]);
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(sends).toHaveBeenCalledTimes(1);
      gate.actions = false;
      release();
      expect((await first).status).toBe(202);
      const refused = await second;
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: 'actions_disabled' });
      // A late check inside send() alone would still return 403, but the queued request must be refused before it reaches that dispatcher at all.
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect((await outbox()).map((entry) => entry.sessionId)).toEqual([chatSession]);
    } finally {
      release();
      await Promise.allSettled(pending);
      received.mockRestore();
      dispatched.mockRestore();
      sends.mockRestore();
    }
  });

  it('checks the switch once more just before the outbox, after the lookups that come first', async () => {
    const real = input.sessionInputPolicy;
    const policy = vi.spyOn(input, 'sessionInputPolicy').mockImplementationOnce(async (id, activity) => {
      // The user switches actions off while the caller's session is being looked at.
      gate.actions = false;
      return real(id, activity);
    });
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const reply = await post('/v1/inputs', sendBody());
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({ error: 'actions_disabled' });
      expect(sends).not.toHaveBeenCalled();
      expect(await outbox()).toEqual([]);
    } finally {
      policy.mockRestore();
      sends.mockRestore();
    }
  });

  it('needs the API switch as well as its own', async () => {
    gate.enabled = false;
    const refused = await post('/v1/inputs', sendBody());
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'actions_disabled' });
    expect((await call('GET', '/v1/health')).body.actions.enabled).toBe(false);
    expect(await outbox()).toEqual([]);
  });

  it('answers what the outbox refuses with a reason, and everything else with a bare 500', async () => {
    const sends = vi.spyOn(startInput, 'sendDesktopInput');
    try {
      const failWith = async (message: string) => {
        sends.mockRejectedValueOnce(new Error(message));
        const reply = await post('/v1/inputs', sendBody());
        return [reply.status, reply.body.error, reply.raw.includes(message)] as const;
      };
      expect(await failWith('The message queue is full')).toEqual([503, 'queue_full', false]);
      expect(await failWith('Input cancelled')).toEqual([409, 'cancelled', false]);
      expect(await failWith('Message id already belongs to different input')).toEqual([409, 'id_conflict', false]);
      expect(await failWith('Something private: C:\\Users\\someone\\secret.txt')).toEqual([500, 'internal_error', false]);
    } finally {
      sends.mockRestore();
    }
  });

  it('answers a send while the app is shutting down, and a chat that is blocked', async () => {
    startInput.stopInputStartup();
    try {
      const shutting = await post('/v1/inputs', sendBody());
      expect(shutting.status).toBe(503);
      expect(shutting.body.error).toBe('shutting_down');
    } finally {
      startInput.resetInputStartupForTests();
    }
    const blockedConversation = validConversationId('chat-blocked-1');
    const blockedSession = await makeSession('Blocked', blockedConversation);
    setChatBlocked(blockedConversation, true);
    try {
      const blocked = await post('/v1/inputs', sendBody({ sessionId: blockedSession }));
      expect(blocked.status).toBe(409);
      expect(blocked.body.error).toBe('chat_blocked');
    } finally {
      setChatBlocked(blockedConversation, false);
    }
    expect(await outbox()).toEqual([]);
  });

  it('runs two sends for different chats one after the other', async () => {
    const second = await makeSession('Chat three', 'chat-actions-3');
    const replies = await Promise.all([post('/v1/inputs', sendBody()), post('/v1/inputs', sendBody({ sessionId: second }))]);
    expect(replies.map((reply) => reply.status)).toEqual([202, 202]);
    expect(await outbox()).toHaveLength(2);
  });
});
