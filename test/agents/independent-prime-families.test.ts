import {
  PRIME_CHAT,
  PRIME_ID,
  acknowledgeOffers,
  archiveWorkerAssignments,
  bindConversation,
  claimWorkerRevival,
  clearAgent,
  createSession,
  currentRunId,
  defaultConfig,
  finishAgent,
  freeWorkerSlots,
  getSession,
  noteAgentAlive,
  noteWorkerRevived,
  offerMessages,
  offerMessagesForConversation,
  onSwarmPersistNow,
  pendingCount,
  pendingWorkerRevivals,
  pendingWorkerSpawns,
  persistCriticalSwarmNow,
  prime,
  reactivateDormantRunForConversation,
  releaseQuiescentRun,
  resetAgentsForTests,
  resetSessionStoreForTests,
  restoreSwarm,
  saveConfig,
  sendMessage,
  setEnabled,
  snapshotSwarm,
  spawn,
  stageFinishAgent,
  stageMessages,
  stagePrimeMessage,
  stageQueuedWorkerRevivals,
  stageSpawn,
  startSwarm,
  startWorker,
  statusForCaller,
  swarmState,
  waitingForSubAgents,
} from './context.js';
import type { Caller } from './context.js';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/** The worker wait a Goal/Loop chat opts into, as the one module that owns worker state. A prime that delegated half its task is not finished with it: its workers report back into the same conversation, so deciding the next step while they run reads a context that is about to change. The predicate is the whole rule — the bridge's pickup tree and the finish tool both ask this same function — so what is asserted here is the boundary itself: opt-in, per family, and fail-open on every state that is not "this chat's workers are working". */
describe('waiting for a chat own sub-agents', () => {
  /** The production shape: the setting saved beside the rest of the multi-agent config. */
  async function setWaitForSubAgents(on: boolean, maxWorkers = 3): Promise<void> {
    const base = defaultConfig();
    await saveConfig({
      ...base,
      multiAgent: { ...base.multiAgent, enabled: true, maxWorkers, waitForSubAgents: on }
    });
  }

  afterEach(async () => { await setEnabled(true); });

  it('holds only while a worker of this chat is occupying a slot, and releases on its report', async () => {
    await setWaitForSubAgents(true);
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(false);
    startSwarm(1);
    // Invited and bound alike: a spawn in progress is work this chat started.
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(true);
    const worker = startWorker('worker-1');
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(true);
    finishAgent(worker.caller, 'the piece I was given is done');
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(false);
    // A sleeping worker is revivable, which is not the same as working.
    expect(freeWorkerSlots()).toBe(3);
  });

  it('is opt-in: a busy worker holds nothing while the setting is off', async () => {
    await setWaitForSubAgents(false);
    startSwarm(1);
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(false);
    await setWaitForSubAgents(true);
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(true);
  });

  it.each([
    ['an unknown conversation', 'c-never-seen'],
    ['no conversation at all', null],
    ['an empty conversation id', '']
  ] as const)('fails open for %s', async (_label, conversationId) => {
    await setWaitForSubAgents(true);
    startSwarm(1);
    expect(waitingForSubAgents(conversationId)).toBe(false);
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(true);
  });

  it('fails open for a chat with a run but no workers left', async () => {
    await setWaitForSubAgents(true);
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(false);
    // A chat that owns nothing and merely shares this app's single run: the run's workers are the prime's, and this chat is not the prime.
    expect(waitingForSubAgents('c-a-bystander')).toBe(false);
  });

  it('holds each prime for its own workers and never for another family', async () => {
    await setWaitForSubAgents(true);
    const primeB: Caller = { conversationId: 'wait-prime-b' };
    const a = spawn({ caller: prime, workers: [{ task: 'A work' }] });
    const b = spawn({ caller: primeB, workers: [{ task: 'B work' }] });
    expect(a.runId).not.toBe(b.runId);
    expect(bindConversation('worker-1', 'wait-worker-a', a.runId)).toBe(true);
    expect(bindConversation('worker-1', 'wait-worker-b', b.runId)).toBe(true);
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(true);
    expect(waitingForSubAgents(primeB.conversationId!)).toBe(true);
    finishAgent({ conversationId: 'wait-worker-a' }, 'A done');
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(false);
    expect(waitingForSubAgents(primeB.conversationId!)).toBe(true);
  });

  it('does not hold a chat the workers belong to an ended run', async () => {
    await setWaitForSubAgents(true);
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    expect(releaseQuiescentRun()).toBe(true);
    expect(waitingForSubAgents(PRIME_CHAT)).toBe(false);
    expect(waitingForSubAgents('c-worker-1')).toBe(false);
  });
});

describe('simultaneous independent prime families', () => {
  const primeB: Caller = { conversationId: 'parallel-prime-b' };
  const recruit = (caller: Caller, count = 2) => spawn({ caller,
    workers: Array.from({ length: count }, (_, i) => ({ task: `parallel task ${i}` })) });

  it('enforces one optional admission cap across independent prime families', async () => {
    await setEnabled(true, 2, false, 3);
    try {
      const a = recruit(prime, 2);
      const b = recruit(primeB, 1);
      expect(a.runId).not.toBe(b.runId);
      // B still has room under its own per-family limit. The refusal comes only from the separately configured global admission cap shared by all prime families.
      expect(freeWorkerSlots(b.runId)).toBe(1);
      const nextB = () => spawn({ caller: primeB, workers: [{ task: 'B second global task' }] });
      expect(nextB).toThrow(/GLOBAL_WORKER_LIMIT|global worker/i);

      expect(bindConversation('worker-1', 'parallel-global-worker-a', a.runId)).toBe(true);
      finishAgent({ conversationId: 'parallel-global-worker-a' }, 'A freed one global slot');
      expect(nextB().runId).toBe(b.runId);
    } finally {
      await setEnabled(true);
    }
  });

  it('counts an unpublished staged spawn as a global admission reservation', async () => {
    await setEnabled(true, 2, false, 1);
    try {
      const a = stageSpawn({ caller: prime, workers: [{ task: 'A staged reservation' }] });
      expect(() => stageSpawn({ caller: primeB, workers: [{ task: 'B cannot overbook it' }] }))
        .toThrow(/GLOBAL_WORKER_LIMIT|global worker/i);
      a.rollback();
      const b = stageSpawn({ caller: primeB, workers: [{ task: 'B after rollback' }] });
      b.rollback();
    } finally {
      await setEnabled(true);
    }
  });

  it('uses the same global admission cap when another family wakes a sleeping worker', async () => {
    await setEnabled(true, 2, false, 1);
    try {
      const a = recruit(prime, 1);
      expect(bindConversation('worker-1', 'parallel-global-sleeper-a', a.runId)).toBe(true);
      finishAgent({ conversationId: 'parallel-global-sleeper-a' }, 'A sleeps');
      expect(releaseQuiescentRun({}, a.runId)).toBe(true);

      const b = recruit(primeB, 1);
      expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'wake A while B owns the global slot' }]))
        .toThrow(/GLOBAL_WORKER_LIMIT|global worker/i);
      expect(currentRunId(PRIME_CHAT)).toBeNull();

      expect(bindConversation('worker-1', 'parallel-global-worker-b', b.runId)).toBe(true);
      finishAgent({ conversationId: 'parallel-global-worker-b' }, 'B frees the global slot');
      const wake = stageMessages(prime, [{ to: 'worker-1', text: 'wake A after B stops' }]);
      expect(wake.waking).toEqual(['worker-1']);
      wake.rollback();
    } finally {
      await setEnabled(true);
    }
  });

  it('does not auto-revive queued worker work past the global admission cap', async () => {
    await setEnabled(true, 2, false, 1);
    try {
      const a = recruit(prime, 1);
      expect(bindConversation('worker-1', 'parallel-global-queued-a', a.runId)).toBe(true);
      sendMessage(prime, 'worker-1', 'queued work for A');
      finishAgent({ conversationId: 'parallel-global-queued-a' }, 'A pauses before queued work');

      const b = recruit(primeB, 1);
      expect(stageQueuedWorkerRevivals(['worker-1'], a.runId).waking).toEqual([]);
      expect(statusForCaller(prime).state.agents.find(agent => agent.id === 'worker-1')?.state).toBe('sleeping');

      expect(bindConversation('worker-1', 'parallel-global-queued-b', b.runId)).toBe(true);
      finishAgent({ conversationId: 'parallel-global-queued-b' }, 'B frees the global slot');
      const wake = stageQueuedWorkerRevivals(['worker-1'], a.runId);
      expect(wake.waking).toEqual(['worker-1']);
      wake.rollback();
    } finally {
      await setEnabled(true);
    }
  });

  it('admits two workers for each of two primes and refuses only the full owner', async () => {
    await setEnabled(true, 2);
    try {
      const a = recruit(prime);
      const b = recruit(primeB);
      expect(a.runId).not.toBe(b.runId);
      expect(swarmState().agents.filter(row => row.role === 'worker')).toHaveLength(4);
      expect(swarmState().agents.filter(row => row.id === 'worker-1').map(row => row.runId)).toEqual([a.runId, b.runId]);
      for (const caller of [prime, primeB]) {
        expect(statusForCaller(caller).freeWorkerSlots).toBe(0);
        expect(() => spawn({ caller, workers: [{ task: 'third task' }] })).toThrow(/limit/);
      }
      expect(bindConversation('worker-1', 'parallel-worker-a', a.runId)).toBe(true);
      expect(bindConversation('worker-1', 'parallel-worker-b', b.runId)).toBe(true);
      finishAgent({ conversationId: 'parallel-worker-a' }, 'A finished its piece');
      expect(freeWorkerSlots(a.runId)).toBe(1);
      expect(freeWorkerSlots(b.runId)).toBe(0);
      expect(recruit(prime, 1).runId).toBe(a.runId);
      expect(freeWorkerSlots(a.runId)).toBe(0);
      expect(freeWorkerSlots('stale-run')).toBe(0);
    } finally { await setEnabled(true); }
  });

  it('routes same-named workers and their finish reports only to their exact owners', () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    expect(bindConversation('worker-1', 'parallel-worker-a', a.runId)).toBe(true);
    expect(bindConversation('worker-1', 'parallel-worker-a', b.runId)).toBe(false);
    expect(bindConversation('worker-1', 'parallel-worker-b', b.runId)).toBe(true);
    expect(bindConversation('worker-1', 'ambiguous-worker')).toBe(false);
    sendMessage(prime, 'worker-1', 'A-only instruction');
    sendMessage(primeB, 'worker-1', 'B-only instruction');
    expect(offerMessages('worker-1')).toEqual([]);
    expect(offerMessagesForConversation('parallel-worker-a')?.messages.map(m => m.text)).toEqual(['A-only instruction']);
    expect(offerMessagesForConversation('parallel-worker-b')?.messages.map(m => m.text)).toEqual(['B-only instruction']);
    finishAgent({ conversationId: 'parallel-worker-a' }, 'A-only result');
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages.map(m => m.text).join('')).toContain('A-only result');
    expect(offerMessagesForConversation(primeB.conversationId)?.messages).toEqual([]);
    expect(() => recruit({ conversationId: 'parallel-worker-b' }, 1)).toThrow(/worker/i);
  });

  it('routes an explicit prime-to-prime message durably and preserves its reply address across restart', () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    const staged = stagePrimeMessage({ ...prime, runId: a.runId }, b.runId, 'coordinate with B');
    expect(staged).toMatchObject({ sourceRunId: a.runId, targetRunId: b.runId });
    expect(staged.message).toMatchObject({
      from: PRIME_ID,
      to: PRIME_ID,
      fromRunId: a.runId,
      text: 'coordinate with B'
    });
    // Staged rows are invisible until the same durable barrier used by ordinary agent messages accepts them.
    expect(offerMessagesForConversation(primeB.conversationId)?.messages).toEqual([]);
    expect(staged.commit()).toBe(true);

    const snapshot = JSON.parse(JSON.stringify(snapshotSwarm()));
    resetAgentsForTests();
    restoreSwarm(snapshot);
    const received = offerMessagesForConversation(primeB.conversationId)?.messages;
    expect(received).toEqual([
      expect.objectContaining({
        from: PRIME_ID,
        to: PRIME_ID,
        fromRunId: a.runId,
        text: 'coordinate with B'
      })
    ]);
    expect(statusForCaller(prime).state.agents.map(agent => agent.runId)).toEqual([a.runId, a.runId]);
    expect(statusForCaller(primeB).state.agents.map(agent => agent.runId)).toEqual([b.runId, b.runId]);
  });

  it('keeps the peer reply alias bounded and restorable after more than eight source incarnations', () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    expect(bindConversation('worker-1', 'parallel-peer-reply-worker-a', a.runId)).toBe(true);
    const staged = stagePrimeMessage({ ...prime, runId: a.runId }, b.runId, 'B keeps A reply address');
    expect(staged.commit()).toBe(true);
    expect(offerMessagesForConversation(primeB.conversationId)?.messages).toEqual([
      expect.objectContaining({ fromRunId: a.runId, text: 'B keeps A reply address' })
    ]);

    finishAgent({ conversationId: 'parallel-peer-reply-worker-a' }, 'A sleeps');
    expect(releaseQuiescentRun({}, a.runId)).toBe(true);
    for (let incarnation = 0; incarnation < 12; incarnation += 1) {
      expect(reactivateDormantRunForConversation('parallel-peer-reply-worker-a')).toBe(true);
      const nextA = currentRunId(PRIME_CHAT)!;
      expect(releaseQuiescentRun({}, nextA)).toBe(true);
    }

    const laterMessage = stagePrimeMessage(
      { ...prime, runId: a.runId },
      b.runId,
      'A still publishes the same peer reply address'
    );
    expect(laterMessage.sourceRunId).toBe(a.runId);
    laterMessage.rollback();

    const beforeRestart = snapshotSwarm()!;
    const parkedBefore = beforeRestart.dormantRuns!.find(run => run.primeConversationId === PRIME_CHAT)!;
    expect(parkedBefore.formerRunIds).toHaveLength(9);
    expect(parkedBefore.formerRunIds?.[0]).toBe(a.runId);

    resetAgentsForTests();
    restoreSwarm(JSON.parse(JSON.stringify(beforeRestart)));
    const parkedAfter = snapshotSwarm()!.dormantRuns!.find(run => run.primeConversationId === PRIME_CHAT)!;
    expect(parkedAfter.formerRunIds).toHaveLength(9);
    expect(parkedAfter.formerRunIds?.[0]).toBe(a.runId);

    const reply = stagePrimeMessage({ ...primeB, runId: b.runId }, a.runId, 'A receives reply after restore');
    expect(reply.targetRunId).toBe(parkedAfter.agents.find(agent => agent.info.id === PRIME_ID)!.info.runId);
    expect(reply.commit()).toBe(true);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages.map(message => message.text)).toContain(
      'A receives reply after restore'
    );
  });

  it('keeps a cross-prime row unpublished until its critical snapshot is durable', async () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    const staged = stagePrimeMessage({ ...prime, runId: a.runId }, b.runId, 'durable peer handoff');
    const publicBefore = snapshotSwarm()?.activeRuns
      ?.find(run => run.runId === b.runId)?.agents
      .find(agent => agent.info.id === PRIME_ID)?.queue ?? [];
    expect(publicBefore).toEqual([]);

    const writes: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async snapshot => {
      writes.push(structuredClone(snapshot));
    });
    expect(await persistCriticalSwarmNow()).toBe(true);
    const durableQueue = writes.at(-1)?.activeRuns
      ?.find(run => run.runId === b.runId)?.agents
      .find(agent => agent.info.id === PRIME_ID)?.queue ?? [];
    expect(durableQueue).toEqual([
      expect.objectContaining({ text: 'durable peer handoff', fromRunId: a.runId })
    ]);

    expect(staged.commit()).toBe(true);
    const publicAfter = snapshotSwarm()?.activeRuns
      ?.find(run => run.runId === b.runId)?.agents
      .find(agent => agent.info.id === PRIME_ID)?.queue ?? [];
    expect(publicAfter).toEqual([
      expect.objectContaining({ text: 'durable peer handoff', fromRunId: a.runId })
    ]);
  });

  it('keeps the foreign-family boundary closed around the prime-to-prime address', () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    expect(bindConversation('worker-1', 'parallel-peer-worker-a', a.runId)).toBe(true);

    expect(() =>
      stagePrimeMessage({ conversationId: 'parallel-peer-worker-a', runId: a.runId }, b.runId, 'bypass')
    ).toThrow(/only a prime/i);
    expect(() =>
      stagePrimeMessage({ ...prime, runId: a.runId }, a.runId, 'talk to myself')
    ).toThrow(/own families/i);
    expect(() =>
      stagePrimeMessage({ ...prime, runId: a.runId }, '00000000-0000-4000-8000-000000000000', 'guess')
    ).toThrow(/TARGET_RUN_UNAVAILABLE/);

    // Existing family-local commands keep their ownership rule even though the caller knows B's run id. The new address is a message endpoint for B's prime, not a capability for B's rows.
    expect(() =>
      stageMessages({ ...prime, runId: b.runId }, [{ to: 'worker-1', text: 'foreign worker' }])
    ).toThrow(/AGENTS_BUSY/);
  });

  it('allows independent staged spawns while rollback cannot erase another accepted owner', async () => {
    const a = stageSpawn({ caller: prime, workers: [{ task: 'A staged' }] });
    const b = stageSpawn({ caller: primeB, workers: [{ task: 'B staged' }] });
    expect(pendingWorkerSpawns()).toEqual([]);
    expect(snapshotSwarm()).toBeNull();
    expect(bindConversation('worker-1', 'unaccepted', a.runId)).toBe(false);
    const writes: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async snapshot => { writes.push(structuredClone(snapshot)); });
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(writes.at(-1)?.activeRuns?.map(r => r.runId)).toEqual([a.runId, b.runId]);
    b.commit(); a.rollback();
    expect(pendingWorkerSpawns()).toEqual([expect.objectContaining({ runId: b.runId, primeConversationId: primeB.conversationId })]);
    expect(currentRunId(PRIME_CHAT)).toBeNull();
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
    expect(snapshotSwarm()?.activeRuns?.map(r => r.runId)).toEqual([b.runId]);
    restoreSwarm(snapshotSwarm());
    expect(currentRunId(PRIME_CHAT)).toBeNull();
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
  });

  it('restores both live owners and preserves each inbox and explicit command fence', () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    bindConversation('worker-1', 'parallel-worker-a', a.runId);
    bindConversation('worker-1', 'parallel-worker-b', b.runId);
    sendMessage(prime, 'worker-1', 'durable A');
    sendMessage(primeB, 'worker-1', 'durable B');
    const snapshot = JSON.parse(JSON.stringify(snapshotSwarm()));
    resetAgentsForTests(); restoreSwarm(snapshot);
    expect(currentRunId(PRIME_CHAT)).toBe(a.runId);
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
    expect(offerMessagesForConversation('parallel-worker-a')?.messages.map(m => m.text)).toEqual(['durable A']);
    expect(offerMessagesForConversation('parallel-worker-b')?.messages.map(m => m.text)).toEqual(['durable B']);
    expect(acknowledgeOffers('worker-1', false, Infinity, 'old-incarnation')).toEqual([]);
    expect(pendingCount('worker-1', b.runId)).toBe(1);
  });

  it('parks and reuses A beside executing B while rejecting A old incarnation commands', () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    bindConversation('worker-1', 'parallel-worker-a', a.runId);
    bindConversation('worker-1', 'parallel-worker-b', b.runId);
    finishAgent({ conversationId: 'parallel-worker-a' }, 'A sleeps');
    expect(releaseQuiescentRun({}, a.runId)).toBe(true);
    const wake = stageMessages(prime, [{ to: 'worker-1', text: 'reuse A' }]);
    wake.commit();
    const nextA = currentRunId(PRIME_CHAT)!;
    expect(nextA).not.toBe(a.runId);
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
    expect(claimWorkerRevival('worker-1', 'parallel-worker-a', a.runId)).toBe(false);
    expect(claimWorkerRevival('worker-1', 'parallel-worker-a', nextA)).toBe(true);
    expect(pendingWorkerRevivals()).toEqual([expect.objectContaining({ runId: nextA, conversationId: 'parallel-worker-a' })]);
    clearAgent('prime', nextA);
    expect(currentRunId(PRIME_CHAT)).toBeNull();
    expect(statusForCaller(primeB).state.agents.find(a => a.id === 'worker-1')?.state).toBe('active');
  });

  it('keeps a woken family selectable by the run_id its prime was given before it parked (#881, #882)', () => {
    // Every report a worker sends the prime is labelled with the run_id of that moment. Once all workers slept, the family parked; the prime's next message woke it under a new id, and its reply with the id it had just been given was refused as "no agent family belongs to this conversation" (2.1.24 log in #882: three refusals right after each reactivation).
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    bindConversation('worker-1', 'parallel-worker-a', a.runId);
    bindConversation('worker-1', 'parallel-worker-b', b.runId);
    finishAgent({ conversationId: 'parallel-worker-a' }, 'A sleeps');
    expect(releaseQuiescentRun({}, a.runId)).toBe(true);
    stageMessages({ ...prime, runId: a.runId }, [{ to: 'worker-1', text: 'reuse A' }]).commit();
    const nextA = currentRunId(PRIME_CHAT)!;
    expect(nextA).not.toBe(a.runId);

    // The browser fence stays exact: only the new incarnation may claim the wake.
    expect(claimWorkerRevival('worker-1', 'parallel-worker-a', a.runId)).toBe(false);
    expect(claimWorkerRevival('worker-1', 'parallel-worker-a', nextA)).toBe(true);
    expect(noteWorkerRevived('worker-1', 'parallel-worker-a', pendingWorkerRevivals()[0]!.messageIds, null, nextA)).toBe(true);
    expect(noteAgentAlive('parallel-worker-a', 'call')?.revived).toBe(true);

    // The prime's earlier id still selects its own, now woken family.
    expect(statusForCaller({ ...prime, runId: a.runId })).toMatchObject({ runId: nextA });
    const before = pendingCount('worker-1', nextA);
    stageMessages({ ...prime, runId: a.runId }, [{ to: 'worker-1', text: 'follow-up with the id from the report' }]).commit();
    expect(pendingCount('worker-1', nextA)).toBe(before + 1);

    // It never selects another prime's family, and never moves the browser fence back.
    expect(() => statusForCaller({ ...primeB, runId: a.runId })).toThrow(/AGENTS_BUSY/);
    expect(() => stageMessages({ ...primeB, runId: a.runId }, [{ to: 'worker-1', text: 'not yours' }])).toThrow(/AGENTS_BUSY/);
    expect(pendingCount('worker-1', b.runId)).toBe(0);

    // And it survives a restart, like the family it names.
    const snapshot = JSON.parse(JSON.stringify(snapshotSwarm()));
    resetAgentsForTests(); restoreSwarm(snapshot);
    expect(statusForCaller({ ...prime, runId: a.runId })).toMatchObject({ runId: nextA });
  });

  it('fences overlapping prime transfers and preserves B when A resumes', async () => {
    const { beginPrimeTransfer, freezePrimeTransfer, commitPrimeTransfer, cancelPrimeTransfer } = await import('../../backend/domains/automation/agents.js');
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    expect(beginPrimeTransfer(PRIME_CHAT)).toBe(true);
    expect(beginPrimeTransfer(primeB.conversationId!)).toBe(true);
    expect(freezePrimeTransfer(PRIME_CHAT)).toBe('frozen');
    expect(commitPrimeTransfer(PRIME_CHAT, primeB.conversationId!)).toBe(false);
    expect(commitPrimeTransfer(PRIME_CHAT, 'parallel-prime-a-resumed')).toBe(true);
    expect(currentRunId(PRIME_CHAT)).toBeNull();
    expect(currentRunId('parallel-prime-a-resumed')).toBe(a.runId);
    expect(currentRunId(primeB.conversationId!)).toBe(b.runId);
    expect(swarmState(a.runId).agents.every(row => row.primeConversationId === 'parallel-prime-a-resumed')).toBe(true);
    cancelPrimeTransfer(primeB.conversationId!);
    expect(() => spawn({ caller: primeB, workers: [{ task: 'B next' }] })).not.toThrow();
  });

  it('publishes a staged finish only into A even when B is cleared and replaced during persistence', async () => {
    const a = recruit(prime, 1), b = recruit(primeB, 1);
    bindConversation('worker-1', 'parallel-worker-a', a.runId);
    const staged = stageFinishAgent({ conversationId: 'parallel-worker-a' }, 'A durable report');
    let unblock!: () => void;
    onSwarmPersistNow(async () => { await new Promise<void>(resolve => { unblock = resolve; }); });
    const barrier = persistCriticalSwarmNow();
    await Promise.resolve();
    clearAgent('prime', b.runId);
    recruit(primeB, 1);
    onSwarmPersistNow(async () => undefined);
    unblock();
    expect(await barrier).toBe(true);
    staged.commit();
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages.map(m => m.text).join('')).toContain('A durable report');
    expect(offerMessagesForConversation(primeB.conversationId)?.messages).toEqual([]);
  });
});

it('archives accepted renamed assignments before broker expiry and restores saved legacy presentation before pruning', async () => {
  startSwarm(1);
  const worker = startWorker('worker-1', 'c-worker-archive');
  const session = await createSession({ conversationId: 'c-worker-archive', origin: {
    kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'task 1'
  } });
  finishAgent(worker.caller, 'done');
  const rejected = stageMessages(prime, [{ to: 'worker-1', text: 'Rejected task', label: 'Rejected' }]);
  rejected.rollback();
  // The archive follows the durable write in the background; it never holds up acceptance.
  await persistCriticalSwarmNow();
  await vi.waitFor(async () => expect((await getSession(session.id))?.workerAssignment?.label).toBe('Worker 1'));
  const staged = stageMessages(prime, [{ to: 'worker-1', text: 'New task', label: 'Review' }]);
  await persistCriticalSwarmNow(); staged.commit();
  await vi.waitFor(async () => expect((await getSession(session.id))?.workerAssignment).toMatchObject({ label: 'Review', task: 'New task' }));
  noteAgentAlive('c-worker-archive', 'call'); finishAgent(worker.caller, 'done'); releaseQuiescentRun();
  const saved = snapshotSwarm()!;
  resetAgentsForTests();
  vi.useFakeTimers();
  try {
    vi.setSystemTime(saved.savedAt + 8 * 24 * 60 * 60_000);
    // Startup projects the last accepted disk snapshot before restoring/pruning authority.
    await archiveWorkerAssignments(saved);
    restoreSwarm(saved);
    expect(swarmState().retainedWorkers).toEqual([]);
    resetSessionStoreForTests();
    expect((await getSession(session.id))?.workerAssignment).toMatchObject({ label: 'Review', task: 'New task' });
  } finally { vi.useRealTimers(); }
});

