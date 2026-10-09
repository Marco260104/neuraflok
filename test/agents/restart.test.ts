import {
  PRIME_CHAT,
  PRIME_ID,
  acknowledgeOffers,
  bindConversation,
  currentRunId,
  dormantWorkerNotice,
  fillContext,
  finishAgent,
  flushDurable,
  fs,
  identify,
  noteAgentAlive,
  offerMessages,
  onSpawnRequest,
  onSwarmPersist,
  onSwarmPersistNow,
  pendingWorkerSpawns,
  persistCriticalSwarmNow,
  prime,
  readDurable,
  releaseQuiescentRun,
  repairPrimeConversationAfterRecovery,
  resetAgentsForTests,
  restoreRetiredWorkers,
  restoreSwarm,
  retiredWorkerForConversation,
  sendMessage,
  setEnabled,
  snapshotSwarm,
  spawn,
  stageMessages,
  stageSpawn,
  startSwarm,
  startWorker,
  statusForCaller,
  swarmRunning,
  swarmState,
  swarmStateForCaller,
  writeDurableNow,
  writeDurableSoon,
} from './context.js';
import type { Caller } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('restart', () => {
  it('drops parked histories beyond the newest sixteen or older than a week, retiring their worker chats', async () => {
    vi.useFakeTimers();
    try {
      await setEnabled(true, 1);
      const park = (n: number): void => {
        spawn({ workers: [{ task: `work ${n}` }], caller: { conversationId: `c-prime-${n}` } });
        const worker = startWorker('worker-1', `c-worker-${n}`);
        finishAgent(worker.caller, `done ${n}`);
        expect(releaseQuiescentRun()).toBe(true);
        vi.setSystemTime(Date.now() + 1_000);
      };
      for (let n = 1; n <= 17; n++) park(n);
      expect(snapshotSwarm()!.dormantRuns).toHaveLength(16);
      expect(dormantWorkerNotice('c-worker-1')).toBeNull();
      expect(retiredWorkerForConversation('c-worker-1')?.id).toBe('worker-1');
      expect(dormantWorkerNotice('c-worker-2')).toContain('WORKER_SLEEPING');

      // A week later the rest are history too, on the next parking and on a restart alike.
      const saved = snapshotSwarm()!;
      vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60_000);
      park(18);
      expect(snapshotSwarm()!.dormantRuns?.map((entry) => entry.primeConversationId)).toEqual(['c-prime-18']);

      resetAgentsForTests();
      restoreSwarm(saved);
      expect(snapshotSwarm()?.dormantRuns ?? []).toHaveLength(0);
      expect(retiredWorkerForConversation('c-worker-17')?.id).toBe('worker-1');
    } finally {
      vi.useRealTimers();
      await setEnabled(true);
    }
  });

  it('restores every still-live retired worker fence after histories grow beyond the old 64-worker ceiling', () => {
    const now = Date.now();
    restoreRetiredWorkers({
      version: 1,
      savedAt: now,
      workers: Array.from({ length: 65 }, (_, index) => ({
        id: `worker-${index + 1}`,
        conversationId: `c-retired-${index + 1}`,
        reason: 'explicit clear of a long-lived worker history',
        retiredAt: now
      }))
    });

    expect(retiredWorkerForConversation('c-retired-1')).toMatchObject({ id: 'worker-1' });
    expect(retiredWorkerForConversation('c-retired-65')).toMatchObject({ id: 'worker-65' });
  });

  it('restores an active prime beside another prime full sleeping and terminal dormant history', () => {
    const primeB: Caller = { conversationId: 'c-prime-b-active-restore' };
    startSwarm(2);
    const sleeper = startWorker('worker-1', 'c-worker-a-sleeper-restore');
    const terminal = startWorker('worker-2', 'c-worker-a-terminal-restore');
    finishAgent(sleeper.caller, 'keep this exact chat reusable');
    fillContext('c-worker-a-terminal-restore');
    finishAgent(terminal.caller, 'this exact chat is full');
    expect(releaseQuiescentRun()).toBe(true);

    spawn({ workers: [{ task: 'B stays active across restart' }], caller: primeB });
    startWorker('worker-1', 'c-worker-b-active-restore');
    const saved = snapshotSwarm()!;
    expect(saved.runId).not.toBeNull();
    expect(saved.dormantRuns).toHaveLength(1);

    resetAgentsForTests();
    restoreSwarm(saved);

    expect(swarmRunning()).toBe(true);
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active',
      conversationId: 'c-worker-b-active-restore'
    });
    const aHistory = swarmStateForCaller(prime).agents;
    expect(aHistory.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: true,
      conversationId: 'c-worker-a-sleeper-restore'
    });
    expect(aHistory.find((agent) => agent.id === 'worker-2')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'c-worker-a-terminal-restore'
    });
    expect(statusForCaller(prime)).toMatchObject({ runId: null, freeWorkerSlots: 3 });
  });

  it('persists worker binding and activation as one state transition', () => {
    startSwarm(1);
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => persisted.push(snapshotSwarm()));

    expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
    expect(persisted).toHaveLength(1);
    const worker = persisted[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.info;
    expect(worker?.conversationId).toBe('c-worker-1');
    expect(worker?.state).toBe('active');
  });

  it('repairs the legacy bound-but-invited crash snapshot instead of opening a duplicate worker chat', () => {
    startSwarm(1);
    const snapshot = snapshotSwarm()!;
    const worker = snapshot.activeRuns![0]!.agents.find((entry) => entry.info.id === 'worker-1')!.info;
    // This is the exact intermediate generation the old two-step activation could put on disk if the process died between its two changed() calls.
    worker.conversationId = 'c-worker-1';
    worker.state = 'invited';
    worker.activatedAt = null;

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(pendingWorkerSpawns()).toEqual([]);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(identify({ conversationId: 'c-worker-1' }).id).toBe('worker-1');
  });

  it('repairs a legacy finished snapshot that still says the worker is revivable', () => {
    startSwarm(1);
    startWorker('worker-1');
    const snapshot = snapshotSwarm()!;
    const worker = snapshot.activeRuns![0]!.agents.find((entry) => entry.info.id === 'worker-1')!.info;
    worker.state = 'finished';
    worker.finishedAt = Date.now();
    worker.result = 'already done';
    worker.revivable = true;

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
    expect(noteAgentAlive('c-worker-1')).toBeNull();
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  it('re-keys a pre-UUID version-4 snapshot instead of restoring its 32-bit run incarnation', () => {
    startSwarm(1);
    const snapshot = snapshotSwarm()!;
    // Version 4 predates the full-UUID run fence. Those builds wrote only the first eight hex characters but the snapshot version itself did not change, so an upgrade can genuinely encounter this durable shape.
    snapshot.runId = 'deadbeef';

    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(currentRunId()).not.toBe('deadbeef');
    expect(currentRunId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // Re-keying the recovered incarnation must not throw away the durable run itself. An invited worker will simply be re-bootstrapped under the new fence.
    expect(swarmState().agents.map((agent) => agent.id)).toEqual([PRIME_ID, 'worker-1']);
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1']);
  });

  it('separates critical broker durability from delivery telemetry and drains exact snapshots on demand', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
    });

    startSwarm(1);
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.primeConversationId).toBe(PRIME_CHAT);

    sendMessage(prime, 'worker-1', 'critical queue mutation');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);

    // Offer/ACK timestamps are delivery telemetry. They still use the debounced persistence callback, but they do not manufacture another critical disk barrier revision.
    offerMessages('worker-1');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
    acknowledgeOffers('worker-1');
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(persisted).toHaveLength(2);
  });

  it('does not mark a newer critical generation durable when it appears during an older immediate write', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
      if (persisted.length === 1) {
        firstStarted();
        await firstGate;
      }
    });

    startSwarm(1);
    const draining = persistCriticalSwarmNow();
    await firstWriteStarted;
    sendMessage(prime, 'worker-1', 'created while generation one is on disk');
    releaseFirst();

    expect(await draining).toBe(true);
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);
    expect(persisted[1]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);
  });

  it('keeps an unpublished message out of a debounced disk write while its immediate acceptance write is held and failing', async () => {
    const stateName = 'message-atomicity-race';
    startSwarm(1);
    // Drain the run-creation revision through the normal test sink so the controlled immediate writer below belongs only to the message being exercised.
    expect(await persistCriticalSwarmNow()).toBe(true);

    // Production wiring snapshots synchronously into the debounced lane whenever the broker says it changed. The timer may reach disk while an independent immediate acceptance barrier is still waiting, so this must be a *committed-only* snapshot.
    onSwarmPersist(() => writeDurableSoon(stateName, snapshotSwarm()));

    let immediateEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      immediateEntered = resolve;
    });
    let releaseImmediate!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseImmediate = resolve;
    });
    let targetRenames = 0;
    const realRename = fs.rename.bind(fs);
    const renameFailure = Object.assign(new Error('injected immediate swarm rename failure'), { code: 'EBUSY' });
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${stateName}.json`)) {
        targetRenames += 1;
        // Rename #1 is the debounced writer fired while the barrier is held. Rename #2 is the immediate acceptance generation, which fails and therefore remains pending.
        if (targetRenames === 2) throw renameFailure;
      }
      return realRename(from, to);
    });

    onSwarmPersistNow(async (snapshot) => {
      // The immediate lane is the *only* snapshot allowed to contain unpublished messages: it is exactly the generation whose fsync decides whether this send was accepted.
      expect(snapshot?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(1);
      immediateEntered();
      await held;
      await writeDurableNow(stateName, snapshot);
    });

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'do not publish before fsync' }]);
    const barrier = persistCriticalSwarmNow();
    await entered;

    // Force the ordinary debounce to disk *before* the acceptance barrier is released. A crash here must recover the pre-send queue, because the sender has not been told the message was accepted yet.
    await flushDurable();
    const whileHeld = await readDurable<ReturnType<typeof snapshotSwarm>>(stateName);
    expect(whileHeld?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);

    releaseImmediate();
    await expect(barrier).rejects.toMatchObject({ code: 'EBUSY' });
    staged.rollback();

    // writeDurableNow keeps its failed generation pending for retry. Rollback must enqueue a *newer* committed-only snapshot, so that failed staged generation can never win later.
    rename.mockRestore();
    await flushDurable();
    const afterRollback = await readDurable<ReturnType<typeof snapshotSwarm>>(stateName);
    expect(afterRollback?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toHaveLength(0);
  });

  it('publishes a staged worker topology only after its exact critical snapshot is durable', async () => {
    const ordinary: Array<ReturnType<typeof snapshotSwarm>> = [];
    const critical: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersist(() => ordinary.push(snapshotSwarm()));
    onSwarmPersistNow(async (snapshot) => {
      critical.push(snapshot);
    });

    const staged = stageSpawn({ workers: [{ task: 'inspect topology' }], caller: prime });

    // The broker reserves the one global run while acceptance is in flight, but nothing that can publish/open workers is allowed to see the planned topology yet.
    expect(swarmRunning()).toBe(true);
    expect(swarmState()).toMatchObject({ running: false, agents: [] });
    expect(snapshotSwarm()).toBeNull();
    expect(pendingWorkerSpawns()).toEqual([]);
    expect(ordinary.at(-1)).toBeNull();

    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(critical.at(-1)?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
    staged.commit();

    expect(swarmState().running).toBe(true);
    expect(snapshotSwarm()?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
    expect(pendingWorkerSpawns()).toEqual([{ runId: staged.runId, primeConversationId: PRIME_CHAT, id: 'worker-1', model: null, reasoningEffort: null, task: 'inspect topology' }]);
    expect(ordinary.at(-1)?.agents.map((entry) => entry.info.id)).toEqual(['prime', 'worker-1']);
  });

  it('rolls a staged addition back to the previously accepted run without leaking it to ordinary snapshots', () => {
    spawn({ workers: [{ task: 'accepted worker' }], caller: prime });
    const before = snapshotSwarm();

    const staged = stageSpawn({ workers: [{ task: 'second worker' }], caller: prime });
    expect(staged.created.map((entry) => entry.id)).toEqual(['worker-2']);
    expect(snapshotSwarm()?.agents.some((entry) => entry.info.id === 'worker-2')).toBe(false);
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-1']);

    staged.rollback();
    expect(swarmState().agents.some((entry) => entry.id === 'worker-2')).toBe(false);
    expect(snapshotSwarm()?.agents.map((entry) => entry.info.id)).toEqual(before?.agents.map((entry) => entry.info.id));
    expect(pendingWorkerSpawns().map((entry) => entry.id)).toEqual(['worker-1']);
  });

  it('carries the run, its bindings and its in-flight messages through a snapshot', () => {
    let persists = 0;
    onSwarmPersist(() => {
      persists += 1;
    });
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'keep going, but check the parser');
    offerMessages('worker-1');

    const snapshot = snapshotSwarm()!;
    expect(persists).toBeGreaterThan(0);
    // Nothing in a snapshot can authorise a call, because nothing in this app can: an agent is the conversation it runs in, and that id is recorded on purpose.
    expect(JSON.stringify(snapshot)).not.toMatch(/key|secret|hash/i);

    resetAgentsForTests();
    expect(swarmRunning()).toBe(false);
    restoreSwarm(snapshot);

    expect(swarmRunning()).toBe(true);
    // The prime is still the same chat, and the worker is still in its own.
    expect(identify(prime).id).toBe(PRIME_ID);
    expect(identify({ conversationId: 'c-worker-1' }).id).toBe('worker-1');
    // An offer that was in flight when the app stopped is offered again, not lost.
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual([
      'keep going, but check the parser'
    ]);
  });

  it('replays a queued worker spawn when the bridge registers after the restore', () => {
    startSwarm(2);
    const snapshot = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(snapshot);
    const spawned: string[] = [];
    onSpawnRequest((workers) => spawned.push(...workers.map((worker) => worker.id)));
    expect(spawned).toEqual(['worker-1', 'worker-2']);
  });

  it('repairs only the exact durable prime A→B recovery transition after transfer state was lost', () => {
    startSwarm(2);
    const snapshot = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(snapshot);

    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(true);
    expect(snapshotSwarm()?.primeConversationId).toBe('c-resumed');
    expect(identify({ conversationId: 'c-resumed' }).id).toBe(PRIME_ID);
    // Recovery replay is idempotent, but neither a different source nor an unrelated target can use this hook as a takeover mechanism.
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(true);
    expect(repairPrimeConversationAfterRecovery('c-other', 'c-hijack')).toBe(false);
    expect(snapshotSwarm()?.primeConversationId).toBe('c-resumed');
  });

  it('refuses recovery repair when the durable target chat is already a worker identity', () => {
    startSwarm(1);
    bindConversation('worker-1', 'c-resumed');
    expect(repairPrimeConversationAfterRecovery(PRIME_CHAT, 'c-resumed')).toBe(false);
    expect(snapshotSwarm()?.primeConversationId).toBe(PRIME_CHAT);
  });
});

