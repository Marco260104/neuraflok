import {
  AgentError,
  PAGE_GENERATING_FRESH_MS,
  PRIME_CHAT,
  PRIME_ID,
  WORKER_CONTEXT_CEILING_TOKENS,
  WORKER_SILENCE_MS,
  WORKER_THINKING_MAX_MS,
  acknowledgeOffers,
  acknowledgeOffersForConversation,
  clearAgent,
  closableWorkerConversations,
  dormantWorkerNotice,
  endedWorkerNotice,
  failAgent,
  fillContext,
  finishAgent,
  finishWorkerConversation,
  freeWorkerSlots,
  noteAgentAlive,
  noteAgentContextTokens,
  notePageGenerating,
  offerMessages,
  offerMessagesForConversation,
  onSwarmEnd,
  onSwarmPersistNow,
  pauseSwarmForDisable,
  pendingCount,
  persistCriticalSwarmNow,
  prime,
  primeForOwnedConversation,
  reactivateDormantRunForConversation,
  recoverSilentCeilingWorker,
  releaseQuiescentRun,
  resetAgentsForTests,
  resetSwarm,
  restoreSwarm,
  retiredWorkerForConversation,
  sendMessage,
  setEnabled,
  setWorkspaceFor,
  silentCeilingRecoveryAuthority,
  silentCeilingRecoveryTurn,
  sleepSilentWorkers,
  snapshotSwarm,
  spawn,
  stageMessages,
  stageWorkerConversationFinish,
  startSwarm,
  startWorker,
  statusForCaller,
  swarmRunning,
  swarmState,
  swarmStateForCaller,
  workerConversationGone,
  workspaceForChat,
} from './context.js';
import type { Caller } from './context.js';
import { describe, expect, it, vi } from 'vitest';

describe('star topology', () => {
  it('allows worker → prime and prime → worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(sendMessage(worker.caller, PRIME_ID, 'found something').to).toBe(PRIME_ID);
    expect(sendMessage(prime, 'worker-1', 'noted, carry on').to).toBe('worker-1');
  });

  it('forbids worker → worker in both directions', () => {
    startSwarm(2);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');
    expect(() => sendMessage(one.caller, 'worker-2', 'psst')).toThrow(AgentError);
    expect(() => sendMessage(two.caller, 'worker-1', 'psst')).toThrow(AgentError);
    expect(pendingCount('worker-1')).toBe(0);
    expect(pendingCount('worker-2')).toBe(0);
  });

  it('refuses empty text and unknown recipients, and takes a sleeping one', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(() => sendMessage(worker.caller, PRIME_ID, '   ')).toThrow(/empty/i);
    expect(() => sendMessage(prime, 'worker-9', 'hello')).toThrow(/Unknown agent/);

    // Reporting is not ending. The worker sleeps, its slot goes back, and the prime messaging it is how it gets woken — in the chat it already has, not in a new one.
    finishAgent(worker.caller, 'done');
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
    expect(freeWorkerSlots()).toBe(3);
    expect(() => sendMessage(prime, 'worker-1', 'one more thing')).not.toThrow();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
    // Waking is holding a slot, not asking for one later: the reservation happens here, so two sends racing for the last slot cannot both win it.
    expect(freeWorkerSlots()).toBe(2);
  });

  it('refuses a worker that ended for good, because its chat has no room left', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    expect(finishAgent(worker.caller, 'done').info.state).toBe('finished');
    expect(() => sendMessage(prime, 'worker-1', 'one more thing')).toThrow(/finished/);
  });
});

describe('at-least-once delivery', () => {
  it('re-offers an unacknowledged message and retires it only on the next call', () => {
    startSwarm(1);
    startWorker('worker-1');
    sendMessage(prime, 'worker-1', 'a correction');

    const first = offerMessages('worker-1');
    expect(first).toHaveLength(1);
    expect(first[0]?.offers).toBe(1);

    // The result never came back, so the same message is offered again rather than lost.
    const second = offerMessages('worker-1');
    expect(second).toHaveLength(1);
    expect(second[0]?.offers).toBe(2);

    // The worker's next authenticated call is the evidence the previous result arrived.
    expect(acknowledgeOffers('worker-1')).toHaveLength(1);
    expect(pendingCount('worker-1')).toBe(0);
    expect(offerMessages('worker-1')).toEqual([]);
  });

  it('offers a bounded inbox batch so a deep queue cannot make every tool result enormous', () => {
    startSwarm(1);
    startWorker('worker-1');
    for (let index = 0; index < 20; index++) {
      sendMessage(prime, 'worker-1', `message-${index} ${'x'.repeat(3_980)}`);
    }

    const first = offerMessages('worker-1');
    // The old broker appended every waiting row in one go. Even this 20-message fixture was ~80k characters; the real queue limit permits ~800k before MCP framing/tool output is counted. A result too large to reach ChatGPT is then re-offered unchanged forever.
    expect(first.length).toBeLessThan(20);
    expect(first.reduce((sum, message) => sum + message.text.length, 0)).toBeLessThanOrEqual(32_000);

    const delivered = acknowledgeOffers('worker-1');
    expect(delivered.map((message) => message.id)).toEqual(first.map((message) => message.id));
    const second = offerMessages('worker-1');
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((message) => first.some((prior) => prior.id === message.id))).toBe(false);
  });

  it('refuses queue overflow instead of silently dropping an older message', () => {
    startSwarm(1);
    startWorker('worker-1');
    for (let i = 0; i < 200; i++) sendMessage(prime, 'worker-1', `message ${i}`);
    expect(() => sendMessage(prime, 'worker-1', 'one too many')).toThrow(AgentError);
    expect(pendingCount('worker-1')).toBe(200);
  });

  // A run does not end because its workers did. The prime is the run, and it is still sitting there able to spawn more; only the prime chat going away ends it.
  it('queues each final report for the prime and leaves the run standing', () => {
    const ended: string[] = [];
    onSwarmEnd((reason) => ended.push(reason));
    startSwarm(2);
    const one = startWorker('worker-1');
    const two = startWorker('worker-2');

    const first = finishAgent(one.caller, 'part one done');
    expect(first.report?.to).toBe(PRIME_ID);
    expect(first.report?.text).toContain('part one done');

    finishAgent(two.caller, 'part two done');
    expect(ended).toEqual([]);
    expect(swarmRunning()).toBe(true);
    expect(pendingCount(PRIME_ID)).toBe(2);
  });

  it('releases the global run as soon as the last worker stops while preserving the prime report', () => {
    const ended: string[] = [];
    onSwarmEnd((reason) => ended.push(reason));
    startSwarm(1);
    const worker = startWorker('worker-1');
    // Only a worker whose own chat has no room left is terminal. Anything else sleeps, and a run that still owns a wakeable worker is not a run anybody has finished with.
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'finished safely');

    // The report belongs to the prime history, not to the scarce global execution claim.
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
    // Parking is not destructive teardown and therefore must not fire the end listener that cancels browser work / installs retired-worker leases.
    expect(ended).toEqual([]);

    const dormant = statusForCaller(prime);
    expect(dormant.state.running).toBe(false);
    expect(dormant.state.agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(1);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    expect(acknowledgeOffersForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    expect(statusForCaller(prime).state.agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(0);
  });

  it('keeps the prime on the project it moved to during the swarm after the run ends', () => {
    setWorkspaceFor(`chat:${PRIME_CHAT}`, { virtual: '/root/project-a', real: 'C:\\root\\project-a' });
    startSwarm(1);
    const worker = startWorker('worker-1');

    // Spawn mirrored project A into `agent:prime`. During the live run the prime is resolved under that agent identity, so an explicit absolute-path call now moves only that key to B.
    setWorkspaceFor(`chat:${PRIME_CHAT}`, { virtual: '/root/project-b', real: 'C:\\root\\project-b' });
    expect(workspaceForChat(PRIME_CHAT)?.virtual).toBe('/root/project-b');

    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(releaseQuiescentRun()).toBe(true);

    // After endRun the kernel stops assigning `agent:prime`; the conversation key therefore has to carry forward the newest workspace rather than reviving the pre-swarm project.
    expect(workspaceForChat(PRIME_CHAT)?.virtual).toBe('/root/project-b');
  });

  it('keeps a finished worker as a durable dormant identity rather than retiring its history', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'finished safely');

    // Normal parking is ownership preservation, not destructive retirement.
    expect(releaseQuiescentRun()).toBe(true);
    expect(swarmRunning()).toBe(false);
    expect(retiredWorkerForConversation('c-worker-1')).toBeNull();
    expect(dormantWorkerNotice('c-worker-1')).toMatch(/WORKER_ENDED.*worker-1/i);
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'finished',
      revivable: false,
      conversationId: 'c-worker-1'
    });
  });

  it('does not release the run while a durability-gated message is still unpublished', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');

    // A production agents::message call stages first, then waits for its immediate durable barrier before commit publishes it to inbox readers. Keep that exact window open.
    const staged = stageMessages(worker.caller, [{ to: PRIME_ID, text: 'one last finding' }]);
    expect(pendingCount(PRIME_ID)).toBe(0);
    expect(offerMessages(PRIME_ID)).toEqual([]);

    // A parallel finish can make the last worker terminal while its staged message is still in that acceptance window. Retire the visible finish report exactly as two later prime calls would, leaving pending=0 even though the unpublished message still exists in the queue.
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'finished');
    expect(offerMessages(PRIME_ID)).toHaveLength(1);
    expect(acknowledgeOffers(PRIME_ID)).toHaveLength(1);
    expect(pendingCount(PRIME_ID)).toBe(0);

    // Ending the run here detaches the staged message object from broker state. Its original tool call can later commit and report success, but no prime inbox exists to receive it.
    expect(releaseQuiescentRun()).toBe(false);
    expect(swarmRunning()).toBe(true);

    staged.commit();
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(releaseQuiescentRun()).toBe(true);
    expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    expect(acknowledgeOffersForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
  });
});

describe('an agent that has ended', () => {
  it('treats a repeated finish as the same finish and reports to the prime only once', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    const first = finishAgent(worker.caller, 'the work, described');
    expect(first.repeat).toBe(false);
    const again = finishAgent(worker.caller, 'the work, described slightly differently');
    expect(again.repeat).toBe(true);
    expect(again.report).toBeNull();
    expect(pendingCount(PRIME_ID)).toBe(1);
  });

  it('stops a worker that ended for good sending anything more from its own chat', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    expect(() => sendMessage(worker.caller, PRIME_ID, 'actually, one more thing')).toThrow(AgentError);
  });

  it('lets a worker that only fell asleep carry on talking, because it evidently had not stopped', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    finishAgent(worker.caller, 'done');

    // A tool call from that chat is first-hand proof the model is still running there, which is worth more than the app's guess a moment ago. It takes its slot back and the prime is told, because it was told the opposite.
    expect(() => sendMessage(worker.caller, PRIME_ID, 'actually, one more thing')).not.toThrow();
    expect(noteAgentAlive('c-worker-1')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    expect(offerMessages(PRIME_ID).some((message) => /awake again/.test(message.text))).toBe(true);
  });

  it('is told so on its own next tool call, instead of quietly working on', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    fillContext('c-worker-1');
    finishAgent(worker.caller, 'done');
    // The chat itself does not stop when the slot does — the turn is ChatGPT's — so the next call from it has to be the sentence that says the work is over.
    const notice = endedWorkerNotice(worker.caller.conversationId);
    expect(notice).toMatch(/WORKER_ENDED/);
    expect(notice).toMatch(/worker-1/);
    expect(endedWorkerNotice('c-stranger')).toBeNull();
  });

  it('refuses to finish the prime, because a run with no prime is a reset', () => {
    startSwarm(1);
    expect(() => finishAgent(prime, 'I am done')).toThrow(/prime agent does not finish/);
  });
});

describe('a worker whose chat never opened', () => {
  it('ends as failed, frees its slot, and reports to the prime', () => {
    startSwarm(1);
    const report = failAgent('worker-1', 'no provider tab could be opened')?.report;
    expect(report?.to).toBe(PRIME_ID);
    expect(report?.text).toContain('Resolve the reported startup problem before spawning a replacement');
    const info = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(info?.state).toBe('failed');
    expect(info?.result).toContain('no provider tab');
    expect(pendingCount(PRIME_ID)).toBe(1);
    // The slot is free again: a replacement may be created inside the same limit.
    expect(() => spawn({ workers: [{ task: 'replacement' }], caller: prime })).not.toThrow();
  });

  it('stays failed when its chat was never the reason, so no stray tab can revive the slot', () => {
    startSwarm(1);
    startWorker('worker-1');
    failAgent('worker-1', 'tab never opened');
    // A verdict about the work is final. Only a worker given up on because its *view* went away may be taken back, and this one was not.
    expect(noteAgentAlive('c-worker-1')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('failed');
  });

  it('refuses to fail the prime', () => {
    startSwarm(1);
    expect(failAgent(PRIME_ID, 'whatever')).toBeNull();
    expect(swarmRunning()).toBe(true);
  });
});

describe('a worker whose chat closed', () => {
  it.each([false, true])('sleeps after three minutes of real inactivity even with repeated page reports (detached=%s)', detached => {
    startSwarm(1);
    startWorker('worker-1');
    const clock = vi.spyOn(Date, 'now');
    const started = Date.now();
    try {
      clock.mockReturnValue(started);
      noteAgentAlive('c-worker-1', 'call');
      clock.mockReturnValue(started + 179_999);
      if (detached) workerConversationGone('c-worker-1');
      noteAgentAlive('c-worker-1', 'page');
      expect(sleepSilentWorkers()).toEqual([]);
      clock.mockReturnValue(started + 180_000);
      noteAgentAlive('c-worker-1', 'page');
      expect(sleepSilentWorkers()).toHaveLength(1);
      const slept = swarmState().agents.find(agent => agent.id === 'worker-1')!;
      expect(slept).toMatchObject({ state: 'sleeping', lastSeenAt: started });
      clock.mockReturnValue(started + 360_000);
      noteAgentAlive('c-worker-1', 'page');
      noteAgentAlive('c-worker-1', 'turn', started);
      expect(swarmState().agents.find(agent => agent.id === 'worker-1')).toMatchObject({ state: 'sleeping', lastSeenAt: started });
      expect(sleepSilentWorkers()).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it('keeps a worker awake while its own page says the turn is still thinking (#882)', () => {
    startSwarm(1);
    startWorker('worker-1');
    const started = Date.now(), clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(started);
      noteAgentAlive('c-worker-1', 'call');
      // A long think: no call and no new output for half an hour, but the page polls on.
      for (let at = 60_000; at <= 30 * 60_000; at += 60_000) {
        clock.mockReturnValue(started + at);
        notePageGenerating('c-worker-1', true);
        expect(sleepSilentWorkers()).toEqual([]);
      }
      // The page saying so is not work: it never renews the work clock.
      expect(swarmState().agents.find(agent => agent.id === 'worker-1')).toMatchObject({ state: 'active', lastSeenAt: started });
      // The turn ended; silence counts again at once.
      notePageGenerating('c-worker-1', false);
      expect(sleepSilentWorkers()).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });

  it('does not let a page that went quiet or a turn open for hours hold a worker awake', () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    const started = Date.now(), clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(started);
      noteAgentAlive('c-worker-1', 'call');
      noteAgentAlive('c-worker-2', 'call');
      notePageGenerating('c-worker-1', true);
      // worker-1's page stopped polling (tab gone, browser closed): its last word goes stale.
      expect(PAGE_GENERATING_FRESH_MS).toBeLessThan(WORKER_SILENCE_MS);
      clock.mockReturnValue(started + WORKER_SILENCE_MS);
      notePageGenerating('c-worker-2', true);
      expect(sleepSilentWorkers().map(slept => slept.info.id)).toEqual(['worker-1']);
      // worker-2 keeps saying it is generating, but past the cap that alone no longer counts.
      clock.mockReturnValue(started + WORKER_THINKING_MAX_MS - 1);
      notePageGenerating('c-worker-2', true);
      expect(sleepSilentWorkers()).toEqual([]);
      clock.mockReturnValue(started + WORKER_THINKING_MAX_MS);
      notePageGenerating('c-worker-2', true);
      expect(sleepSilentWorkers().map(slept => slept.info.id)).toEqual(['worker-2']);
    } finally { clock.mockRestore(); }
  });

  it('renews the three-minute deadline only for new accepted work, not replayed turn evidence', () => {
    startSwarm(1);
    startWorker('worker-1');
    const started = Date.now(), clock = vi.spyOn(Date, 'now');
    try {
      noteAgentAlive('c-worker-1', 'call');
      clock.mockReturnValue(started + 120_000);
      noteAgentAlive('c-worker-1', 'turn', started + 120_000);
      clock.mockReturnValue(started + 180_000);
      expect(sleepSilentWorkers()).toEqual([]);
      clock.mockReturnValue(started + 299_999);
      noteAgentAlive('c-worker-1', 'turn', started + 120_000);
      expect(sleepSilentWorkers()).toEqual([]);
      clock.mockReturnValue(started + 300_000);
      expect(sleepSilentWorkers()).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });

  it('detaches the exact bound worker rather than ending it: the turn is not the tab', () => {
    startSwarm(1);
    startWorker('worker-1');
    expect(workerConversationGone('c-worker-1')).toBe(true);
    const info = swarmState().agents.find((agent) => agent.id === 'worker-1');
    // Still live, still holding its slot, still owed a result. A ChatGPT turn runs on OpenAI's servers, so a closed tab says nothing about whether the work stopped.
    expect(info?.state).toBe('detached');
    // And the prime is told nothing yet, because there is nothing it could act on.
    expect(pendingCount(PRIME_ID)).toBe(0);
  });

  it('keeps a closed-tab worker detached while its server-side turn keeps calling, until a page returns', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // A connector call can continue after the tab was closed because the model turn is server-side. It proves liveness, but not that a browser document exists again. Keep the detached state/slot and restart its silence clock from this call rather than losing the only path that can eventually release a worker whose page never returns.
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
    expect(sleepSilentWorkers(Date.now() + WORKER_SILENCE_MS - 1_000)).toEqual([]);

    // A page observation is the first-hand evidence that the browser view really came back.
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    // It was never out of the run, so its own finish still lands the ordinary way.
    expect(finishAgent(worker.caller, 'done')?.info.state).toBe('sleeping');
  });

  it('sleeps a detached worker on durable completion, and its open tab never wakes it', () => {
    startSwarm(1);
    startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // The stale-run recovery path can observe the durable turn completion after the browser view is already gone. The work stopped; the worker did not end.
    expect(finishWorkerConversation('c-worker-1', 'durably completed')?.info.state).toBe('sleeping');
    const slept = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(slept?.revivable).toBe(true);
    expect(freeWorkerSlots()).toBe(3);

    // Its tab is still open and still reporting the same settled transcript. Waking on that would hand the slot straight back every time the page said hello.
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
  });

  it('ends a durably completed worker for good once its chat is full', () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    expect(finishWorkerConversation('c-worker-1', 'durably completed')?.info.state).toBe('finished');
    const finished = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(finished?.revivable).toBe(false);
    expect(noteAgentAlive('c-worker-1', 'page')?.revived).toBe(false);
  });

  it('parks a ceiling worker on an unresolved turn without granting a new-task wake', () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    const now = Date.now();

    const [parked] = sleepSilentWorkers(
      now + WORKER_SILENCE_MS + 1,
      undefined,
      () => false,
      () => 'turn-old'
    );
    expect(parked?.info).toMatchObject({
      state: 'sleeping',
      revivable: false,
      silenceRecoveryTurnId: 'turn-old'
    });
    expect(freeWorkerSlots()).toBe(3);
    expect(silentCeilingRecoveryTurn('c-worker-1')).toBe('turn-old');
    expect(closableWorkerConversations(0)).not.toContain('c-worker-1');
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'new task' }])).toThrow(/context-limited|unresolved/i);
    expect(noteAgentAlive('c-worker-1', 'call')?.revived).toBe(false);
    expect(recoverSilentCeilingWorker('c-worker-1', 'turn-new')).toBeNull();

    const recovered = recoverSilentCeilingWorker('c-worker-1', 'turn-old');
    expect(recovered).toMatchObject({ agentId: 'worker-1', revived: true });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'active',
      revivable: false,
      silenceRecoveryTurnId: null
    });
  });

  it('parks rather than terminalizes missing turn identity at the ceiling', () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');

    expect(sleepSilentWorkers(
      Date.now() + WORKER_SILENCE_MS + 1,
      undefined,
      () => false,
      () => null
    )).toHaveLength(1);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: false,
      silenceParked: true,
      silenceRecoveryTurnId: null
    });
    expect(closableWorkerConversations(0)).not.toContain('c-worker-1');
  });

  it('clears a dormant ceiling-silence marker as explicit terminal user authority', () => {
    startSwarm(1);
    startWorker('worker-1', 'c-worker-clear-ceiling-park');
    fillContext('c-worker-clear-ceiling-park');
    sleepSilentWorkers(
      Date.now() + WORKER_SILENCE_MS + 1,
      undefined,
      () => false,
      () => 'turn-clear-ceiling-park',
      () => 11
    );
    expect(releaseQuiescentRun()).toBe(true);

    resetSwarm();

    expect(retiredWorkerForConversation('c-worker-clear-ceiling-park')).toMatchObject({
      id: 'worker-1',
      conversationId: 'c-worker-clear-ceiling-park'
    });
    expect(silentCeilingRecoveryTurn('c-worker-clear-ceiling-park')).toBeNull();
  });

  it('preserves an ambiguous below-ceiling sleep when delayed accounting later crosses 400k', () => {
    startSwarm(1);
    startWorker('worker-1');
    noteAgentContextTokens('c-worker-1', WORKER_CONTEXT_CEILING_TOKENS - 1);

    const [slept] = sleepSilentWorkers(
      Date.now() + WORKER_SILENCE_MS + 1,
      undefined,
      () => false,
      () => 'turn-delayed-meter'
    );
    expect(slept?.info).toMatchObject({
      state: 'sleeping',
      revivable: true,
      silenceRecoveryTurnId: 'turn-delayed-meter'
    });

    noteAgentContextTokens('c-worker-1', WORKER_CONTEXT_CEILING_TOKENS);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: false,
      silenceRecoveryTurnId: 'turn-delayed-meter'
    });
    expect(() => stageMessages(prime, [{ to: 'worker-1', text: 'new task' }])).toThrow(/context-limited|unresolved/i);
  });

  it('preserves exact ceiling-silence recovery authority across parked restore', () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    sleepSilentWorkers(
      Date.now() + WORKER_SILENCE_MS + 1,
      undefined,
      () => false,
      () => 'turn-old',
      () => 17
    );
    releaseQuiescentRun();
    const saved = snapshotSwarm()!;
    resetAgentsForTests();
    restoreSwarm(saved);

    expect(silentCeilingRecoveryTurn('c-worker-1')).toBe('turn-old');
    expect(silentCeilingRecoveryAuthority('c-worker-1')).toEqual({ turnId: 'turn-old', requestOriginMax: 17 });
    expect(reactivateDormantRunForConversation('c-worker-1')).toBe(false);
    expect(recoverSilentCeilingWorker('c-worker-1', 'turn-old')).toMatchObject({
      agentId: 'worker-1',
      revived: true
    });
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
  });

  it('keeps a ceiling-silenced worker fenced until its staged terminal snapshot commits', async () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    sleepSilentWorkers(
      Date.now() + WORKER_SILENCE_MS + 1,
      undefined,
      () => false,
      () => 'turn-terminal-stage',
      () => 7
    );
    const staged = stageWorkerConversationFinish('c-worker-1', 'durably done')!;
    const writes: Array<ReturnType<typeof snapshotSwarm>> = [];
    onSwarmPersistNow(async snapshot => { writes.push(structuredClone(snapshot)); });

    expect(await persistCriticalSwarmNow()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      silenceParked: true,
      silenceRecoveryTurnId: 'turn-terminal-stage'
    });
    const durableWorker = writes.at(-1)?.activeRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1')?.info;
    expect(durableWorker).toMatchObject({
      state: 'finished',
      revivable: false,
      silenceParked: false,
      silenceRecoveryTurnId: null,
      silenceRecoveryRequestOriginMax: null
    });

    staged.rollback();
    expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      revivable: false,
      silenceParked: true,
      silenceRecoveryTurnId: 'turn-terminal-stage'
    });
    onSwarmPersistNow(async () => undefined);
  });

  it('treats feature disable as terminal evidence for a ceiling-silenced worker', async () => {
    startSwarm(1);
    startWorker('worker-1');
    fillContext('c-worker-1');
    sleepSilentWorkers(
      Date.now() + WORKER_SILENCE_MS + 1,
      undefined,
      () => false,
      () => 'turn-old'
    );
    expect(releaseQuiescentRun()).toBe(true);

    await setEnabled(false);
    expect(pauseSwarmForDisable()).toBe(true);
    const worker = snapshotSwarm()!.dormantRuns?.[0]?.agents.find((entry) => entry.info.id === 'worker-1');
    expect(worker?.info).toMatchObject({
      state: 'finished',
      revivable: false,
      silenceRecoveryTurnId: null
    });
    await setEnabled(true);
  });

  it('sleeps a detached worker only once it has also gone quiet, and reports that to prime', () => {
    startSwarm(1);
    startWorker('worker-1');
    workerConversationGone('c-worker-1');

    // Nothing has been heard from it since the tab went. Its slot goes back, but nothing here is evidence that it is done — the chat is intact and the prime can wake it in place.
    expect(sleepSilentWorkers(Date.now() + WORKER_SILENCE_MS + 1_000).length).toBe(1);
    const slept = swarmState().agents.find((agent) => agent.id === 'worker-1');
    expect(slept?.state).toBe('sleeping');
    expect(slept?.revivable).toBe(true);
    expect(pendingCount(PRIME_ID)).toBe(1);
    expect(() => spawn({ workers: [{ task: 'replacement after close' }], caller: prime })).not.toThrow();

    // A worker that was quiet for six minutes and then calls again was, evidently, still going.
    const back = noteAgentAlive('c-worker-1');
    expect(back?.revived).toBe(true);
    expect(back?.report?.to).toBe(PRIME_ID);
    expect(back?.report?.text).toMatch(/awake again/);
  });

  it('does nothing for the prime, a stranger, or an already finished worker', () => {
    startSwarm(1);
    const worker = startWorker('worker-1');
    expect(workerConversationGone(PRIME_CHAT)).toBe(false);
    expect(workerConversationGone('c-stranger')).toBe(false);
    finishAgent(worker.caller, 'done');
    expect(workerConversationGone('c-worker-1')).toBe(false);
  });
});

describe('clearing one agent from the app', () => {
  it('frees a worker slot without touching its siblings, and tells the prime a person did it', () => {
    startSwarm(2);
    startWorker('worker-1');
    startWorker('worker-2');
    const result = clearAgent('worker-1');
    expect(result.cleared).toBe('worker');
    expect(swarmRunning()).toBe(true);
    expect(swarmState().agents.find((agent) => agent.id === 'worker-2')?.state).not.toBe('failed');
    const report = offerMessages(PRIME_ID).map((message) => message.text).join('\n');
    expect(report).toMatch(/user/i);
  });

  it('ends the whole run when the prime is cleared', () => {
    startSwarm(1);
    expect(clearAgent(PRIME_ID).cleared).toBe('run');
    expect(swarmRunning()).toBe(false);
  });

  it('clears only the active prime row and preserves another prime dormant history', () => {
    startSwarm(1);
    const workerA = startWorker('worker-1', 'c-worker-a-row-clear');
    finishAgent(workerA.caller, 'A parked first');
    expect(releaseQuiescentRun()).toBe(true);

    const primeB: Caller = { conversationId: 'c-prime-b-row-clear' };
    spawn({ workers: [{ task: 'B active work' }], caller: primeB });
    startWorker('worker-1', 'c-worker-b-row-clear');
    // Slot names repeat, but sidebar parentage follows exact conversation ownership.
    expect(primeForOwnedConversation('c-worker-a-row-clear')).toBe(PRIME_CHAT);
    expect(primeForOwnedConversation('c-worker-b-row-clear')).toBe(primeB.conversationId);
    expect(primeForOwnedConversation('unrelated')).toBeNull();

    expect(clearAgent(PRIME_ID).cleared).toBe('run');
    expect(swarmRunning()).toBe(false);
    expect(retiredWorkerForConversation('c-worker-b-row-clear')).toMatchObject({
      id: 'worker-1',
      conversationId: 'c-worker-b-row-clear'
    });
    expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
      state: 'sleeping',
      conversationId: 'c-worker-a-row-clear'
    });
  });

  it('does nothing, and says so, for an agent that has already ended or never existed', () => {
    startSwarm(2);
    const worker = startWorker('worker-1');
    const other = startWorker('worker-2');
    // A sleeping worker is still one the person can throw away — that is what clearing is for. Only a worker that has already ended has nothing left to clear.
    finishAgent(worker.caller, 'done');
    expect(clearAgent('worker-1').cleared).toBe('worker');
    fillContext('c-worker-2');
    finishAgent(other.caller, 'done');
    expect(clearAgent('worker-2').cleared).toBe('none');
    expect(clearAgent('worker-9').cleared).toBe('none');
    resetAgentsForTests();
    expect(clearAgent('worker-1').cleared).toBe('none');
  });
});

