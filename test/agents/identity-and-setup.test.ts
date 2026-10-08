import {
  AgentError,
  PRIME_CHAT,
  PRIME_ID,
  bindConversation,
  closableWorkerConversations,
  currentRunId,
  defaultConfig,
  fillContext,
  finishAgent,
  noteAgentAlive,
  onSpawnRequest,
  pendingWorkerRevivals,
  pendingWorkerSpawns,
  prime,
  releaseQuiescentRun,
  resetAgentsForTests,
  restoreSwarm,
  saveConfig,
  setEnabled,
  snapshotSwarm,
  spawn,
  stageMessages,
  startSwarm,
  startWorker,
  statusForCaller,
  swarmRunning,
  swarmState,
  swarmStateForCaller,
  workerPrimeOwner,
} from './context.js';
import { describe, expect, it, vi } from 'vitest';

it('returns an empty exact-caller status without creating a family or exposing another prime', () => {
  const empty = { self: null, runId: null, state: { running: false, retainedHistory: false, agents: [] } };
  expect(statusForCaller(prime)).toMatchObject(empty);
  expect(swarmRunning()).toBe(false);
  startSwarm(1);
  const unrelated = { conversationId: 'c-unrelated-status' };
  expect(statusForCaller(unrelated)).toMatchObject(empty);
  expect(swarmStateForCaller(unrelated).agents).toEqual([]);
  expect(swarmStateForCaller(prime).agents).toHaveLength(2);
  expect(() => statusForCaller({ conversationId: null })).toThrow(/identity|conversation/i);
});

describe('exact worker prime provenance', () => {
  it('keeps the same exact prime through active, sleeping and dormant worker states', () => {
    startSwarm(1);
    const worker = startWorker('worker-1', 'c-worker-provenance');
    expect(workerPrimeOwner('c-worker-provenance')).toMatchObject({
      owned: true, primeConversationId: PRIME_CHAT
    });

    finishAgent(worker.caller, 'done for now');
    expect(swarmState().agents.find(agent => agent.id === 'worker-1')?.state).toBe('sleeping');
    expect(workerPrimeOwner('c-worker-provenance')).toMatchObject({
      owned: true, primeConversationId: PRIME_CHAT
    });

    expect(releaseQuiescentRun()).toBe(true);
    expect(workerPrimeOwner('c-worker-provenance')).toMatchObject({
      owned: true, primeConversationId: PRIME_CHAT
    });
  });

  it('keeps terminal worker ownership after its slot is over and the family parks', () => {
    startSwarm(1);
    const worker = startWorker('worker-1', 'c-worker-terminal-provenance');
    fillContext('c-worker-terminal-provenance');
    expect(finishAgent(worker.caller, 'finished at the ceiling').info.state).toBe('finished');
    expect(workerPrimeOwner('c-worker-terminal-provenance')).toMatchObject({
      owned: true, primeConversationId: PRIME_CHAT
    });
    expect(releaseQuiescentRun()).toBe(true);
    expect(workerPrimeOwner('c-worker-terminal-provenance')).toMatchObject({
      owned: true, primeConversationId: PRIME_CHAT
    });
  });

  it('distinguishes same-named workers in independent prime families by exact conversation', async () => {
    await setEnabled(true, 3);
    const primeB = { conversationId: 'c-prime-provenance-b' };
    const a = spawn({ caller: prime, workers: [{ task: 'A work' }] });
    const b = spawn({ caller: primeB, workers: [{ task: 'B work' }] });
    expect(bindConversation('worker-1', 'c-worker-provenance-a', a.runId)).toBe(true);
    expect(bindConversation('worker-1', 'c-worker-provenance-b', b.runId)).toBe(true);

    expect(workerPrimeOwner('c-worker-provenance-a')).toMatchObject({
      owned: true, primeConversationId: PRIME_CHAT, runId: a.runId
    });
    expect(workerPrimeOwner('c-worker-provenance-b')).toMatchObject({
      owned: true, primeConversationId: primeB.conversationId, runId: b.runId
    });
  });

  it('moves worker authority with the broker prime transfer instead of retaining the source chat', async () => {
    const { beginPrimeTransfer, freezePrimeTransfer, commitPrimeTransfer } = await import('../../backend/domains/automation/agents.js');
    startSwarm(1);
    startWorker('worker-1', 'c-worker-transfer-provenance');
    expect(workerPrimeOwner('c-worker-transfer-provenance').primeConversationId).toBe(PRIME_CHAT);

    expect(beginPrimeTransfer(PRIME_CHAT)).toBe(true);
    expect(freezePrimeTransfer(PRIME_CHAT)).toBe('frozen');
    expect(commitPrimeTransfer(PRIME_CHAT, 'c-prime-resumed-provenance')).toBe(true);
    expect(workerPrimeOwner('c-worker-transfer-provenance')).toMatchObject({
      owned: true, primeConversationId: 'c-prime-resumed-provenance'
    });
  });

  it('fails closed for a published worker whose prime is still provisional and reports no owner for strangers', async () => {
    await setEnabled(true, 3, true);
    try {
      const run = spawn({ caller: { requestId: 'provisional-prime-request' }, workers: [{ task: 'provisional work' }] });
      expect(bindConversation('worker-1', 'c-worker-provisional', run.runId)).toBe(true);
      expect(workerPrimeOwner('c-worker-provisional')).toMatchObject({
        owned: true, primeConversationId: null, runId: run.runId
      });
      expect(workerPrimeOwner('c-never-owned')).toEqual({ owned: false, primeConversationId: null, runId: null });
    } finally {
      await setEnabled(true);
    }
  });
});

describe('worker chats the browser may close', () => {
  it('names the stopped worker chats beyond the ones most recently used, and no working one', async () => {
    vi.useFakeTimers();
    try {
      await setEnabled(true, 3);
      startSwarm(3);
      const first = startWorker('worker-1');
      const second = startWorker('worker-2');
      startWorker('worker-3');
      expect(closableWorkerConversations(1)).toEqual([]);

      // Two stop, in order; the third keeps working and is never on the list.
      finishAgent(first.caller, 'first done');
      vi.setSystemTime(Date.now() + 1_000);
      finishAgent(second.caller, 'second done');
      expect(closableWorkerConversations(2)).toEqual([]);
      expect(closableWorkerConversations(1)).toEqual(['c-worker-1']);
      expect(closableWorkerConversations(0)).toEqual(['c-worker-1', 'c-worker-2']);

      // The first worker is used again: it is the most recent stopped chat now, so the other one is the surplus.
      vi.setSystemTime(Date.now() + 1_000);
      expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
      finishAgent(first.caller, 'first done again');
      expect(closableWorkerConversations(1)).toEqual(['c-worker-2']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('spawning a run', () => {
  it('refuses the feature while it is switched off', async () => {
    await setEnabled(false);
    expect(() => spawn({ workers: [{ task: 'x' }], caller: prime })).toThrow(/not enabled|switched off|disabled/i);
    await setEnabled(true);
  });

  it('binds the calling conversation as prime and creates its workers', () => {
    const { spawned } = startSwarm(2);
    const state = swarmState();
    expect(state.agents.map((agent) => agent.id)).toEqual([PRIME_ID, 'worker-1', 'worker-2']);
    expect(state.agents[0]?.conversationId).toBe(PRIME_CHAT);
    expect(spawned.map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);
    // Nothing about a run is a credential the state can leak: the prime has none at all, and a worker's code exists only as a hash until it joins.
    expect(JSON.stringify(state)).not.toMatch(/secret|joinKey|codeHash/i);
  });

  it('uses a full UUID as the run incarnation key that fences stale worker commands', () => {
    startSwarm(1);
    expect(currentRunId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('creates nothing at all when any worker in the request is invalid', () => {
    expect(() =>
      spawn({ workers: [{ task: 'fine' }, { task: '   ' }], caller: prime })
    ).toThrow(/Worker 2 has no task/);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('rejects an over-long label before creating anything, not only an over-long task', () => {
    expect(() => spawn({ workers: [{ label: 'x'.repeat(200), task: 'fine' }], caller: prime })).toThrow(
      /label is too long/
    );
    expect(swarmRunning()).toBe(false);
  });

  it('refuses a caller whose conversation this app could not prove, and creates nothing', () => {
    expect(() => spawn({ workers: [{ task: 'fine' }], caller: {} })).toThrow(AgentError);
    expect(swarmRunning()).toBe(false);
    expect(pendingWorkerSpawns()).toEqual([]);
  });

  it('enforces the configured live-worker limit', () => {
    startSwarm(3);
    expect(() => spawn({ workers: [{ task: 'one too many' }], caller: prime })).toThrow(/limit|maximum|too many/i);
  });

  it('lets independent primes recruit only into their own worker families', () => {
    startSwarm(1);
    spawn({ workers: [{ task: 'more' }], caller: { conversationId: 'c-stranger' } });
    expect(swarmState().agents).toHaveLength(4);
    expect(swarmStateForCaller(prime).agents).toHaveLength(2);
    spawn({ workers: [{ task: 'more' }], caller: prime });
    expect(swarmState().agents.map((agent) => agent.id)).toContain('worker-2');
  });

  it('creates a fresh worker on spawn even when an identical old worker is sleeping', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'the first task finished');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    const fresh = spawn({ workers: [{ label: 'Worker 1', task: 'task 1' }], caller: prime });

    expect(fresh.created.map((agent) => agent.id)).toEqual(['worker-2']);
    expect(fresh.created[0]?.state).toBe('invited');
    expect(swarmRunning()).toBe(true);
    expect(swarmStateForCaller(prime).agents.filter((agent) => agent.role === 'worker').map((agent) => agent.id)).toEqual([
      'worker-1',
      'worker-2'
    ]);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true
    });
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-2']);
  });

  it('keeps the sleeping worker separately revivable after a fresh same-brief spawn', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'old identical task finished');
    spawn({ workers: [{ label: 'Worker 1', task: 'task 1' }], caller: prime });
    expect(bindConversation('worker-2', 'c-worker-2')).toBe(true);
    finishAgent({ conversationId: 'c-worker-2' }, 'fresh worker done too');
    expect(releaseQuiescentRun()).toBe(true);

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'come back to the older chat' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    expect(pendingWorkerRevivals()[0]).toMatchObject({ id: 'worker-1', conversationId: 'c-worker-1' });
  });
});

describe('provider-neutral worker model requests', () => {
  it('passes configured provider model and reasoning settings to a worker', async () => {
    const base = defaultConfig();
    await saveConfig({ ...base, multiAgent: { ...base.multiAgent, enabled: true, defaultModel: 'qwen3-coder', defaultReasoning: 'high' } });
    try {
      const result = spawn({ caller: prime, workers: [{ task: 'use the configured provider model' }] });
      expect(result.created[0]).toMatchObject({ model: 'qwen3-coder', reasoningEffort: 'high' });
      expect(result.defaultNotes).toBeUndefined();
    } finally { await setEnabled(true); }
  });

  it('preserves an explicitly requested model without account-catalog lookup', () => {
    const result = spawn({ caller: prime, workers: [{ task: 'use this model', model: 'deepseek-v3.2', reasoning_effort: 'medium' }] });
    expect(result.created[0]).toMatchObject({ model: 'deepseek-v3.2', reasoningEffort: 'medium' });
  });

  it('accepts provider-qualified model ids', () => {
    const result = spawn({ caller: prime, workers: [{ task: 'use this model', model: 'deepseek/deepseek-v4-flash' }] });
    expect(result.created[0]?.model).toBe('deepseek/deepseek-v4-flash');
  });
});

describe('worker models', () => {
  it('stores the requested model on the worker and hands it to the browser request', () => {
    const handed: Array<{ id: string; model: string | null }> = [];
    onSpawnRequest((workers) => handed.push(...workers));
    const result = spawn({
      workers: [
        { label: 'Cheap', task: 'bulk work', model: 'cheap-high-reasoning' },
        { label: 'Default', task: 'other work' }
      ],
      caller: prime
    });
    expect(result.created.map((agent) => [agent.id, agent.model])).toEqual([
      ['worker-1', 'cheap-high-reasoning'],
      ['worker-2', null]
    ]);
    expect(handed).toEqual([
      expect.objectContaining({ id: 'worker-1', model: 'cheap-high-reasoning' }),
      expect.objectContaining({ id: 'worker-2', model: null })
    ]);
    expect(pendingWorkerSpawns()).toEqual([
      expect.objectContaining({ id: 'worker-1', model: 'cheap-high-reasoning' }),
      expect.objectContaining({ id: 'worker-2', model: null })
    ]);
  });

  it('treats a blank model as the account default', () => {
    const result = spawn({ workers: [{ task: 'plain work', model: '   ' }], caller: prime });
    expect(result.created[0]?.model).toBeNull();
  });

  it('rejects a malformed model with zero workers created', () => {
    expect(() =>
      spawn({ workers: [{ task: 'fine' }, { task: 'bad', model: 'not a slug!' }], caller: prime })
    ).toThrow(/model.*id/i);
    expect(swarmRunning()).toBe(false);
    expect(swarmState().agents).toEqual([]);
  });

  it('folds an exact repeat but treats a different model as new work', () => {
    spawn({ workers: [{ label: 'W', task: 'same task', model: 'model-a' }], caller: prime });
    const repeat = spawn({ workers: [{ label: 'W', task: 'same task', model: 'model-a' }], caller: prime });
    expect(repeat.created.map((agent) => agent.id)).toEqual(['worker-1']);
    const changed = spawn({ workers: [{ label: 'W', task: 'same task', model: 'model-b' }], caller: prime });
    expect(changed.created.map((agent) => agent.id)).toEqual(['worker-2']);
    expect(changed.created[0]?.model).toBe('model-b');
  });

  it('round-trips the model through a snapshot restore and repairs a malformed one', () => {
    spawn({ workers: [{ label: 'W', task: 'task', model: 'model-a' }], caller: prime });
    const saved = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(saved);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.model).toBe('model-a');

    const tampered = snapshotSwarm()!;
    tampered.activeRuns![0]!.agents.find((entry) => entry.info.id === 'worker-1')!.info.model = 'not a slug!';
    resetAgentsForTests();
    restoreSwarm(tampered);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.model).toBeNull();
  });

  it('stores reasoning_effort without touching the model', () => {
    const result = spawn({
      workers: [{ label: 'High Reasoning', task: 'deep work', reasoning_effort: 'high' }],
      caller: prime
    });
    expect(result.created[0]).toMatchObject({ id: 'worker-1', model: null, reasoningEffort: 'high' });
    expect(pendingWorkerSpawns()).toEqual([
      expect.objectContaining({ id: 'worker-1', model: null, reasoningEffort: 'high' })
    ]);
  });

  it('rejects an unknown reasoning_effort with zero workers created', () => {
    expect(() => spawn({ workers: [{ task: 'work', reasoning_effort: 'banana' }], caller: prime })).toThrow(
      /reasoning_effort must be one of/i
    );
    expect(swarmRunning()).toBe(false);
    expect(swarmState().agents).toEqual([]);
  });

  it('canonicalizes the level spelling but stores the canonical form', () => {
    const result = spawn({ workers: [{ task: 'work', reasoning_effort: ' High ' }], caller: prime });
    expect(result.created[0]?.reasoningEffort).toBe('high');
  });

  it('folds repeats only when model and reasoning both match', () => {
    spawn({ workers: [{ label: 'W', task: 'same', reasoning_effort: 'high' }], caller: prime });
    const repeat = spawn({ workers: [{ label: 'W', task: 'same', reasoning_effort: 'high' }], caller: prime });
    expect(repeat.created.map((agent) => agent.id)).toEqual(['worker-1']);
    const changed = spawn({ workers: [{ label: 'W', task: 'same', reasoning_effort: 'low' }], caller: prime });
    expect(changed.created.map((agent) => agent.id)).toEqual(['worker-2']);
    expect(changed.created[0]?.reasoningEffort).toBe('low');
  });

  it('round-trips reasoning_effort through a snapshot restore and repairs a malformed one', () => {
    spawn({ workers: [{ label: 'W', task: 'task', reasoning_effort: 'high' }], caller: prime });
    const saved = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(saved);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.reasoningEffort).toBe('high');

    const tampered = snapshotSwarm()!;
    // @ts-expect-error a malformed level smuggled past the type system, as disk can hold
    tampered.activeRuns![0]!.agents.find((entry) => entry.info.id === 'worker-1')!.info.reasoningEffort = 'banana';
    resetAgentsForTests();
    restoreSwarm(tampered);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.reasoningEffort).toBeNull();
  });
});

