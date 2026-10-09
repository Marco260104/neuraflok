import { bridgeState, currentRunId, describe, expect, finishAgent, it, opened, pair, pendingCommands, PRIME_CHAT, redeem, request, requestWorkerRevivals, resetSwarm, spawn, stageMessages, startBridge, stopBridge, swarmState, swarmStateForCaller, waitForOpened, waitForRevival } from "../../test-context.js";

describe("restarting the bridge", () => {
  it('coalesces concurrent starts into one listener', async () => {
      await stopBridge();
      const [first, second] = await Promise.all([startBridge(), startBridge()]);
      expect(first).not.toBeNull();
      expect(second).toBe(first);
      bridgeState.base = `http://127.0.0.1:${first}`;
      await pair();
      expect((await request('GET', '/hello', { auth: null })).status).toBe(200);
    });

  it('cancels an ended run’s queued worker chats exactly once, however often it has restarted', async () => {
      for (let restart = 0; restart < 2; restart++) {
        await stopBridge();
        const port = await startBridge();
        expect(port).not.toBeNull();
        bridgeState.base = `http://127.0.0.1:${port}`;
      }
      await pair();

      spawn({ workers: [{ task: 'work' }], caller: { conversationId: PRIME_CHAT } });
      expect(pendingCommands().map((command) => command.what)).toEqual([`worker:${currentRunId()}:worker-1`]);

      // A worker chat that has not opened yet must not open for a run that is over.
      resetSwarm();
      expect(pendingCommands()).toEqual([]);
    });

  it('stops listening to the swarm while it is down', async () => {
      await pair();
      spawn({ workers: [{ task: 'work' }], caller: { conversationId: PRIME_CHAT } });
      expect(pendingCommands()).toHaveLength(1);

      await stopBridge();
      // With the bridge down there is nobody to hear this, which is the point: the listener came off with the module. A stale one would be reaching into the queue of a bridge that is not running.
      resetSwarm();
      expect(pendingCommands()).toHaveLength(1);

      const port = await startBridge();
      expect(port).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${port}`;
      await pair();
      // And the command is not handed out on the way back up either: its worker belongs to a run that no longer exists, so startup's ordinary tidy pass retires it before delivery.
      expect(pendingCommands()).toEqual([]);
    });

  it('does not queue or open a newly spawned worker through a stale bridge callback while stopped', async () => {
      await stopBridge();
      opened.length = 0;

      // onSpawnRequest/onReviveRequest are singleton broker callbacks, not part of the HTTP server object. Before they had disposers, stopBridge() removed only the swarm-end listener, so a new worker created while the bridge was down still called queueWorkerBootstrap() and could even launch Chrome through the stale opener. Nothing transport-facing may happen until the next start registers a fresh callback and replays broker-owned work.
      spawn({ workers: [{ task: 'must wait for bridge restart' }], caller: { conversationId: PRIME_CHAT } });
      expect(pendingCommands()).toEqual([]);
      expect(opened).toEqual([]);

      const port = await startBridge();
      expect(port).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${port}`;
      await waitForOpened(1);
      expect(pendingCommands().map((command) => command.what)).toEqual([`worker:${currentRunId()}:worker-1`]);
    });

  it('does not queue or reopen a sleeping worker through a stale revival callback while stopped', async () => {
      await pair();
      spawn({ workers: [{ task: 'be reusable across a bridge restart' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'abababab-1111-4222-8333-666666666666';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      finishAgent({ conversationId }, 'sleeping before bridge stop');
      expect(swarmState().agents.find((entry) => entry.id === 'worker-1')?.state).toBe('sleeping');

      await stopBridge();
      opened.length = 0;
      const staged = stageMessages({ conversationId: PRIME_CHAT }, [
        { to: 'worker-1', text: 'this must wait until the bridge is started again' }
      ]);
      staged.commit();
      expect(staged.waking).toEqual(['worker-1']);
      expect(requestWorkerRevivals(staged.waking)).toBe(1);
      // The broker owns a durable waking reservation, but the stopped bridge owns no callback and therefore creates neither a transport row nor a browser side effect yet.
      expect(pendingCommands()).toEqual([]);
      expect(opened).toEqual([]);

      const port = await startBridge();
      expect(port).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${port}`;
      expect((await waitForRevival()).conversationId).toBe(conversationId);
      expect(opened).toEqual([]);
      expect(pendingCommands().map((command) => command.what)).toEqual([`revive:${currentRunId()}:worker-1`]);
    });

  it('re-arms an in-memory leased command instead of reopening it after stop/start', async () => {
      await pair();
      spawn({ workers: [{ task: 'work' }], caller: { conversationId: PRIME_CHAT } });
      await waitForOpened(1);
      const leased = await redeem();
      expect(leased.agent).toBe('worker-1');

      const realNow = Date.now;
      const leasedAt = realNow();
      await stopBridge();
      try {
        // The old deadline timer is gone because stopBridge deliberately cleared it. Advance only the clock: on restart an implementation that forgets to re-arm/expire the retained lease sees it as deliverable and opens the exact same bootstrap again.
        Date.now = () => leasedAt + 91_000;
        const port = await startBridge();
        expect(port).not.toBeNull();
        bridgeState.base = `http://127.0.0.1:${port}`;
        expect(opened).toHaveLength(1);
        expect(pendingCommands()).toEqual([]);
        expect(swarmState().running).toBe(false);
        expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((entry) => entry.id === 'worker-1')?.state).toBe('failed');
      } finally {
        Date.now = realNow;
      }
    });
});
