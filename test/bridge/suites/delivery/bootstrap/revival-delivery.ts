import { acknowledgeOffers, COMMAND_DEADLINE_MS, currentRunId, describe, expect, finishAgent, flushDurable, getLog, it, noteAgentAlive, noteWorkerRevived, offerMessages, onSwarmPersistNow, opened, pair, pendingCommands, pendingWorkerRevivals, persistCriticalSwarmNow, PRIME_CHAT, readDurable, redeem, request, requestWorkerRevivals, resetBridgeForTests, resetSwarm, restoreCommands, restoreSwarm, REVIVAL_DEADLINE_MS, snapshotSwarm, spawn, swarmState, swarmStateForCaller, vi, waitForRevival, wake, writeDurableNow } from "../../../test-context.js";

describe("delivering a bootstrap: revival delivery", () => {
  /** Waking a sleeping worker, end to end over the real server. A revival is the one command that names a chat that already exists. Everything about it is therefore fenced on that chat: the page is opened at `/c/<id>`, the redeemed command names the same id back, and the browser has to say which conversation it typed into before the broker will believe the worker is awake. */
    it("routes revival to the worker's own chat without opening a duplicate, and treats the typed message as an offer", async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'cafecafe-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'the first half is done');
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');

      wake([{ to: 'worker-1', text: 'now do the second half' }]);
      const revival = await waitForRevival();
      expect(revival.conversationId).toBe(conversationId);
      expect(opened).toHaveLength(1);
      const id = revival.id;

      // The page says which conversation it is showing, and only a revival for that exact chat may be claimed from inside an existing conversation.
      const wrongTab = await request('POST', '/commands/redeem', {
        body: { id, client: 'tab-someone-else', conversationId: 'ffffffff-1111-4222-8333-444444444444' }
      });
      expect(wrongTab.status).toBe(409);
      expect(wrongTab.body.error).toBe('command_wrong_conversation');

      const claimed = await request('POST', '/commands/redeem', {
        body: { id, client: 'tab-worker-again', conversationId }
      });
      expect(claimed.status).toBe(200);
      expect(claimed.body.command).toMatchObject({ id, agent: 'worker-1', conversationId });
      // What gets typed is the prime's own words, as a user message in the worker's chat.
      expect(claimed.body.command.text).toContain('now do the second half');

      const ack = await request('POST', '/commands/ack', {
        body: { id, status: 'sent', conversationId, client: 'tab-worker-again' }
      });
      expect(ack.status).toBe(200);
      expect(ack.body).toMatchObject({ committed: true, conversationId });
      let worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('waking');
      expect(worker.conversationId).toBe(conversationId);
      // Typed is not read. The words are in its chat; its own next authenticated call is what takes them out of its inbox.
      expect(worker.pending).toBe(1);
      expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
      worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('active');
    });

  /** The wake the page saw begin. Live 2026-09-02: the browser typed two wakes within a second and both pages reported "turn started", yet both workers stayed `waking` because the broker only accepted a tool call as proof — and those calls' page evidence was late, so they piled into Unattributed activity until the deadline slept the workers under turns that were visibly running. In the same second, the page replayed the settled answer of the turn that had put each worker to sleep, and that replay was taken as a fresh finish that put the worker back to `sleeping` and retired its wake command. Neither may happen: a turn beginning after the delivered wake ends the wake, and a stop observed while waking is the old turn's. */
    it('lets the turn the page reports end a delivered wake, and ignores the old answer replayed beside it', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'abababab-7654-4210-8edc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      const workerState = () =>
        swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      const settledAt = Date.now();
      const settled = await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            { kind: 'turn_start', time: settledAt - 20, turnId: 'turn-1' },
            {
              kind: 'assistant_message',
              time: settledAt - 10,
              turnId: 'turn-1',
              messageId: 'assistant:turn-1',
              text: 'the first half is done',
              final: true
            },
            { kind: 'turn_end', time: settledAt, turnId: 'turn-1', outcome: 'completed' }
          ]
        }
      });
      expect(settled.status).toBe(200);
      expect(workerState().state).toBe('sleeping');

      wake([{ to: 'worker-1', text: 'now do the second half' }]);
      const { id } = await waitForRevival();
      await request('POST', '/commands/redeem', { body: { id, client: 'tab-a', conversationId } });
      await request('POST', '/commands/ack', { body: { id, status: 'sent', conversationId, client: 'tab-a' } });
      expect(workerState().state).toBe('waking');

      // The page's next batch: the old answer again, exactly as the journal re-reports it, and nothing else. The worker is not asleep again and its wake is still pending.
      const replayed = await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_end', time: settledAt, turnId: 'turn-1', outcome: 'completed' }]
        }
      });
      expect(replayed.status).toBe(200);
      expect(workerState().state).toBe('waking');
      expect(pendingWorkerRevivals().map((entry) => entry.id)).toEqual(['worker-1']);

      // Then the typed message's turn begins. That is the proof; the command is spent with it.
      const started = await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'turn_start', time: Date.now() + 1, turnId: 'turn-2' }]
        }
      });
      expect(started.status).toBe(200);
      expect(workerState().state).toBe('active');
      expect(pendingWorkerRevivals()).toEqual([]);
      await flushDurable();
      const commands = (await readDurable<any>('bridge-commands'))?.commands ?? [];
      expect(commands.find((entry: any) => entry?.id === id)).toBeUndefined();
      // Typed is still not read: the worker's own next call is what takes the words out of its inbox.
      expect(workerState().pending).toBe(1);
    });

  /** The same worker, woken twice inside one command's thirty seconds. A wake is over the moment the worker's own authenticated call answers it, and that can happen seconds after the browser typed. Everything the first command accumulated on the way — its lease, the page that owns it, the delivery marker on the worker — belongs to that finished wake, so the second one has to arrive as its own send with its own words rather than folding into a command that has already been spent. */
    /** The broker republishing a wake it has already delivered. Every restart, and every staging pass that touches the run, hands the bridge the whole `waking` list again. For a worker whose message the browser has already typed there is nothing left to plan, and the command it is living under is the same one - so the thirty seconds it is being given to call must be the thirty seconds it started with, and its tab must not be opened again to type nothing into it. */
    it('leaves a delivered wake alone when the broker replays it, and still supersedes a real one', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'dededede-7654-4210-8edc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'the first half is done');

      wake([{ to: 'worker-1', text: 'now do the second half' }]);
      const { id } = await waitForRevival();
      expect(opened).toHaveLength(1);
      await request('POST', '/commands/redeem', { body: { id, client: 'tab-a', conversationId } });
      await request('POST', '/commands/ack', { body: { id, status: 'sent', conversationId, client: 'tab-a' } });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
      await flushDurable();
      const createdAt = (await readDurable<any>('bridge-commands'))?.commands?.find((entry: any) => entry?.id === id)
        ?.createdAt as number;
      expect(createdAt).toBeGreaterThan(0);

      // The replay: exactly what a restart, or any staging pass, does with a still-waking worker.
      requestWorkerRevivals(['worker-1']);
      await flushDurable();
      expect(opened).toHaveLength(1);
      const replayed = (await readDurable<any>('bridge-commands'))?.commands?.find((entry: any) => entry?.id === id);
      expect(replayed?.createdAt, 'the wake keeps its own absolute deadline').toBe(createdAt);
      expect(replayed?.owner, 'and the page that owns it keeps owning it').toBe('tab-a');

      // A genuinely new message, still inside those thirty seconds, is a different wake and does supersede — which is the thing the rule above must not have taken away.
      expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
      finishAgent({ conversationId }, 'the second half is done too');
      wake([{ to: 'worker-1', text: 'one more piece, please' }]);
      const replay = await waitForRevival();
      // The command row is superseded in place; its new payload/lease is the new wake episode.
      expect(replay.id).toBe(id);
      expect(opened).toHaveLength(1);
      expect(Date.now() - createdAt).toBeLessThan(30_000);
    });

  it('wakes the same worker again after it has called, well inside the first wake', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'bcbcbcbc-7654-4210-8edc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'the first half is done');

      wake([{ to: 'worker-1', text: 'now do the second half' }]);
      const { id: first } = await waitForRevival();
      const firstAt = Date.now();
      expect((await request('POST', '/commands/redeem', { body: { id: first, client: 'tab-a', conversationId } })).status).toBe(200);
      await request('POST', '/commands/ack', {
        body: { id: first, status: 'sent', conversationId, client: 'tab-a' }
      });
      // The exact authenticated call: this wake has done what it existed to do.
      expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
      finishAgent({ conversationId }, 'the second half is done too');

      wake([{ to: 'worker-1', text: 'one more piece, please' }]);
      const { id: second } = await waitForRevival();
      // Still inside the first command's own deadline, which is the whole point.
      expect(Date.now() - firstAt).toBeLessThan(30_000);
      expect(opened).toHaveLength(1);
      const claimed = await request('POST', '/commands/redeem', {
        body: { id: second, client: 'tab-b', conversationId }
      });
      // Not `command_already_sent`: nothing has been typed for *this* wake.
      expect(claimed.status).toBe(200);
      expect(claimed.body.command.text).toContain('one more piece, please');
      // And it carries this wake's words only, never a replay of the one already delivered.
      expect(claimed.body.command.text).not.toContain('now do the second half');
    });

  it('releases an unredeemed worker at exactly the revival deadline', async () => {
      vi.useFakeTimers();
      try {
        await pair();
        spawn({ workers: [{ task: 'finish, then keep rendering the final answer' }], caller: { conversationId: PRIME_CHAT } });
        const bootstrap = await redeem();
        const conversationId = 'cdcdcdcd-7654-4210-8edc-ba9876543210';
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
        });
        finishAgent({ conversationId }, 'tool result is terminal but assistant prose is still streaming');
        wake([{ to: 'worker-1', text: 'continue after your final answer settles' }]);
        const { id } = await waitForRevival();
        await flushDurable();
        const durable = await readDurable<any>('bridge-commands');
        const revive = durable?.commands?.find((entry: any) => entry?.id === id);
        expect(revive).toBeTruthy();
        const remaining = REVIVAL_DEADLINE_MS - (Date.now() - revive.createdAt);
        expect(remaining).toBeGreaterThan(1);

        // Content deliberately has not redeemed: the page is still rendering the assistant turn. Waking remains reserved just until the single attempt's absolute deadline.
        await vi.advanceTimersByTimeAsync(remaining - 1);
        expect(pendingCommands()).toContainEqual(expect.objectContaining({ id, what: `revive:${currentRunId()}:worker-1` }));
        expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({ state: 'waking' });
        expect(opened).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        await vi.runAllTicks();
        const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
        expect(worker).toMatchObject({ state: 'sleeping', revivable: true, pending: 1 });
        expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);
        expect(opened).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

  it('lets an MCP call win only before the browser redeems the sleeping-worker wake', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'abababab-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'the first half is done');
      wake([{ to: 'worker-1', text: 'one browser wake only' }]);
      const { id } = await waitForRevival();

      // Before /redeem owns the wake, a proven call is the stronger fact: the old server-side turn never really stopped. It takes the worker active and receives the queued text through the ordinary MCP inbox path exactly once.
      expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
      expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['one browser wake only']);

      // The page that arrives later no longer has authority to type the same text as a user turn.
      const stale = await request('POST', '/commands/redeem', {
        body: { id, client: 'tab-too-late', conversationId }
      });
      expect(stale.status).toBe(404);
      expect(stale.body.error).toBe('no_such_command');
    });

  it('validates deferred revival ids read-only before browser restart recovery opens a tab', async () => {
      await pair();
      spawn({ workers: [{ task: 'sleep and wake for recovery validation' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'abababab-1111-4222-8333-444444444444';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'sleep now');
      wake([{ to: 'worker-1', text: 'wake once after restart' }]);
      const { id } = await waitForRevival();

      const checked = await request('POST', '/commands/revivals/pending', {
        body: {
          entries: [
            { id, conversationId },
            { id: 'dead-command-id', conversationId },
            { id, conversationId: '99999999-1111-4222-8333-444444444444' }
          ]
        }
      });
      expect(checked.status).toBe(200);
      expect(checked.body).toEqual({ pending: [id] });

      // Validation must not consume or lease the command. The actual page can still redeem the exact same wake afterwards, which preserves the existing one-page arbitration boundary.
      const claimed = await request('POST', '/commands/redeem', {
        body: { id, client: 'validated-restart-tab', conversationId }
      });
      expect(claimed.status).toBe(200);
    });

  it('keeps a redeemed revival browser-owned until its exact sent acknowledgement', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'acacacac-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'the first half is done');
      wake([{ to: 'worker-1', text: 'browser has the arbitration cut' }]);
      const { id } = await waitForRevival();

      const claimed = await request('POST', '/commands/redeem', {
        body: { id, client: 'tab-browser-owner', conversationId }
      });
      expect(claimed.status).toBe(200);
      expect(claimed.body.command.text).toContain('browser has the arbitration cut');
      expect(claimed.body.command.text).not.toContain('[[NEURAFLOK_MESSAGE_V1:');
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'waking',
        revivable: false
      });

      // A late old-turn MCP call is liveness, but no longer wake authority. In particular it cannot get the queued prime instruction through a tool result while the page holds it.
      expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(false);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
      expect(offerMessages('worker-1')).toEqual([]);

      const ack = await request('POST', '/commands/ack', {
        body: { id, status: 'sent', conversationId, client: 'tab-browser-owner' }
      });
      expect(ack.status).toBe(200);
      expect(ack.body).toMatchObject({ committed: true, conversationId });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
      expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
      // The browser already typed this as a real user message; it is acknowledgement-only now.
      expect(offerMessages('worker-1')).toEqual([]);
    });

  it('returns no revival payload when the browser wake claim itself is not durable, then retries safely', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'adadadad-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'the first half is done');
      wake([{ to: 'worker-1', text: 'do not hand this out before the broker claim fsyncs' }]);
      const { id } = await waitForRevival();

      let failOnce = true;
      onSwarmPersistNow(async (snapshot) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('synthetic claim fsync failure');
        }
        await writeDurableNow('swarm', snapshot);
      });
      const first = await request('POST', '/commands/redeem', {
        body: { id, client: 'tab-claim-retry', conversationId }
      });
      expect(first.status).toBe(503);
      expect(first.body).toMatchObject({ error: 'worker_revival_claim_not_durable', retryable: true });
      expect(first.body.command).toBeUndefined();
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'waking',
        revivable: true
      });

      // The failed generation was superseded by the rollback snapshot, so the same page can retry from the pre-cut state. Only the successful second durable claim is allowed to expose text.
      const second = await request('POST', '/commands/redeem', {
        body: { id, client: 'tab-claim-retry', conversationId }
      });
      expect(second.status).toBe(200);
      expect(second.body.command.text).toContain('do not hand this out before the broker claim fsyncs');
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'waking',
        revivable: false
      });
    });

  it('replays a committed sent ACK after a crash between worker fsync and command receipt without duplicating the wake', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'aeaeaeae-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'the first half is done');
      wake([{ to: 'worker-1', text: 'this user message already reached ChatGPT' }]);
      const { id } = await waitForRevival();
      const client = 'tab-lost-ack-response';
      const redeemed = await request('POST', '/commands/redeem', {
        body: { id, client, conversationId }
      });
      expect(redeemed.status).toBe(200);

      // This is the exact middle of /commands/ack: semantic send committed in agents.ts and that state fsynced, but bridge-commands still contains the leased command and no receipt yet.
      const revival = pendingWorkerRevivals()[0]!;
      expect(noteWorkerRevived('worker-1', conversationId, revival.messageIds, id)).toBe(true);
      expect(await persistCriticalSwarmNow()).toBe(true);
      await flushDurable();
      const durableSwarm = await readDurable<any>('swarm');
      const durableCommands = await readDurable<any>('bridge-commands');
      expect(durableCommands?.commands?.some((entry: any) => entry?.id === id)).toBe(true);
      expect(durableCommands?.receipts?.some((entry: any) => entry?.id === id)).toBe(false);

      // Process restart. Ordinary MCP-result offers become uncertain on restore, but a revival offer remains acknowledgement-only because the browser already submitted it as user text.
      resetSwarm();
      resetBridgeForTests();
      restoreSwarm(durableSwarm);
      await restoreCommands();
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('waking');
      expect(noteAgentAlive(conversationId, 'call')?.revived).toBe(true);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
      expect(offerMessages('worker-1')).toEqual([]);
      const restoredOfferedAt = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;
      expect(acknowledgeOffers('worker-1', false, restoredOfferedAt + 1)).toHaveLength(1);
      expect(offerMessages('worker-1')).toEqual([]);

      // The browser's lost HTTP response is retried against the restored leased command. The durable revival offer proves the semantic send already committed, so rebuild the same committed receipt instead of reporting a false terminal failure.
      const retry = await request('POST', '/commands/ack', {
        body: { id, status: 'sent', conversationId, client }
      });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ committed: true, outcome: 'committed', conversationId });
      const storedAfterRetry = await readDurable<any>('bridge-commands');
      // Liveness already committed before this retry, so the receipt now closes the command.
      expect(storedAfterRetry?.receipts?.some((entry: any) => entry?.id === id)).toBe(true);
      expect(storedAfterRetry?.commands?.some((entry: any) => entry?.id === id)).toBe(false);
    });

  it('hands the browser every pending wake, not only the oldest (#882)', async () => {
      await pair();
      spawn({ workers: [{ task: 'first audit' }, { task: 'second audit' }], caller: { conversationId: PRIME_CHAT } });
      const chats = ['abababab-7654-3210-fedc-ba9876543210', 'cdcdcdcd-7654-3210-fedc-ba9876543210'];
      for (const [index, conversationId] of chats.entries()) {
        const bootstrap = await redeem();
        await request('POST', '/commands/ack', { body: { id: bootstrap.id, status: 'sent', conversationId, agent: `worker-${index + 1}` } });
        finishAgent({ conversationId }, 'reported, waiting for more');
      }
      wake([{ to: 'worker-1', text: 'one more thing' }, { to: 'worker-2', text: 'and you too' }]);
      await waitForRevival();
      const status = await request('GET', '/status');
      // The second wake reaches the browser now, not only after the first one's page claims it.
      expect(status.body.revivals.map((entry: { conversationId: string }) => entry.conversationId).sort()).toEqual([...chats].sort());
      expect(status.body.revival).toEqual(status.body.revivals[0]);
    });

  it('puts the worker back to sleep, with its slot and its message intact, when the browser cannot wake it', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'dadadada-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'reported, waiting for more');
      wake([{ to: 'worker-1', text: 'one more thing' }]);
      const { id } = await waitForRevival();
      await request('POST', '/commands/redeem', { body: { id, client: 'tab-doomed', conversationId } });

      const primeBefore = swarmState().agents.find((agent) => agent.role === 'prime')!.pending;
      const ack = await request('POST', '/commands/ack', {
        body: { id, status: 'failed', error: 'the tab was closed', client: 'tab-doomed' }
      });
      expect(ack.status).toBe(200);
      expect(ack.body).toMatchObject({ committed: false });
      // The page answered, so the chat did open; what failed is the message (#882).
      expect(getLog().some(entry => entry.message.includes("the worker's chat did not take the message — the tab was closed"))).toBe(true);

      // Nothing was typed, so nothing was delivered. The worker is exactly where it was, the slot it had reserved is free again, and the prime is told rather than left waiting.
      expect(swarmState().running).toBe(false);
      const ownerState = swarmStateForCaller({ conversationId: PRIME_CHAT });
      const worker = ownerState.agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('sleeping');
      expect(worker.revivable).toBe(true);
      expect(worker.pending).toBe(1);
      expect(ownerState.agents.find((agent) => agent.role === 'prime')!.pending).toBe(primeBefore + 1);

      // And it can simply be tried again, into the same chat.
      wake([{ to: 'worker-1', text: 'try that again' }]);
      expect((await waitForRevival()).conversationId).toBe(conversationId);
      expect(opened).toHaveLength(1);
    });

  it.each(['timer', 'sweep'] as const)('expires an owner-null revival at the revival deadline with the same worker and inbox intact (%s)', async expiry => {
      vi.useFakeTimers();
      try {
        await pair();
        spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
        const bootstrap = await redeem();
        const conversationId = 'edededed-7654-3210-fedc-ba9876543210';
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
        });
        finishAgent({ conversationId }, 'reported, waiting for more');
        wake([{ to: 'worker-1', text: 'stay queued if the page never redeems' }]);
        const { id } = await waitForRevival();
        const priorLogs = new Set(getLog());

        // A slow browser pickup outlives an ordinary command without gaining a second command, message or tab. Its original absolute wake still expires.
        const slowPickup = COMMAND_DEADLINE_MS + 1_000;
        await vi.advanceTimersByTimeAsync(slowPickup);
        expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find(agent => agent.id === 'worker-1'))
          .toMatchObject({ state: 'waking', pending: 1 });
        expect(pendingCommands().filter(entry => entry.id === id)).toHaveLength(1);
        expect(opened).toHaveLength(1);
        const remaining = REVIVAL_DEADLINE_MS - slowPickup;
        if (expiry === 'timer') await vi.advanceTimersByTimeAsync(remaining);
        else {
          vi.setSystemTime(Date.now() + remaining);
          const checked = await request('POST', '/commands/revivals/pending', { body: { entries: [{ id, conversationId }] } });
          expect(checked.body).toEqual({ pending: [] });
        }
        await vi.runAllTicks();
        const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
        expect(worker).toMatchObject({ state: 'sleeping', revivable: true, pending: 1 });
        expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);
        const failure = getLog().find(entry => !priorLogs.has(entry) && entry.message.includes('gave up on revive:'));
        expect(failure?.message).toContain('the browser did not claim this command before its deadline');
        expect(failure?.message).not.toContain('did not report back in time');
      } finally {
        vi.useRealTimers();
      }
    });

  it.each(['timer', 'sweep'] as const)('does not renew the absolute waking deadline when a document redeems (%s)', async expiry => {
      vi.useFakeTimers();
      try {
        await pair();
        spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
        const bootstrap = await redeem();
        const conversationId = 'dededede-7654-3210-fedc-ba9876543210';
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
        });
        finishAgent({ conversationId }, 'reported, waiting for more');
        wake([{ to: 'worker-1', text: 'document can own this only for the ACK deadline' }]);
        const { id } = await waitForRevival();
        const priorLogs = new Set(getLog());

        const claimed = await request('POST', '/commands/redeem', {
          body: { id, client: 'claimed-revival-document', conversationId }
        });
        expect(claimed.status).toBe(200);
        expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
          state: 'waking',
          revivable: false
        });

        if (expiry === 'timer') await vi.advanceTimersByTimeAsync(REVIVAL_DEADLINE_MS);
        else {
          vi.setSystemTime(Date.now() + REVIVAL_DEADLINE_MS);
          const checked = await request('POST', '/commands/revivals/pending', { body: { entries: [{ id, conversationId }] } });
          expect(checked.body).toEqual({ pending: [] });
        }
        await vi.runAllTicks();
        const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
        expect(worker.state).toBe('sleeping');
        expect(worker.revivable).toBe(true);
        expect(worker.pending).toBe(1);
        expect(pendingCommands().some((entry) => entry.id === id)).toBe(false);
        const failure = getLog().find(entry => !priorLogs.has(entry) && entry.message.includes('gave up on revive:'));
        expect(failure?.message).toContain('did not report back in time');
        expect(failure?.message).not.toContain('did not claim this command');
      } finally {
        vi.useRealTimers();
      }
    });
});
