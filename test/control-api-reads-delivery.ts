import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { agentsModule, apiKey, call, cancelInput, deliveryProof, enqueueInput, reads } from './control-api-reads-context.js';

describe('input outbox', () => {
  const entry = (over: object = {}) => ({
    id: randomUUID(), sessionId: null, text: 'hello', mode: 'auto', dueAt: 1, model: null, reasoningEffort: null,
    state: 'queued', owner: null, createdAt: 1, conversationId: null, ...over
  }) as never;

  it('lists queued messages with text cut and redacted and without delivery internals', async () => {
    const queued = await enqueueInput({
      id: randomUUID(),
      sessionId: null,
      text: `Deploy with ${apiKey} ${'y'.repeat(5_000)}`,
      mode: 'auto',
      dueAt: Date.now(),
      model: null,
      reasoningEffort: null
    });
    const all = await call('/v1/inputs');
    const row = all.body.inputs.find((input: { id: string }) => input.id === queued.id);
    expect(row).toBeDefined();
    expect(row.text.text).toHaveLength(4_000);
    expect(row.text).toMatchObject({ truncated: true });
    expect(row.text.chars).toBeGreaterThan(4_000);
    expect(JSON.stringify(all.body)).not.toContain(apiKey);
    expect(Object.keys(row).sort()).toEqual([
      'attachments', 'automatic', 'cancelledByUser', 'conversationId', 'createdAt', 'deliveredAt', 'deliveredSessionId', 'delivery',
      'dueAt', 'error', 'id', 'images', 'messageId', 'mode', 'model', 'offeredAt', 'purpose', 'queueOrder', 'reasoningEffort',
      'requiresAuthorization', 'sendAuthorizedAt', 'sessionId', 'state', 'text', 'transportIntent'
    ]);
    expect(row.delivery).toBe('pending');

    expect((await call(`/v1/inputs?state=${row.state}`)).body.inputs.map((input: { id: string }) => input.id)).toContain(queued.id);
    expect(await cancelInput(queued.id)).toBe(true);
    const cancelled = await call('/v1/inputs?state=cancelled');
    expect(cancelled.body.inputs.map((input: { id: string }) => input.id)).toContain(queued.id);
    expect(cancelled.body.inputs.every((input: { state: string }) => input.state === 'cancelled')).toBe(true);
    expect((await call(`/v1/inputs?state=${row.state === 'cancelled' ? 'failed' : row.state}`)).body.inputs.map((input: { id: string }) => input.id)).not.toContain(queued.id);
  });

  it('drops the fields an outbox row carries only for its own delivery', () => {
    const projected = reads.projectInput(entry({
      owner: 'request-id-secret', deliveryText: `wrapped ${apiKey}`, response: 'private', toolImages: [{ name: 'i', dataUrl: 'data:secret' }],
      attachments: [{ id: 'a', name: 'C:\\private\\file.txt' }], silenceBoundary: { turnId: 't' },
      recovery: { questionId: 'q-secret' }, directTurn: { id: 'd-secret' }, finishOwner: { turnId: 'f-secret' }
    }));
    const raw = JSON.stringify(projected);
    for (const hidden of ['wrapped', 'private', 'data:secret', 'silenceBoundary', 'request-id-secret', 'q-secret', 'd-secret', 'f-secret', 'owner']) {
      expect(raw).not.toContain(hidden);
    }
    expect(projected).toMatchObject({ attachments: 1, images: 0, state: 'queued', text: { text: 'hello', chars: 5, truncated: false } });
  });

  it('selects by state, hides decision rows and keeps the newest rows by creation time', () => {
    const rows = [
      entry({ id: 'a', createdAt: 5, state: 'queued', queueOrder: 0 }),
      entry({ id: 'b', createdAt: 1, state: 'sent', dueAt: 1 }),
      entry({ id: 'c', createdAt: 9, state: 'queued', dueAt: 1_790_000_000_000 }),
      entry({ id: 'd', createdAt: 7, state: 'decision', purpose: 'decision' }),
      entry({ id: 'e', createdAt: 3, state: 'cancelled' })
    ];
    const ids = (selected: { rows: Array<{ id: string }> }) => selected.rows.map((row) => row.id);
    expect(ids(reads.selectInputs(rows, { limit: 10 }))).toEqual(['b', 'e', 'a', 'c']);
    expect(reads.selectInputs(rows, { limit: 10 }).total).toBe(4);
    expect(ids(reads.selectInputs(rows, { state: ['queued'], limit: 10 }))).toEqual(['a', 'c']);
    // A reordered row (queueOrder 0) sorts first in the queue, but a small limit still keeps the newest.
    expect(ids(reads.selectInputs(rows, { limit: 2 }))).toEqual(['a', 'c']);
    expect(reads.selectInputs(rows, { limit: 2 }).total).toBe(4);
    expect(ids(reads.selectInputs(rows, { state: ['sent', 'cancelled'], limit: 10 }))).toEqual(['b', 'e']);
  });
});

describe('delivery proof', () => {
  const row = (over: object) => ({ id: randomUUID(), sessionId: 'abc12345', text: 'hi', mode: 'auto', dueAt: 1, model: null,
    reasoningEffort: null, state: 'queued', owner: null, createdAt: 1, conversationId: null, ...over }) as never;

  it.each([
    ['queued', { state: 'queued' }, 'pending'],
    ['a browser claim still awaiting authorization', { state: 'browser', offeredAt: 5, requiresAuthorization: true }, 'pending'],
    ['a browser claim whose Send was authorized', { state: 'browser', offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6 }, 'unconfirmed'],
    ['a legacy claim that never asked for authorization', { state: 'browser', offeredAt: 5 }, 'unconfirmed'],
    ['a tool result handed out and not yet settled', { state: 'tool', offeredAt: 5, owner: 'req-1' }, 'unconfirmed'],
    ['sent with a receipt', { state: 'sent', offeredAt: 5, sendAuthorizedAt: 6, deliveredAt: 7, messageId: 'm1' }, 'sent'],
    ['a row marked sent that holds no receipt', { state: 'sent' }, 'unconfirmed'],
    ['a row marked sent whose Send was authorized but holds no receipt', { state: 'sent', offeredAt: 5, sendAuthorizedAt: 6 }, 'unconfirmed'],
    ['a tool result settled by its exact request', { state: 'sent', offeredAt: 5, deliveredAt: 5, messageId: 'input:x' }, 'sent'],
    ['cancelled before Send was authorized', { state: 'cancelled', offeredAt: 5, requiresAuthorization: true, cancelledByUser: true }, 'not_sent'],
    ['cancelled while still queued', { state: 'cancelled', cancelledByUser: true }, 'not_sent'],
    ['failed before it was ever claimed', { state: 'failed', error: 'Not sent: the browser did not pick up this message.' }, 'not_sent'],
    ['retired after Send was authorized with no receipt', { state: 'cancelled', offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6,
      error: 'Stopped waiting for delivery confirmation. The message may already have been sent; it will not be resent.' }, 'unconfirmed'],
    ['cancelled locally after Send was authorized', { state: 'cancelled', offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6, cancelledByUser: true }, 'unconfirmed'],
    ['cancelled, then confirmed by a late receipt', { state: 'cancelled', offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6, deliveredAt: 9, messageId: 'm2' }, 'sent'],
    ['failed after Send was authorized', { state: 'failed', offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6 }, 'unconfirmed']
  ])('%s is %s', (_name, fields, expected) => {
    expect(deliveryProof(row(fields))).toBe(expected);
  });

  it('never takes a turn id on the row as proof that the message was delivered', () => {
    const withTurns = { state: 'failed', completedTurnId: 't1', queuedTurn: { conversationId: 'c', turnId: 't1' }, silenceBoundary: { turnId: 't1' }, directTurn: { id: 't1' },
      offeredAt: 5, requiresAuthorization: true, sendAuthorizedAt: 6 };
    expect(deliveryProof(row(withTurns))).toBe('unconfirmed');
    expect(deliveryProof(row({ ...withTurns, sendAuthorizedAt: undefined }))).toBe('not_sent');
  });

  it('marks a recovery pickup as filed by the app', () => {
    expect(reads.projectInput(row({ recovery: { questionId: 'q' } })).automatic).toBe(true);
    expect(reads.projectInput(row({})).automatic).toBe(false);
    // A silence boundary can ride a message a person typed, so it alone does not make a row automatic.
    expect(reads.projectInput(row({ silenceBoundary: { turnId: 't', conversationId: 'c', workSeq: 1 } })).automatic).toBe(false);
    expect(reads.projectInput(row({ finishOwner: { turnId: 't', periodic: false } })).automatic).toBe(true);
    expect(reads.projectInput(row({ transportIntent: 'tool', state: 'tool', offeredAt: 5 }))).toMatchObject({ transportIntent: 'tool', delivery: 'unconfirmed' });
  });
});

describe('agents', () => {
  it('serves the swarm as the broker holds it', async () => {
    expect((await call('/v1/agents')).body).toEqual({
      enabled: expect.any(Boolean),
      running: false,
      retainedHistory: false,
      agents: []
    });
  });

  it('reports broker-retained history without publishing dormant family identities', async () => {
    agentsModule.resetAgentsForTests();
    agentsModule.onSpawnRequest(() => undefined);
    try {
      const first = agentsModule.spawn({
        caller: { conversationId: 'control-prime-a' },
        workers: [{ task: 'park this worker' }]
      });
      expect(agentsModule.bindConversation('worker-1', 'control-worker-a', first.runId)).toBe(true);
      expect((await call('/v1/agents')).body).toMatchObject({
        running: true,
        retainedHistory: false
      });

      agentsModule.finishAgent({ conversationId: 'control-worker-a' }, 'done for now');
      expect(agentsModule.releaseQuiescentRun({}, first.runId)).toBe(true);
      expect(agentsModule.swarmState()).toMatchObject({
        running: false,
        retainedHistory: true,
        agents: []
      });
      expect((await call('/v1/agents')).body).toEqual({
        enabled: true,
        running: false,
        retainedHistory: true,
        agents: []
      });

      const second = agentsModule.spawn({
        caller: { conversationId: 'control-prime-b' },
        workers: [{ task: 'keep this worker active' }]
      });
      expect(agentsModule.bindConversation('worker-1', 'control-worker-b', second.runId)).toBe(true);
      const activeAndParked = (await call('/v1/agents')).body;
      expect(activeAndParked).toMatchObject({
        enabled: true,
        running: true,
        retainedHistory: true
      });
      expect(activeAndParked.agents).not.toHaveLength(0);
      expect(JSON.stringify(activeAndParked)).not.toContain('control-prime-a');
      expect(JSON.stringify(activeAndParked)).not.toContain('control-worker-a');
    } finally {
      agentsModule.resetAgentsForTests();
    }
  });

  it('publishes an agent without its recovery bookkeeping', () => {
    const agent = {
      runId: 'run-1', primeConversationId: 'prime-chat', id: 'worker-1', role: 'worker', label: 'Fixer', task: `Fix it with ${apiKey}`,
      reasoningEffort: null, model: 'gpt-x', state: 'sleeping', createdAt: 1, activatedAt: 2, finishedAt: 3, result: `Done. ${'d'.repeat(5_000)}`,
      pending: 1, awaitingAck: 0, delivered: 3, conversationId: 'chat-1', detachedAt: null, lastSeenAt: 5, revivable: true,
      silenceParked: true, silenceRecoveryTurnId: 'turn-secret', silenceRecoveryRequestOriginMax: 9,
      lastRevivalCommandId: 'command-secret', sleptAt: 4, contextTokens: 100
    };
    const projected = reads.projectAgents({ enabled: true, running: true, agents: [agent] } as never);
    const raw = JSON.stringify(projected);
    for (const hidden of ['turn-secret', 'command-secret', 'prime-chat', 'silence', apiKey]) expect(raw).not.toContain(hidden);
    expect(Object.keys(projected.agents[0]!).sort()).toEqual([
      'activatedAt', 'awaitingAck', 'contextTokens', 'conversationId', 'createdAt', 'delivered', 'detachedAt', 'finishedAt', 'id',
      'label', 'lastSeenAt', 'model', 'pending', 'reasoningEffort', 'result', 'revivable', 'role', 'runId', 'sleptAt', 'state', 'task'
    ]);
    expect(projected.agents[0]).toMatchObject({ task: { text: 'Fix it with [redacted]', truncated: false }, result: { chars: 5_006, truncated: true } });
    expect(projected.agents[0]!.result!.text).toHaveLength(4_000);
  });
});
