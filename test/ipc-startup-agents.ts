import { describe, expect, it, vi } from 'vitest';
import {
  handlers,
  getConfig,
  resetSecretsCacheForTests,
  readDurable,
  pendingCommands,
  startBridge,
  bindConversation,
  finishAgent,
  pauseSwarmForDisable,
  persistAgentAuthorityNow,
  pendingWorkerRevivals,
  releaseQuiescentRun,
  restoreSwarm,
  sendMessage,
  snapshotSwarm,
  spawn,
  swarmStateForCaller,
  safeStorage,
  save,
  settings,
} from './ipc-context.js';
describe('startup state without secure storage', () => {
  it('still returns a usable app/bridge state instead of crashing state discovery', async () => {
    resetSecretsCacheForTests();
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

    const reply = (await handlers.get('state:get')!(null, undefined)) as any;
    expect(reply.ok).toBe(true);
    expect(reply.data.secureStorage.available).toBe(false);
    expect(reply.data.hasGoalKey).toBe(false);
    expect(reply.data.bridge.paired).toBe(false);
  });
});

describe('turning multi-agent mode off', () => {
  // Pausing execution must withdraw queued browser work before the bridge goes away. The durable worker history itself survives; only the pending transport is cancelled.
  it('cancels the run’s queued worker chats before the bridge goes away', async () => {
    await startBridge();
    spawn({ workers: [{ task: 'work' }], caller: { conversationId: 'c-prime' } });
    // Opening is asynchronous, as it is in the app.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingCommands().length).toBe(1);

    // Recording off as well, so this really is the case where the bridge is shut down.
    await save(settings({ record: false, multiAgent: false }));

    expect(getConfig().multiAgent.enabled).toBe(false);
    expect(pendingCommands(), 'a worker chat was left queued for a run that has ended').toEqual([]);
  });

  it('does not acknowledge the toggle until the parked retained history is durable', async () => {
    const prime = '11111111-2222-4333-8444-555555555555';
    const worker = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    spawn({ workers: [{ task: 'must stay fenced after disable' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);
    expect(await readDurable('ipc-swarm')).not.toBeNull();

    const reply = await save(settings({ record: false, multiAgent: false }));
    expect(reply.ok, reply.error).toBe(true);
    expect(await readDurable<any>('ipc-swarm')).toMatchObject({
      version: 7,
      runId: null,
      primeConversationId: null,
      agents: [],
      dormantRuns: [
        expect.objectContaining({
          primeConversationId: prime,
          agents: expect.arrayContaining([
            expect.objectContaining({
              info: expect.objectContaining({
                id: 'worker-1',
                conversationId: worker,
                state: 'sleeping',
                revivable: true
              })
            })
          ])
        })
      ]
    });
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({ workers: [] });
  });

  it('survives a disabled restart and re-enable with the exact old worker chat still revivable', async () => {
    const prime = '22222222-3333-4444-8555-666666666666';
    const worker = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    spawn({ workers: [{ task: 'remember this exact worker' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);
    expect(await persistAgentAuthorityNow()).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved).not.toBeNull();

    // The startup path restores authority even while the feature is off, then canonicalizes any leftover active incarnation into parked history. Reproduce that process boundary here.
    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    expect(snapshotSwarm()).toMatchObject({
      runId: null,
      dormantRuns: [expect.objectContaining({ primeConversationId: prime })]
    });

    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: prime }).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'worker-1',
          conversationId: worker,
          state: 'sleeping',
          revivable: true
        })
      ])
    );

    sendMessage({ conversationId: prime }, 'worker-1', 'continue in the exact worker chat');
    expect(pendingWorkerRevivals()).toEqual([
      expect.objectContaining({ id: 'worker-1', conversationId: worker })
    ]);
  });

  it('preserves every parked owner when disabling a different prime that is still active', async () => {
    const primeA = '33333333-4444-4555-8666-777777777777';
    const workerA = 'cccccccc-dddd-4eee-8fff-000000000001';
    spawn({ workers: [{ task: 'A retained history' }], caller: { conversationId: primeA } });
    expect(bindConversation('worker-1', workerA)).toBe(true);
    finishAgent({ conversationId: workerA }, 'A is parked already');
    expect(releaseQuiescentRun()).toBe(true);

    const primeB = '44444444-5555-4666-8777-888888888888';
    const workerB = 'dddddddd-eeee-4fff-8000-000000000002';
    spawn({ workers: [{ task: 'B is live when disabled' }], caller: { conversationId: primeB } });
    expect(bindConversation('worker-1', workerB)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    const saved = await readDurable<any>('ipc-swarm');
    expect(saved?.runId).toBeNull();
    expect(saved?.dormantRuns).toHaveLength(2);
    expect(saved?.dormantRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ primeConversationId: primeA }),
        expect.objectContaining({ primeConversationId: primeB })
      ])
    );

    restoreSwarm(saved);
    pauseSwarmForDisable('multi-agent mode is disabled');
    const enabled = await save(settings({ record: false, multiAgent: true }));
    expect(enabled.ok, enabled.error).toBe(true);
    expect(swarmStateForCaller({ conversationId: primeA }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerA
    });
    expect(swarmStateForCaller({ conversationId: primeB }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: workerB
    });
  });

  it('keeps disabled history until the explicit Clear swarm IPC destroys it', async () => {
    const prime = '55555555-6666-4777-8888-999999999999';
    const worker = 'eeeeeeee-ffff-4000-8111-000000000003';
    spawn({ workers: [{ task: 'survive disable until explicit clear' }], caller: { conversationId: prime } });
    expect(bindConversation('worker-1', worker)).toBe(true);

    const disabled = await save(settings({ record: false, multiAgent: false }));
    expect(disabled.ok, disabled.error).toBe(true);
    expect((await readDurable<any>('ipc-swarm'))?.dormantRuns).toHaveLength(1);

    const cleared = await handlers.get('swarm:reset')!(null, undefined) as any;
    expect(cleared.ok, cleared.error).toBe(true);
    expect(await readDurable('ipc-swarm')).toBeNull();
    expect(await readDurable<any>('ipc-retired-workers')).toMatchObject({
      workers: expect.arrayContaining([expect.objectContaining({ id: 'worker-1', conversationId: worker })])
    });
  });
});

