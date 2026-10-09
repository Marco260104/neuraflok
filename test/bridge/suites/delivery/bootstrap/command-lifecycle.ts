import { userPromptText } from "../../../../../contracts/messaging/provider-message-envelope.js";
import { attachSummary, beginPrimeTransfer, bindConversation, bridgeState, cancelPrimeTransfer, closeConversation, commandUrl, CONTINUATIONS_STATE, createSession, currentRunId, describe, expect, faultGate, finishAgent, flushDurable, getLog, it, noteAgentContextTokens, onSwarmPersistNow, openContinuationNow, opened, pair, pendingCommands, pendingWorkerRevivals, pendingWorkerSpawns, persistCriticalSwarmNow, PRIME_CHAT, queueResume, readDurable, readyContinuation, recordChatObservations, redeem, request, requestWorkerBootstraps, resetBlockedChatsForTests, resetBridgeForTests, resetSwarm, restoreCommands, restoreContinuations, SAMPLE_BRIEF, setBrowserOpener, setChatBlocked, snapshotSwarm, spawn, stageMessages, STALE_SWARM_MS, swarmState, swarmStateForCaller, sweepStaleSwarm, vi, waitForOpened, WORKER_CONTEXT_CEILING_TOKENS, WORKER_SILENCE_MS, workerConversationGone, writeDurableNow } from "../../../test-context.js";
import type { ContinuationSnapshot } from "../../../test-context.js";

describe("delivering a bootstrap: command lifecycle", () => {
  /** Block is the user's stop for that chat. On 2026-09-02 worker-3 was blocked, the app was restarted, and the restored run carried it as `active` with no silence grant left to expire: it held the swarm's slot for an hour, the next prime got AGENTS_BUSY, and the slot came free only after its tab closed and the detached clock ran out. The sweep now sleeps a blocked worker from the durable block alone, whatever state its slot is in. */
    it('sleeps a blocked worker on the next sweep, active or detached, without any silence clock', async () => {
      spawn({
        workers: [{ task: 'blocked while attached' }, { task: 'blocked while detached' }],
        caller: { conversationId: PRIME_CHAT }
      });
      expect(bindConversation('worker-1', 'blocked-attached-worker')).toBe(true);
      expect(bindConversation('worker-2', 'blocked-detached-worker')).toBe(true);
      expect(workerConversationGone('blocked-detached-worker')).toBe(true);
      const stateOf = (id: string) => swarmState().agents.find((agent) => agent.id === id)?.state;
      expect(stateOf('worker-1')).toBe('active');
      expect(stateOf('worker-2')).toBe('detached');
      try {
        setChatBlocked('blocked-attached-worker', true);
        setChatBlocked('blocked-detached-worker', true);
        // Straight away: no grant to expire, no detached silence to wait out.
        await sweepStaleSwarm(Date.now());
        const log = getLog().map((entry) => entry.message);
        expect(log.some((line) => line.includes('worker-1 is sleeping — The user blocked its chat'))).toBe(true);
        expect(log.some((line) => line.includes('worker-2 is sleeping — The user blocked its chat'))).toBe(true);
        // A sleeping worker holds no slot, so with both asleep the run parks and the next prime is no longer refused with AGENTS_BUSY.
        expect(swarmState().running).toBe(false);
      } finally {
        resetBlockedChatsForTests();
      }
    });

  it('periodically sleeps a silent detached worker and wakes already-queued work without another MCP call', async () => {
      spawn({ workers: [{ task: 'detached silence maintenance' }], caller: { conversationId: PRIME_CHAT } });
      const workerConversation = 'silent-detached-worker';
      expect(bindConversation('worker-1', workerConversation)).toBe(true);
      const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
      // Detaching the page does not renew work. Use the actual work clock so time spent between binding and closing cannot push the first sweep past the silence boundary.
      const lastWorkAt = Math.max(worker.activatedAt ?? 0, worker.lastSeenAt ?? 0);
      expect(workerConversationGone(workerConversation)).toBe(true);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');

      const queued = stageMessages({ conversationId: PRIME_CHAT }, [
        { to: 'worker-1', text: 'when that old turn is done, inspect the parser' }
      ]);
      expect(queued.waking).toEqual([]);
      queued.commit();

      // No page and, crucially, no later worker MCP request. The bridge's own maintenance timer must eventually run the detached-only silence rule, free the slot, and reserve the queued instruction as a wake in the same stored conversation.
      expect(await sweepStaleSwarm(lastWorkAt + WORKER_SILENCE_MS - 1)).toBe(false);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
      expect(await sweepStaleSwarm(lastWorkAt + WORKER_SILENCE_MS + 1_000)).toBe(true);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
      expect(pendingWorkerRevivals()[0]).toMatchObject({ id: 'worker-1', conversationId: workerConversation });
      expect(pendingWorkerRevivals()[0]?.text).toContain('inspect the parser');
    });

  it('leaves a worker awake while its page polls that the turn is still thinking (#882)', async () => {
      await pair();
      spawn({ workers: [{ task: 'think for a long time' }], caller: { conversationId: PRIME_CHAT } });
      const workerConversation = 'cafe1003-0000-4000-8000-000000000882';
      expect(bindConversation('worker-1', workerConversation)).toBe(true);
      const worker = () => swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      const quietAt = Math.max(worker().activatedAt ?? 0, worker().lastSeenAt ?? 0) + WORKER_SILENCE_MS + 1_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(quietAt);
      try {
        expect((await request('GET', `/activity?conversationId=${workerConversation}&generating=1`)).status).toBe(200);
        expect(await sweepStaleSwarm(quietAt)).toBe(false);
        expect(worker().state).toBe('active');
        // The page's turn ended: the same silence now counts.
        expect((await request('GET', `/activity?conversationId=${workerConversation}&generating=0`)).status).toBe(200);
        expect(await sweepStaleSwarm(quietAt)).toBe(true);
        expect(worker().state).toBe('sleeping');
      } finally {
        clock.mockRestore();
      }
    });

  it('does not hand a slept worker its dead turn, nor count its replayed native rows as work', async () => {
      // Measured 2026-09-26 (worker-8): a turn left open the day before was adopted by the reopened tab, which refused the wake as "generating" until a ten-minute stall, and its native rows — keyed `thought-<id>-0` by the old renderer, `<id>` by the new shell — replayed as new output.
      await pair();
      spawn({ workers: [{ task: 'survive the renderer switch' }], caller: { conversationId: PRIME_CHAT } });
      const workerConversation = 'cafe0926-0000-4000-8000-000000000926';
      expect(bindConversation('worker-1', workerConversation)).toBe(true);
      const start = Date.now();
      await recordChatObservations(workerConversation, [
        { kind: 'turn_start', time: start, turnId: 'g-dead-turn' },
        { kind: 'page_tool', time: start + 1, turnId: 'g-dead-turn', messageId: 'thought-259c5310-0',
          text: 'Audited Startpage configuration', activeNow: true }
      ], 'worker-1');
      expect(workerConversationGone(workerConversation)).toBe(true);
      const worker = () => swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      const lastWorkAt = Math.max(worker().activatedAt ?? 0, worker().lastSeenAt ?? 0);
      stageMessages({ conversationId: PRIME_CHAT }, [{ to: 'worker-1', text: 'continue the consolidation' }]).commit();
      expect(await sweepStaleSwarm(lastWorkAt + WORKER_SILENCE_MS + 1_000)).toBe(true);
      expect(worker().state).toBe('waking');
      const sleptAt = worker().sleptAt!;

      const activity = (await request('GET', `/activity?conversationId=${workerConversation}`)).body;
      expect(activity.activeTurnId).toBeNull();
      expect(activity.recordedTurnId).toBeNull();

      expect((await request('POST', '/events', { body: { conversationId: workerConversation, events: [
        { kind: 'page_tool', time: sleptAt + 5_000, turnId: 'g-dead-turn', messageId: '259c5310',
          text: 'Audited Startpage configuration', activeNow: true }
      ] } })).status).toBe(200);
      // Still waiting for the wake to be typed, not "revived" by its own history.
      expect(worker().state).toBe('waking');
      expect(pendingWorkerRevivals()[0]?.text).toContain('continue the consolidation');
    });

  it('still releases worker capacity when the durable prime turn remains open', async () => {
      spawn({ workers: [{ task: 'open turn veto' }], caller: { conversationId: PRIME_CHAT } });
      const workerConversation = 'stale-worker-open-prime';
      expect(bindConversation('worker-1', workerConversation)).toBe(true);
      const now = Date.now();
      await recordChatObservations(PRIME_CHAT, [
        { kind: 'turn_start', time: now, turnId: 'g-prime-open' }
      ], 'prime');
      await recordChatObservations(workerConversation, [
        { kind: 'turn_start', time: now, turnId: 'g-worker-done' },
        { kind: 'turn_end', time: now + 1, turnId: 'g-worker-done', outcome: 'completed' }
      ], 'worker-1');
      noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
      finishAgent({ conversationId: workerConversation }, 'done while prime still works');

      expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 10_000)).toBe(true);
      expect(swarmState().running).toBe(false);
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');

      await recordChatObservations(PRIME_CHAT, [
        { kind: 'turn_end', time: now + 2, turnId: 'g-prime-open', outcome: 'completed' }
      ], 'prime');
      expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 20_000)).toBe(false);
    });

  it('stale-releases after page detach durably closes the exact active turn even if broker cleanup was lost', async () => {
      spawn({ workers: [{ task: 'detach crash proof' }], caller: { conversationId: PRIME_CHAT } });
      const workerConversation = 'stale-worker-prime-detached';
      expect(bindConversation('worker-1', workerConversation)).toBe(true);
      const now = Date.now();
      await recordChatObservations(PRIME_CHAT, [
        { kind: 'turn_start', time: now, turnId: 'g-prime-detached' }
      ], 'prime');
      // Simulate the crash window between the recorder persisting page detach and the bridge getting far enough to call primeConversationGone(). The durable turn_end must name the same turn or orphan recovery will reconstruct it as open forever after restart.
      await closeConversation(PRIME_CHAT);
      await recordChatObservations(workerConversation, [
        { kind: 'turn_start', time: now, turnId: 'g-worker-detached' },
        { kind: 'turn_end', time: now + 1, turnId: 'g-worker-detached', outcome: 'completed' }
      ], 'worker-1');
      noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
      finishAgent({ conversationId: workerConversation }, 'worker done before broker crash');

      expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 10_000)).toBe(true);
      expect(swarmState().running).toBe(false);
    });

  it('defers stale release while Compact & Resume owns the prime transfer', async () => {
      spawn({ workers: [{ task: 'transfer veto' }], caller: { conversationId: PRIME_CHAT } });
      const workerConversation = 'stale-worker-transfer';
      expect(bindConversation('worker-1', workerConversation)).toBe(true);
      const now = Date.now();
      await recordChatObservations(PRIME_CHAT, [
        { kind: 'turn_start', time: now, turnId: 'g-prime-transfer' },
        { kind: 'turn_end', time: now + 1, turnId: 'g-prime-transfer', outcome: 'completed' }
      ], 'prime');
      await recordChatObservations(workerConversation, [
        { kind: 'turn_start', time: now, turnId: 'g-worker-transfer' },
        { kind: 'turn_end', time: now + 1, turnId: 'g-worker-transfer', outcome: 'completed' }
      ], 'worker-1');
      noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
      finishAgent({ conversationId: workerConversation }, 'done before transfer');
      expect(beginPrimeTransfer(PRIME_CHAT)).toBe(true);

      expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 10_000)).toBe(false);
      expect(swarmState().running).toBe(true);

      cancelPrimeTransfer(PRIME_CHAT);
      expect(await sweepStaleSwarm(now + STALE_SWARM_MS + 20_000)).toBe(true);
      expect(swarmState().running).toBe(false);
    });

  /** The failure the new boundary creates, and its safe ending. A page can type the bootstrap and still never see a conversation id — ChatGPT accepted the message but the tab never showed which chat it landed in. Nothing that chat does can ever reach the run, so the slot is failed outright rather than left waiting on a chat that can never be found. */
    it('fails a worker whose page typed the task but never named its chat', async () => {
      await pair();
      spawn({ workers: [{ task: 'unnameable' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();

      await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent', agent: 'worker-1' } });

      const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('failed');
      expect(worker.result).toMatch(/never said which conversation/);
      expect(pendingCommands()).toEqual([]);
    });

  it('leases each worker marker independently and binds out-of-order receipts to their exact command', async () => {
      await pair();
      spawn({
        workers: [{ task: 'first audit' }, { task: 'second audit' }],
        caller: { conversationId: PRIME_CHAT }
      });

      await waitForOpened(2);
      const first = await redeem();
      expect(first.agent).toBe('worker-1');
      const second = await redeem();
      expect(second.agent).toBe('worker-2');
      const secondConversation = '22222222-3333-4444-5555-666666666666';
      await request('POST', '/commands/ack', {
        body: { id: second.id, status: 'sent', conversationId: secondConversation, agent: 'worker-2' }
      });
      const firstConversation = '11111111-2222-3333-4444-555555555555';
      await request('POST', '/commands/ack', {
        body: { id: first.id, status: 'sent', conversationId: firstConversation, agent: 'worker-1' }
      });

      await waitForOpened(2);
      expect(userPromptText(second.text)?.startsWith('second audit')).toBe(true);
      expect(swarmState().agents.find(agent => agent.id === 'worker-1')?.conversationId).toBe(firstConversation);
      expect(swarmState().agents.find(agent => agent.id === 'worker-2')?.conversationId).toBe(secondConversation);
    });

  it('starts a worker while an unrelated resume awaits its exact receipt', async () => {
      await pair();
      const source = await createSession({ conversationId: 'cafe0391-0000-4000-8000-000000000391', title: 'Stalled automatic resume' });
      const continuation = await openContinuationNow(source.id, source.conversationId!, true);
      await attachSummary(continuation.token, SAMPLE_BRIEF);
      const resume = queueResume(source.id, continuation.token)!;
      await waitForOpened(1);
      spawn({ workers: [{ task: 'Independent work' }], caller: { conversationId: PRIME_CHAT } });
      await waitForOpened(2);
      const worker = await redeem(new URL(opened[1]!).searchParams.get('neuraflok-command')!);
      expect(worker.agent).toBe('worker-1');
      expect(pendingCommands().some(command => command.id === resume.id)).toBe(true);
      await request('GET', '/status');
      expect(opened.filter(url => new URL(url).searchParams.get('neuraflok-command') === resume.id)).toHaveLength(1);
    });

  it('preserves both concurrent command claims and final receipts in the durable ledger', async () => {
      await pair();
      spawn({ workers: [{ task: 'Concurrent first' }, { task: 'Concurrent second' }], caller: { conversationId: PRIME_CHAT } });
      await waitForOpened(2);
      const ids = opened.map(url => new URL(url).searchParams.get('neuraflok-command')!);
      await Promise.all(ids.map((id, index) => redeem(id, `concurrent-page-${index}`)));
      const claimed = await readDurable<any>('bridge-commands');
      for (const [index, id] of ids.entries())
        expect(claimed.commands.find((row: any) => row.id === id)?.owner).toBe(`concurrent-page-${index}`);
      const ack = (id: string, index: number) => request('POST', '/commands/ack', {
        body: { id, client: `concurrent-page-${index}`, status: 'sent', agent: `worker-${index + 1}`,
          conversationId: `cafe0491-0000-4000-8000-00000000049${index}` }
      });
      const receipts = await Promise.all(ids.map(ack));
      expect(receipts.map(receipt => receipt.status)).toEqual([200, 200]);
      await flushDurable();
      const finalized = await readDurable<any>('bridge-commands');
      expect(finalized.commands).toEqual([]);
      expect(finalized.receipts.map((row: any) => row.id).sort()).toEqual([...ids].sort());
    });

  it('brings an unfinished worker bootstrap back across an app restart, without a credential', async () => {
      await pair();
      spawn({ workers: [{ task: 'survive the restart' }], caller: { conversationId: PRIME_CHAT } });
      const offered = await redeem();
      expect(offered.agent).toBe('worker-1');
      await flushDurable();

      // Nothing in the state file can make anybody a worker: it is a list of what was pending.
      const saved = JSON.stringify(await readDurable('bridge-commands'));
      expect(saved).not.toMatch(/key/i);

      resetBridgeForTests();
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await restoreCommands();
      expect(pendingCommands()).toEqual([{ id: offered.id, what: `worker:${currentRunId()}:worker-1`, lastError: null }]);
    });

  it('never adopts a durable worker command from an older swarm incarnation', async () => {
      await pair();
      spawn({ workers: [{ task: 'run A task' }], caller: { conversationId: PRIME_CHAT } });
      const runA = currentRunId();
      const offeredA = await redeem(undefined, 'run-a-page');
      await flushDurable();
      const staleSnapshot = await readDurable('bridge-commands');
      expect(runA).toBeTruthy();
      expect(JSON.stringify(staleSnapshot)).toContain(runA!);

      // Broker run B is current, but disk still contains A's leased browser command: the exact crash split-brain that used to let B fold into A's id because both were `worker-1`.
      resetSwarm();
      spawn({ workers: [{ task: 'run B task' }], caller: { conversationId: PRIME_CHAT } });
      const runB = currentRunId();
      expect(runB).toBeTruthy();
      expect(runB).not.toBe(runA);

      resetBridgeForTests();
      opened.length = 0;
      bridgeState.anonymousRedeemIndex = 0;
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await writeDurableNow('bridge-commands', staleSnapshot);
      await restoreCommands();
      expect(pendingCommands(), 'run A command was resurrected into run B').toEqual([]);

      // The restored broker still owes run B a tab, so replaying that fact creates a fresh, run-scoped command rather than inheriting the stale marker held by run A's old page.
      expect(requestWorkerBootstraps(['worker-1'])).toBe(1);
      await waitForOpened(1);
      const offeredB = await redeem(undefined, 'run-b-page');
      expect(offeredB.id).not.toBe(offeredA.id);
      expect(userPromptText(offeredB.text)?.startsWith('run B task')).toBe(true);
    });

  it('restores a resume when its continuation WAL is restored first', async () => {
      await pair();
      const source = await createSession({ title: 'interrupted by a restart' });
      const continuation = await readyContinuation(source.id, 'carry on');
      const command = queueResume(source.id, continuation)!;
      await waitForOpened(1);
      await flushDurable();
      const snapshot = await readDurable<ContinuationSnapshot>(CONTINUATIONS_STATE);
      expect(snapshot).not.toBeNull();

      resetBridgeForTests();
      opened.length = 0;
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      await restoreContinuations(snapshot);
      await restoreCommands();
      expect(pendingCommands()).toEqual([{ id: command.id, what: `resume:${source.id}`, lastError: null }]);
      // This snapshot is v2 and already leased to the browser-open attempt. Replaying the queue request must therefore keep waiting for that exact tab instead of opening a second one.
      queueResume(source.id, continuation);
      await Promise.resolve();
      await Promise.resolve();
      expect(opened).toEqual([]);
    });

  /** T-33. Overflow used to `commands.shift()`, which deletes the row and nothing else. A queued worker command owns an `invited` agent slot that only ever ends when something ends it, so shifting one out left that worker counting towards the limit, holding the single in-flight agent bootstrap so nothing queued behind it could open, keeping the run looking alive to takeover, and promising the prime a report from a chat that would never exist. */
    it('runs the full lifecycle cleanup when the command queue overflows', async () => {
      await pair();
      spawn({ workers: [{ task: 'the worker that gets pushed out of the queue' }], caller: { conversationId: PRIME_CHAT } });
      expect(swarmState().agents.find((info) => info.id === 'worker-1')!.state).toBe('invited');
      expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1']);

      // MAX_COMMANDS is 20, and the worker's command is the oldest, so it is the one pushed out by the twenty-first entry.
      for (let n = 0; n < 20; n++) queueResume(`overflow-session-${n}`, `overflow-handoff-${n}`);

      expect(pendingCommands().some((command) => command.what === `worker:${currentRunId()}:worker-1`)).toBe(false);
      expect(pendingCommands()).toHaveLength(20);

      expect(swarmState().running).toBe(false);
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((info) => info.id === 'worker-1')!;
      expect(worker.state).toBe('failed');
      expect(worker.result).toMatch(/queue was full/);
      // The slot is genuinely free again rather than held by a command nobody has, so the active execution claim parks immediately while the failed worker remains in the prime's history.
      expect(pendingWorkerSpawns()).toEqual([]);
      expect(swarmState().running).toBe(false);
    });

  it('opens a worker chat with the requested model in its URL', async () => {
      await pair();
      spawn({
        workers: [{ label: 'Cheap', task: 'bulk work', model: 'cheap-high-reasoning' }],
        caller: { conversationId: PRIME_CHAT }
      });
      await waitForOpened(1);
      // The marker carries the bridge command id, not the worker id: the worker binds to its chat later, by the extension's report. What matters here is the model riding along.
      expect(opened).toEqual([commandUrl(pendingCommands()[0]!.id, 'deepseek', 'cheap-high-reasoning')]);
      expect(opened[0]).toContain('neuraflok-model=cheap-high-reasoning');
    });

  it('opens a reasoning-only worker with no model param, so the level never selects a model', async () => {
      await pair();
      spawn({
        workers: [{ label: 'High Reasoning', task: 'deep work', reasoning_effort: 'high' }],
        caller: { conversationId: PRIME_CHAT }
      });
      await waitForOpened(1);
      expect(opened).toEqual([commandUrl(pendingCommands()[0]!.id, 'deepseek', null, 'high')]);
      expect(opened[0]).toContain('neuraflok-reasoning=high');
      expect(opened[0]).not.toContain('neuraflok-model=');
    });

  it('keeps a dropped worker transport durable until the failed broker state is durable', async () => {
      await pair();
      spawn({ workers: [{ task: 'overflow crash-order worker' }], caller: { conversationId: PRIME_CHAT } });
      await waitForOpened(1);
      const workerCommand = pendingCommands().find((entry) => entry.what === `worker:${currentRunId()}:worker-1`)!;
      expect(workerCommand).toBeTruthy();
      await flushDurable();

      const gate = faultGate();
      let brokerProjection: ReturnType<typeof snapshotSwarm> = null;
      onSwarmPersistNow(async (snapshot) => {
        brokerProjection = snapshot;
        await gate.hold();
        await writeDurableNow('swarm', snapshot);
      });

      try {
        // The 21st command drops the oldest worker bootstrap. Live delivery should stop at once, but disk must retain that old transport until the failed worker/dormant owner snapshot held above has crossed its independent durability boundary.
        for (let n = 0; n < 20; n++) queueResume(`crash-order-session-${n}`, `crash-order-token-${n}`);
        await gate.entered;
        expect(pendingCommands().some((entry) => entry.id === workerCommand.id)).toBe(false);
        expect(swarmState().running).toBe(false);
        expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((entry) => entry.id === 'worker-1')).toMatchObject({
          state: 'failed'
        });

        await flushDurable();
        const beforeBrokerFsync = await readDurable<any>('bridge-commands');
        expect(beforeBrokerFsync?.commands?.some((entry: any) => entry?.id === workerCommand.id)).toBe(true);
        expect(
          (brokerProjection as ReturnType<typeof snapshotSwarm>)?.dormantRuns?.[0]?.agents.find(
            (entry) => entry.info.id === 'worker-1'
          )?.info.state
        ).toBe('failed');

        // Join the broker flight before releasing it. Bridge retirement also waits for independent command lease writes, so broker completion alone is not its barrier.
        const brokerPersisted = persistCriticalSwarmNow();
        gate.release();
        expect(await brokerPersisted).toBe(true);
        await vi.waitFor(async () => {
          await flushDurable();
          const after = await readDurable<any>('bridge-commands');
          expect(after?.commands?.some((entry: any) => entry?.id === workerCommand.id)).toBe(false);
        });
        const durableBroker = await readDurable<any>('swarm');
        expect(durableBroker?.dormantRuns?.[0]?.agents.find((entry: any) => entry?.info?.id === 'worker-1')?.info?.state).toBe(
          'failed'
        );
      } finally {
        gate.release();
        onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
      }
    });

  it('ignores an acknowledgement for a command that does not exist', async () => {
      await pair();
      const reply = await request('POST', '/commands/ack', { body: { id: 'made-up' } });
      expect(reply.status).toBe(200);
    });

  it('rejects a current page acknowledgement after its command has gone away', async () => {
      await pair();
      const reply = await request('POST', '/commands/ack', {
        body: { id: 'expired-command', client: 'current-document', status: 'sent', conversationId: PRIME_CHAT }
      });
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ error: 'no_such_command' });
    });

  /** There is no listing route left for a tab to poll, and nothing behind one. */
    it('has no queue for a tab to poll', async () => {
      await pair();
      spawn({ workers: [{ task: 'not for the taking' }], caller: { conversationId: PRIME_CHAT } });
      expect((await request('GET', '/commands')).status).toBe(404);
    });
});
