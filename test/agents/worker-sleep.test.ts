import {
  PRIME_CHAT,
  PRIME_ID,
  WAKE_FAILURES_BEFORE_GIVING_UP,
  WORKER_CONTEXT_CEILING_TOKENS,
  WORKER_SILENCE_MS,
  acknowledgeOffers,
  claimWorkerRevival,
  dormantWorkerNotice,
  failWorkerRevival,
  fillContext,
  finishAgent,
  finishWorkerConversation,
  freeWorkerSlots,
  identify,
  isWorkerConversation,
  noteAgentAlive,
  noteAgentContextTokens,
  noteWorkerRevived,
  offerMessages,
  onReviveRequest,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  pendingCount,
  pendingWorkerRevivals,
  persistCriticalSwarmNow,
  prime,
  primeConversationGone,
  reactivateDormantRunForConversation,
  releaseQuiescentRun,
  resetAgentsForTests,
  resetSwarm,
  restoreSwarm,
  retiredWorkerForConversation,
  rollbackWorkerRevivalClaim,
  sendMessage,
  setEnabled,
  sleepSilentWorkers,
  sleepWorker,
  snapshotSwarm,
  spawn,
  stageFinishAgent,
  stageMessages,
  stageQueuedWorkerRevivals,
  stageWorkerConversationFinish,
  startSwarm,
  startWorker,
  statusForCaller,
  swarmRunning,
  swarmState,
  swarmStateForCaller,
  workerConversationGone,
  workerRevivalClaimed,
} from './context.js';
import type { Caller } from './context.js';
import { describe, expect, it } from 'vitest';

/** Workers sleep instead of ending, and the prime wakes them in the chat they already have. The expensive part of a run is the conversation a worker built up, and throwing that away after one task is what fills somebody's ChatGPT with abandoned chats. Everything here is about that one chat surviving — the tab closing, the prime pausing, the app restarting — and about the worker slot, which is the only genuinely scarce thing in the run. */
describe('a worker that is sleeping', () => {
  it.each(['browser', 'call'] as const)('replaces old assignment metadata before %s revival and retains the old report', (delivery) => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'task A completed');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'inspect task B' }]);
    staged.commit();
    const current = () => statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1');
    expect(current()).toMatchObject({ state: 'waking', label: 'Worker 1', task: 'inspect task B', result: null });
    expect(offerMessages(PRIME_ID).some((message) => message.text.includes('task A completed'))).toBe(true);
    const saved = snapshotSwarm();
    resetAgentsForTests();
    restoreSwarm(saved);
    expect(current()).toMatchObject({ state: 'waking', label: 'Worker 1', task: 'inspect task B', result: null });
    if (delivery === 'browser') {
      const revival = pendingWorkerRevivals()[0]!;
      expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    }
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(current()).toMatchObject({ state: 'active', label: 'Worker 1', task: 'inspect task B', result: null });
    finishAgent(worker.caller, 'task B completed');
    expect(current()).toMatchObject({ state: 'sleeping', result: 'task B completed' });
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmState().retainedWorkers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'worker-1', conversationId: 'c-worker-1', label: 'Worker 1', task: 'inspect task B' })
    ]));
  });

  it('durably renames a sleeping worker only when the prime supplies a new name', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'new task', label: 'Review' }])).toThrow(/sleeping worker/);
    finishAgent(worker.caller, 'done');
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'new task', label: ' ' }])).toThrow(/label/);
    stageMessages(prime, [{ to: 'worker-1', text: 'new task', label: ' Review ' }]).commit();
    const saved = snapshotSwarm();
    resetAgentsForTests();
    restoreSwarm(saved);
    expect(statusForCaller(prime).state.agents.find(agent => agent.id === 'worker-1')).toMatchObject({
      state: 'waking', label: 'Review', task: 'new task', result: null
    });
  });

  it('restores prior assignment metadata when a new assignment is rejected before acceptance', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'task A completed');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'inspect task B', label: 'Review' }]);
    staged.rollback();
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping', label: 'Worker 1', task: 'task 1', result: 'task A completed', pending: 0
    });
  });

  it('clears a completion result when the same assignment proves it is still running', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'premature report');
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')?.result).toBe('premature report');
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active', label: 'Worker 1', task: 'task 1', result: null
    });
  });

  it('refreshes queued-work assignment metadata and restores it if reservation rolls back', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'queued task B');
    finishAgent(worker.caller, 'task A completed');
    const staged = stageQueuedWorkerRevivals(['worker-1']);
    expect(staged.waking).toEqual(['worker-1']);
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'waking', label: 'Worker 1', task: 'queued task B', result: null
    });
    staged.rollback();
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping', label: 'Worker 1', task: 'task 1', result: 'task A completed', pending: 1
    });
    stageQueuedWorkerRevivals(['worker-1']).commit();
    failWorkerRevival('worker-1', 'fixture pre-send failure');
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping', label: 'Worker 1', task: 'queued task B', result: null, pending: 1
    });
  });

  it('lets a proven call from a parked sleeping worker take the slot back, as inside a live run', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done for now');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // Identity lookup alone never reactivates, and neither does the prime's own activity.
    expect(dormantWorkerNotice('c-worker-1')).toContain('WORKER_SLEEPING');
    expect(reactivateDormantRunForConversation(PRIME_CHAT)).toBe(false);
    expect(swarmRunning()).toBe(false);

    // The worker's call does: its family holds the slot again and the call revives it, which is exactly what the same call would have done a moment earlier, before the parking.
    expect(reactivateDormantRunForConversation('c-worker-1')).toBe(true);
    expect(swarmRunning()).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(dormantWorkerNotice('c-worker-1')).toBeNull();
  });

  it('keeps terminal workers parked while allowing sleeping workers their own independent incarnation', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'over the ceiling');
    expect(releaseQuiescentRun()).toBe(true);
    expect(reactivateDormantRunForConversation('c-worker-1')).toBe(false);
    expect(swarmRunning()).toBe(false);

    spawn({ workers: [{ task: 'other work' }], caller: { conversationId: 'c-prime-b' } });
    const other = startWorker('worker-1', 'c-worker-b-1');
    finishAgent(other.caller, 'B done');
    expect(releaseQuiescentRun()).toBe(true);
    startSwarm(1, { conversationId: 'c-prime-c' });
    expect(reactivateDormantRunForConversation('c-worker-b-1')).toBe(true);
    expect(dormantWorkerNotice('c-worker-b-1')).toBeNull();
  });

  it('lets MCP win only before the browser claims a waking worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();

    expect(workerRevivalClaimed('c-worker-1')).toBe(false);
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(workerRevivalClaimed('c-worker-1')).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'waking',
      revivable: false
    });

    // A failed durable browser claim restores the pre-cut arbitration window. Only then may a proven old-turn MCP call take the worker back to active and receive the queued inbox.
    expect(rollbackWorkerRevivalClaim('worker-1', 'c-worker-1')).toBe(true);
    expect(workerRevivalClaimed('c-worker-1')).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['second piece']);
  });

  it('finishes a delivered wake on the turn that starts after the sleep, not only on the first call', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    const sleptAt = swarmState().agents.find((agent) => agent.id === 'worker-1')!.sleptAt!;
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);

    // Claimed but not typed: the browser owns the payload, so nothing may end the wake yet — not a turn the page reports, and not the old turn being replayed either.
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)?.revived).toBe(false);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt)?.revived).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    // The typed message started a turn. That is the model running, and the wake is over.
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)).toMatchObject({ revived: true, report: null });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active',
      sleptAt: null
    });
    expect(pendingWorkerRevivals()).toEqual([]);
  });

  it('lets a turn end a pre-claim wake the way a call does, and refuses the page alone', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    const sleptAt = swarmState().agents.find((agent) => agent.id === 'worker-1')!.sleptAt!;
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'turn', sleptAt + 1)?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    // The queued words were never typed, so they ride on the worker's next result as usual.
    expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['second piece']);
  });

  it('lets fresh output revive a silence-based sleep without reviving an explicit finish', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const at = Date.now();
    expect(sleepSilentWorkers(at + WORKER_SILENCE_MS + 1000)).toHaveLength(1);
    expect(noteAgentAlive('c-worker-1', 'output', at + WORKER_SILENCE_MS + 2000)?.revived).toBe(true);
    finishAgent(worker.caller, 'Audit finished');
    expect(noteAgentAlive('c-worker-1', 'output', Date.now() + 1)?.revived).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
  });

  it('does not let a stop observed while waking end the wake', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'second piece' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const before = pendingCount(PRIME_ID);

    // The page replaying the settled answer that put the worker to sleep, the sweep proving that same quiet, and the old turn's late finish call: none of them is a fresh stop.
    expect(stageWorkerConversationFinish('c-worker-1', 'first piece done')).toBeNull();
    expect(finishWorkerConversation('c-worker-1', 'first piece done')).toBeNull();
    expect(sleepWorker('worker-1', 'It went quiet.')).toBeNull();
    expect(finishAgent(worker.caller, 'first piece done').repeat).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(pendingWorkerRevivals().map((entry) => entry.id)).toEqual(['worker-1']);
    expect(pendingCount(PRIME_ID), 'the prime is not told the same report twice').toBe(before);

    // The wake still ends the ordinary way.
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('never re-offers a browser-delivered revival row and only lets a later call acknowledge it', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'browser-owned wake text' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);

    // While the browser owns the wake, even a worker MCP result has no inbox delivery authority.
    expect(offerMessages('worker-1')).toEqual([]);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const offeredAt = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;

    // A call that began before (or in the same millisecond as) the browser ACK cannot use its later completion as evidence that it saw the injected user message.
    expect(acknowledgeOffers('worker-1', false, offeredAt)).toEqual([]);
    expect(offerMessages('worker-1')).toEqual([]);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(acknowledgeOffers('worker-1', false, offeredAt + 1)).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('preserves a revival-proven offer across restart instead of duplicating it through MCP', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'already typed into the worker chat' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
    const saved = snapshotSwarm()!;
    const offeredAt = saved.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;

    resetAgentsForTests();
    restoreSwarm(saved);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(offerMessages('worker-1')).toEqual([]);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(acknowledgeOffers('worker-1', false, offeredAt + 1)).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('does not type a browser-delivered revival row again after disable, re-enable and a later wake', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'already delivered before disable' }]).commit();
    const firstRevival = pendingWorkerRevivals()[0]!;
    expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', firstRevival.messageIds)).toBe(true);

    // Turning the feature off is an authoritative pause, not an acknowledgement from the worker. Keep the delivered row for at-least-once receipt accounting, but park the exact worker conversation without ever making that row eligible for browser injection again.
    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    expect(swarmRunning()).toBe(false);

    await setEnabled(true);
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'new work after re-enable' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    const secondRevival = pendingWorkerRevivals()[0]!;
    expect(secondRevival.conversationId).toBe('c-worker-1');
    expect(secondRevival.text).toContain('new work after re-enable');
    expect(secondRevival.text).not.toContain('already delivered before disable');
    expect(secondRevival.messageIds).toHaveLength(1);
  });

  it('keeps a staged finish result and prime report when disable parks the owner before commit', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const staged = stageFinishAgent(worker.caller, 'finish result racing the feature toggle');

    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    expect(swarmRunning()).toBe(false);

    // Ordinary/debounced state must not publish the finish before its acceptance barrier. The disable placeholder is sleeping, but the worker's actual result/report are still staged.
    const ordinary = snapshotSwarm()!;
    const ordinaryWorker = ordinary.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1');
    expect(ordinaryWorker?.info.result).not.toBe('finish result racing the feature toggle');

    const durable: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      durable.push(snapshot);
    });
    expect(await persistCriticalSwarmNow()).toBe(true);
    const durableHistory = durable.at(-1)?.dormantRuns?.[0]?.agents ?? [];
    expect(durableHistory.find((entry) => entry.info.id === 'worker-1')?.info).toMatchObject({
      state: 'sleeping',
      result: 'finish result racing the feature toggle',
      revivable: true
    });
    expect(durableHistory.find((entry) => entry.info.id === PRIME_ID)?.queue).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('finish result racing the feature toggle') })])
    );

    staged.commit();
    await setEnabled(true);
    const liveHistory = swarmStateForCaller(prime).agents;
    expect(liveHistory.find((entry) => entry.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      result: 'finish result racing the feature toggle',
      revivable: true
    });
    expect(liveHistory.find((entry) => entry.id === PRIME_ID)?.pending).toBe(1);
  });

  it('keeps an in-flight staged message unpublished normally but durable through a disable acceptance barrier', async () => {
    startSwarm(1);
    startWorker('worker-1');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'message accepted while disable races' }]);

    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    expect(snapshotSwarm()!.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([]);

    const durable: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      durable.push(snapshot);
    });
    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(durable.at(-1)?.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([
      expect.objectContaining({ text: 'message accepted while disable races' })
    ]);

    staged.commit();
    await setEnabled(true);
    expect(swarmStateForCaller(prime).agents.find((entry) => entry.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      pending: 1,
      conversationId: 'c-worker-1'
    });
  });

  it('retires already-offered inbox rows transactionally when the browser observes the worker final', async () => {
    const persisted: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async (snapshot) => {
      persisted.push(snapshot);
    });
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'also inspect the parser edge case');
    const offered = offerMessages('worker-1');
    expect(offered).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(1);

    const staged = stageWorkerConversationFinish('c-worker-1', 'final browser answer');
    expect(staged?.repeat).toBe(false);
    expect(await persistCriticalSwarmNow()).toBe(true);
    const projected = persisted.at(-1)!;
    // The one disk generation that says the worker slept also says the already-delivered row is gone and the prime report exists. Live readers stay pre-finish until commit.
    expect(projected.agents.find((entry) => entry.info.id === 'worker-1')?.queue).toEqual([]);
    expect(projected.agents.find((entry) => entry.info.id === PRIME_ID)?.queue.at(-1)?.text).toContain('final browser answer');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'active', pending: 1 });

    // A rejected acceptance write must restore the exact offer; it is still retryable work.
    staged!.rollback();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'active', pending: 1 });

    const retry = stageWorkerConversationFinish('c-worker-1', 'final browser answer');
    expect(await persistCriticalSwarmNow()).toBe(true);
    retry!.commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'sleeping', pending: 0 });

    stageMessages(prime, [{ to: 'worker-1', text: 'now inspect only the lexer' }]).commit();
    const revival = pendingWorkerRevivals()[0]!;
    expect(revival.text).toContain('now inspect only the lexer');
    expect(revival.text).not.toContain('parser edge case');
  });

  it('frees its slot without leaving the run, and is woken by being messaged', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');

    const asleep = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(asleep?.state).toBe('sleeping');
    expect(asleep?.revivable).toBe(true);
    // Still bound to its own chat: that binding is the worker, and waking it is reopening it.
    expect(asleep?.conversationId).toBe('c-worker-1');

    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'now do the second half' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();

    // The browser is asked for exactly one thing: this chat, with the prime's own words in it.
    const owed = pendingWorkerRevivals();
    expect(owed).toHaveLength(1);
    expect(owed[0]?.conversationId).toBe('c-worker-1');
    expect(owed[0]?.text).toContain('now do the second half');
    expect(owed[0]?.messageIds).toHaveLength(1);
  });

  it('keeps same-named workers isolated across prime histories and revives the original exact chat later', async () => {
    await setEnabled(true, 1);
    startSwarm(1);
    const first = startWorker('worker-1', 'c-worker-a-1');
    finishAgent(first.caller, 'prime A first piece done');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);

    const primeB: Caller = { conversationId: 'c-prime-b' };
    spawn({ workers: [{ task: 'prime B work' }], caller: primeB });
    const second = startWorker('worker-1', 'c-worker-b-1');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-b-1');

    // A can inspect its history while B owns execution, but cannot wake into B's capacity or enqueue work that would be stranded behind somebody else's active incarnation.
    const parallelWake = stageMessages(prime, [{ to: 'worker-1', text: 'A can wake alongside B' }]);
    parallelWake.rollback();
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      pending: 0,
      conversationId: 'c-worker-a-1'
    });

    finishAgent(second.caller, 'prime B done');
    expect(releaseQuiescentRun()).toBe(true);

    // Both histories keep their own worker-1 without collision after the active claim is gone.
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-a-1');
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-b-1');

    // Explicit owner work reclaims A's history and reserves the one configured slot for A's exact old chat, never B's same-named worker conversation.
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'resume A in the original chat' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    expect(freeWorkerSlots()).toBe(0);
    expect(pendingWorkerRevivals()).toHaveLength(1);
    expect(pendingWorkerRevivals()[0]).toMatchObject({ id: 'worker-1', conversationId: 'c-worker-a-1' });
    expect(pendingWorkerRevivals()[0]?.text).toContain('resume A in the original chat');
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe('c-worker-b-1');

    await setEnabled(true);
  });

  it('restores multiple parked prime histories from one durable snapshot without merging same-named workers', async () => {
    await setEnabled(true, 1);
    const primeB: Caller = { conversationId: 'c-prime-b' };

    startSwarm(1);
    const workerA = startWorker('worker-1', 'c-worker-a-restore');
    finishAgent(workerA.caller, 'A parked');
    expect(releaseQuiescentRun()).toBe(true);

    spawn({ workers: [{ label: 'B worker', task: 'B history' }], caller: primeB });
    const workerB = startWorker('worker-1', 'c-worker-b-restore');
    finishAgent(workerB.caller, 'B parked');
    expect(releaseQuiescentRun()).toBe(true);

    const saved = snapshotSwarm()!;
    expect(saved.version).toBe(7);
    expect(saved.runId).toBeNull();
    expect(saved.dormantRuns).toHaveLength(2);

    resetAgentsForTests();
    restoreSwarm(saved);

    expect(swarmRunning()).toBe(false);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-a-restore'
    });
    expect(swarmStateForCaller(primeB).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-b-restore'
    });

    await setEnabled(true);
  });

  it('explicit Clear swarm destroys parked histories and leaves their worker conversations fenced', () => {
    startSwarm(1);
    const worker = startWorker('worker-1', 'c-worker-clear-dormant');
    finishAgent(worker.caller, 'park before explicit clear');
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toBeTruthy();
    expect(swarmState()).toMatchObject({ running: false, retainedHistory: true, agents: [] });

    resetSwarm();

    expect(swarmState()).toMatchObject({ running: false, retainedHistory: false, agents: [] });
    expect(swarmStateForCaller(prime)).toMatchObject({ running: false, retainedHistory: false, agents: [] });
    expect(retiredWorkerForConversation('c-worker-clear-dormant')).toMatchObject({
      id: 'worker-1',
      conversationId: 'c-worker-clear-dormant'
    });
  });

  it('counts only working workers against the limit, so a third runs and the first is woken after', () => {
    startSwarm(3);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    const three = startWorker('worker-3');
    expect(freeWorkerSlots()).toBe(0);

    finishAgent(one.caller, 'done');
    expect(freeWorkerSlots()).toBe(1);
    finishAgent(two.caller, 'done');
    finishAgent(three.caller, 'done');
    expect(freeWorkerSlots()).toBe(3);

    // The first one is still there to be woken after the other two have been and gone.
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'back to you' }]);
    expect(staged.waking).toEqual(['worker-1']);
    staged.commit();
    expect(freeWorkerSlots()).toBe(2);
  });

  it('refuses to wake one when no slot is free, and queues nothing', () => {
    startSwarm(3);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    startWorker('worker-3');
    finishAgent(one.caller, 'done');
    finishAgent(two.caller, 'done');

    // Two sleeping workers, one free slot. The first send takes it; the second is refused outright rather than half-waking anybody.
    stageMessages(prime, [{ to: 'worker-1', text: 'wake up' }]).commit();
    expect(freeWorkerSlots()).toBe(1);
    stageMessages(prime, [{ to: 'worker-2', text: 'you too' }]).commit();
    expect(freeWorkerSlots()).toBe(0);

    const three = startWorker('worker-3');
    finishAgent(three.caller, 'done');
    stageMessages(prime, [{ to: 'worker-3', text: 'and you' }]).commit();
    expect(freeWorkerSlots()).toBe(0);
  });

  it('refuses a second message to a worker whose revival is still in flight', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    finishAgent(one.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'first' }]).commit();
    // Otherwise the second call's durable message could be stranded with no revival to carry it, if the first one later rolled back.
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'second' }])).toThrow(/REVIVE_IN_PROGRESS/);
  });

  it('gives the slot back and keeps the message queued when the browser cannot wake it', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'more work' }]).commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    const report = failWorkerRevival('worker-1', 'the browser could not open its chat');
    const back = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(back?.state).toBe('sleeping');
    expect(back?.revivable).toBe(true);
    expect(freeWorkerSlots()).toBe(3);
    // Nothing was typed, so nothing was delivered: the message is still queued and unoffered.
    expect(pendingCount('worker-1')).toBe(1);
    expect(report?.to).toBe(PRIME_ID);
    expect(report?.text).toContain('could not be woken');

    // And it can simply be tried again.
    const again = stageMessages(prime, [{ to: 'worker-1', text: 'still there?' }]);
    expect(again.waking).toEqual(['worker-1']);
    again.commit();
  });

  it('treats the browser typing the message as an offer, retired by the worker itself', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'the next piece' }]).commit();
    const owed = pendingWorkerRevivals()[0];

    // Another chat is not this worker's revival, whatever the extension reports.
    expect(noteWorkerRevived('worker-1', 'c-somebody-else', owed?.messageIds ?? [])).toBe(false);
    expect(noteWorkerRevived('worker-1', 'c-worker-1', owed?.messageIds ?? [])).toBe(true);
    let awake = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(awake?.state).toBe('waking');
    expect(awake?.result).toBeNull();
    // Offered, not acknowledged: the worker's own next call is what retires it.
    expect(pendingCount('worker-1')).toBe(1);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    awake = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(awake?.state).toBe('active');
    expect(acknowledgeOffers('worker-1')).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
  });

  it('survives its tab closing, and is still there to be woken', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');

    // Closing the tab of a chat nobody is using is not an ending.
    expect(workerConversationGone('c-worker-1')).toBe(false);
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('sleeping');
    expect(after?.conversationId).toBe('c-worker-1');
    expect(stageMessages(prime, [{ to: 'worker-1', text: 'reopen and carry on' }]).waking).toEqual(['worker-1']);
  });

  it('does not let a tab close steal a waking transaction before its exact send acknowledgement', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'reopen and carry on' }]);
    staged.commit();
    expect(staged.waking).toEqual(['worker-1']);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    // Reload/close can race the command ACK. The leased wake transaction owns the state until that ACK or its timeout settles; rewriting it to detached makes a truthful sent ACK fail.
    expect(workerConversationGone('c-worker-1')).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(noteWorkerRevived('worker-1', 'c-worker-1', staged.messages.map((message) => message.id))).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('does not strand work queued while a closed-tab worker was still considered active', async () => {
    startSwarm(1);
    startWorker('worker-1');
    expect(workerConversationGone('c-worker-1')).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');

    // The prime cannot safely inject a second user turn while the server-side turn may still be running, so this is initially an inbox message rather than an immediate revival.
    const queued = stageMessages(prime, [{ to: 'worker-1', text: 'when you are done, inspect the parser too' }]);
    expect(queued.waking).toEqual([]);
    queued.commit();
    expect(pendingCount('worker-1')).toBe(1);

    // Once silence proves the detached turn has stopped, that already-accepted work must be what wakes the worker. Leaving it merely sleeping strands the instruction until the prime happens to send a second message, even though the first call already said queued.
    sleepSilentWorkers(Date.now() + WORKER_SILENCE_MS + 1_000);
    const deferred = stageQueuedWorkerRevivals(['worker-1']);
    expect(deferred.waking).toEqual(['worker-1']);
    expect(await persistCriticalSwarmNow()).toBe(true);
    deferred.commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    expect(pendingWorkerRevivals()[0]?.text).toContain('inspect the parser too');
  });

  it('outlives the prime chat closing, because the user comes back and carries on', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    acknowledgeOffers(PRIME_ID);

    // The case this whole feature is for: the prime stops, the user reads the result, and the prime is asked for more an hour later. Ending the run here threw the workers away with it.
    expect(primeConversationGone(PRIME_CHAT)).toBe(false);
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    expect(noteAgentAlive(PRIME_CHAT)?.revived).toBe(true);
    expect(identify({ conversationId: PRIME_CHAT }).id).toBe(PRIME_ID);
    expect(stageMessages(prime, [{ to: 'worker-1', text: 'one more thing' }]).waking).toEqual(['worker-1']);
  });

  it('keeps a terminal worker report until the closed prime returns and acknowledges it', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.pending).toBe(1);

    // No reusable worker remains, but the result that made it terminal is still owed to the prime. Closing its tab must not destroy that report.
    expect(primeConversationGone(PRIME_CHAT)).toBe(false);
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.role === 'prime')?.state).toBe('detached');

    expect(noteAgentAlive(PRIME_CHAT)?.revived).toBe(true);
    expect(offerMessages(PRIME_ID).at(-1)?.text).toContain('[worker-1 finished] done');
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
  });

  it('keeps a worker revivable when it stops one token below the 400k ceiling', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    noteAgentContextTokens('c-worker-1', WORKER_CONTEXT_CEILING_TOKENS - 1);

    const done = finishAgent(worker.caller, 'still reusable');
    expect(done.info).toMatchObject({
      state: 'sleeping',
      revivable: true,
      contextTokens: WORKER_CONTEXT_CEILING_TOKENS - 1
    });
    expect(() => sendMessage(prime, 'worker-1', 'wake below the ceiling')).not.toThrow();
  });

  it('keeps working after it crosses the context ceiling, and only then ends for good', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');

    // Crossing is not an interruption. The worker is mid-task and stays exactly where it is; what changes is that this task is now its last one.
    fillContext('c-worker-1');
    const during = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(during?.state).toBe('active');
    expect(during?.revivable).toBe(false);
    // The ceiling revokes the *next wake*, not live messaging. Prime redirects sent while this exact worker is still active must remain deliverable through its normal inbox.
    expect(() => sendMessage(prime, 'worker-1', 'include the last parser edge case')).not.toThrow();
    expect(offerMessages('worker-1').at(-1)?.text).toBe('include the last parser edge case');
    expect(() => sendMessage(worker.caller, PRIME_ID, 'still going')).not.toThrow();

    const done = finishAgent(worker.caller, 'the last thing it will ever do');
    expect(done.info.state).toBe('finished');
    expect(done.info.revivable).toBe(false);
    expect(() => sendMessage(prime, 'worker-1', 'once more')).toThrow(/finished/);
  });

  it('promotes a sleeping worker to finished the moment its chat crosses the ceiling', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    // A late measurement of the same chat — the session store finishing its accounting after the worker stopped — is what makes that stop permanent.
    fillContext('c-worker-1');
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(after?.revivable).toBe(false);
  });

  it('upgrades a staged sleeping finish if the 400k crossing lands before its durable barrier', async () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const staged = stageFinishAgent(worker.caller, 'last piece done');
    expect(staged.info.state).toBe('sleeping');

    // Session accounting can finish while the broker fsync for the final observation is still pending. The one durable snapshot must not combine the new >=400k authority fact with the stale pre-crossing "sleeping/revivable" finish projection.
    fillContext('c-worker-1');
    let written: ReturnType<typeof snapshotSwarm> | undefined;
    onSwarmPersistNow(async (snapshot) => {
      written = snapshot;
    });
    expect(await persistCriticalSwarmNow()).toBe(true);

    expect(staged.info.state).toBe('finished');
    expect(staged.info.revivable).toBe(false);
    expect(staged.report?.text).toMatch(/finished for good|cannot be woken/i);
    const saved = written?.agents.find((entry) => entry.info.id === 'worker-1')?.info;
    expect(saved?.contextTokens).toBeGreaterThanOrEqual(WORKER_CONTEXT_CEILING_TOKENS);
    expect(saved?.state).toBe('finished');
    expect(saved?.revivable).toBe(false);

    staged.commit();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
  });

  it('never rolls a waking worker back to revivable sleep after it crosses 400k', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    const staged = stageMessages(prime, [{ to: 'worker-1', text: 'one more task' }]);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');

    fillContext('c-worker-1');
    staged.rollback();

    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(after?.revivable).toBe(false);
  });

  /** On 2026-09-03 worker-7's conversation answered every load with "This content is unavailable". Four wakes each waited out their deadline and each told the prime to try once more — thirty minutes before it spawned the replacement it could have spawned after the first repeat. The second failed wake with nothing heard from the chat in between is the verdict on the chat. */
  it('ends a worker whose chat fails two wakes in a row, and lets that chat bring it back', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    expect(WAKE_FAILURES_BEFORE_GIVING_UP).toBe(2);

    stageMessages(prime, [{ to: 'worker-1', text: 'more work' }]).commit();
    failWorkerRevival('worker-1', 'the chat this app opened did not report back in time');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

    stageMessages(prime, [{ to: 'worker-1', text: 'still there?' }]).commit();
    const report = failWorkerRevival('worker-1', 'the chat this app opened did not report back in time');
    const gone = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(gone?.state).toBe('failed');
    expect(freeWorkerSlots()).toBe(3);
    expect(report?.to).toBe(PRIME_ID);
    expect(report?.text).toMatch(/2 revivals in a row/);
    expect(report?.text).toMatch(/spawn a replacement/);
    expect(report?.text).not.toMatch(/try agents action=message/i);
    // Its inbox is kept: a revivable failure is a verdict on reachability, not on the work.
    expect(pendingCount('worker-1')).toBe(2);
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'third try' }])).toThrow();

    // The chat calling in again is first-hand proof it can be reached after all.
    const back = noteAgentAlive('c-worker-1', 'call');
    expect(back?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('forgives a single failed wake once the chat has been heard from since', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');

    stageMessages(prime, [{ to: 'worker-1', text: 'more work' }]).commit();
    failWorkerRevival('worker-1', 'browser could not reopen the chat');
    // The worker's page reports in between: the count starts over.
    noteAgentAlive('c-worker-1', 'page');

    stageMessages(prime, [{ to: 'worker-1', text: 'again' }]).commit();
    failWorkerRevival('worker-1', 'browser could not reopen the chat');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
  });

  /** A worker chat never becomes an ordinary chat by finishing. The owner lookup deliberately forgets a worker that is over; the Goal and compaction fences must not, or a chat that crossed the ceiling is compacted like a plain chat over the line (2026-09-03, twice). */
  it('still counts a finished worker chat as a worker chat', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(isWorkerConversation('c-worker-1')).toBe(true);
    expect(isWorkerConversation('c-prime')).toBe(false);
    expect(isWorkerConversation('c-nobody')).toBe(false);

    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done at the ceiling');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
    expect(isWorkerConversation('c-worker-1')).toBe(true);
  });

  it('terminalises a failed in-flight revival if that chat crossed 400k while waking', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');
    stageMessages(prime, [{ to: 'worker-1', text: 'one more task' }]).commit();
    fillContext('c-worker-1');

    const report = failWorkerRevival('worker-1', 'browser could not reopen the chat');
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(after?.revivable).toBe(false);
    expect(report?.text).toMatch(/context limit|cannot be woken|finished for good/i);
    expect(report?.text).not.toMatch(/try agents action=message/i);
  });

  it('does not leave accepted prime work stranded when a sleeping worker crosses the ceiling', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'first piece done');

    // The prime got an accepted send, but the browser failed before typing it. The worker is asleep again with real unread work in its durable inbox.
    stageMessages(prime, [{ to: 'worker-1', text: 'finish the parser audit' }]).commit();
    failWorkerRevival('worker-1', 'browser could not reopen the chat');
    expect(pendingCount('worker-1')).toBe(1);

    // A late session measurement proves this chat cannot be reused after all. Terminalising it must retire work that can no longer be delivered and tell the prime, rather than leaving a terminal row with a permanently nonzero inbox and a previously-successful send.
    fillContext('c-worker-1');
    const after = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(after?.state).toBe('finished');
    expect(pendingCount('worker-1')).toBe(0);
    expect(
      offerMessages(PRIME_ID).some(
        (message) => message.text.includes('finish the parser audit') && /could not be delivered|not delivered/i.test(message.text)
      )
    ).toBe(true);
  });

  it('never un-crosses the ceiling on a smaller reading', () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    noteAgentContextTokens('c-worker-1', 1_000);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
  });

  it('keeps an accepted wake across a restart, and asks the browser for it again', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');
    stageMessages(prime, [{ to: 'worker-1', text: 'do the second half' }]).commit();
    const snapshot = snapshotSwarm();

    resetAgentsForTests();
    restoreSwarm(snapshot);

    // The accepted send is durable and so is the reservation carrying it. Demoting this worker back to sleeping on restore would leave the prime's message queued with nothing left to deliver it.
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    const asked: string[] = [];
    onReviveRequest((revivals) => asked.push(...revivals.map((revival) => revival.id)));
    expect(asked).toEqual(['worker-1']);
    expect(pendingWorkerRevivals()[0]?.text).toContain('do the second half');
  });

  it('restores a sleeping worker as itself, still wakeable in the chat it kept', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    finishAgent(one.caller, 'done');
    const snapshot = snapshotSwarm();
    resetAgentsForTests();
    restoreSwarm(snapshot);

    const restored = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(restored?.state).toBe('sleeping');
    expect(restored?.revivable).toBe(true);
    expect(stageMessages(prime, [{ to: 'worker-1', text: 'again' }]).waking).toEqual(['worker-1']);
  });
});

