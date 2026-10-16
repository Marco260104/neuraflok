import { WebSocket } from "ws";
import { once } from "node:events";
import { bridgeState, COMMAND_DEADLINE_MS, currentRunId, describe, expect, EXTENSION_ORIGIN, flushDurable, getConfig, it, LOST_ACK_CHAT, opened, pair, pendingCommands, pendingWorkerSpawns, PRIME_CHAT, redeem, request, saveConfig, setBrowserOpener, spawn, swarmState, vi, waitForOpened, WORKER_BOOTSTRAP_LIMIT_MS, WORKER_REDEEM_MS } from '../../test-context.js';

// ------------------------------------------------------- worker bootstrap failure

describe('a worker chat that never opens', () => {
  it.each([true, false])('places two workers once through the companion with background window=%s', async (backgroundChats) => {
    await pair();
    const config = getConfig();
    await saveConfig({ ...config, ui: { ...config.ui, backgroundChats } });
    await request('GET', '/status');
    const socket = new WebSocket(bridgeState.base.replace('http:', 'ws:') + '/wake', { origin: EXTENSION_ORIGIN });
    await once(socket, 'open');
    const authenticated = once(socket, 'message'); socket.send(bridgeState.token!); await authenticated;
    try {
    spawn({ workers: [{ task: 'first placement probe' }, { task: 'second placement probe' }], caller: { conversationId: PRIME_CHAT } });
    let placement: any;
    await vi.waitFor(async () => {
      const result = await request('GET', '/status');
      placement ||= result.body.placement;
      expect(placement?.id).toBeTruthy();
      expect(placement.active).toBe(false);
      expect(placement.background === true).toBe(backgroundChats);
    });
    expect(opened).toEqual([]);
    let second: any;
    await vi.waitFor(async () => { second ||= (await request('GET', '/status')).body.placement; expect(second?.id).toBeTruthy(); });
    expect((await request('GET', '/status')).body.placement).toBeNull();
    expect((await redeem(placement.id)).agent).toBe('worker-1');
    await request('POST', '/commands/ack', { body: { id: placement.id, status: 'sent', agent: 'worker-1', conversationId: 'abababab-1111-4222-8333-444444444444' } });
    expect(second.id).not.toBe(placement.id);
    expect(second.active).toBe(false);
    expect((await redeem(second.id)).agent).toBe('worker-2');
    expect((await request('GET', '/status')).body.placement).toBeNull();
    expect(opened).toEqual([]);
    } finally { const closed = once(socket, 'close'); socket.close(); await closed; }
  });
  it('fails the worker definitively instead of leaving it invited, and lets the next one through', async () => {
    await pair();
    spawn({ workers: [{ task: 'first audit' }, { task: 'second audit' }], caller: { conversationId: PRIME_CHAT } });
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1', 'worker-2']);

    // The page took the bootstrap and could not type it — a tab closed too early, or ChatGPT refusing the message. It says so, and that is the end of this worker: the page gets one attempt, so handing the same command back would only be the app disbelieving it.
    const first = await redeem();
    expect(first.agent).toBe('worker-1');
    await request('POST', '/commands/ack', { body: { id: first.id, status: 'failed', error: 'tab closed' } });

    const state = swarmState();
    const worker1 = state.agents.find((agent) => agent.id === 'worker-1')!;
    expect(worker1.state).toBe('failed');
    expect(worker1.result).toContain('tab closed');
    // No zombie: it is not owed a tab, and it does not count as a live worker.
    expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-2']);
    expect(pendingCommands().some((command) => command.what === `worker:${currentRunId()}:worker-1`)).toBe(false);

    // The prime is told, rather than waiting for a report that cannot come.
    const prime = state.agents.find((agent) => agent.id === 'prime')!;
    expect(prime.pending).toBeGreaterThan(0);

    // And worker-2 is no longer stuck behind it: its chat opened the moment worker-1 ended.
    const next = await redeem();
    expect(next.agent).toBe('worker-2');
  });

  /** Serializes cold browser starts to prevent duplicate browser processes. */
  it('waits for one cold browser start rather than stacking a second', async () => {
    await pair();
    vi.useFakeTimers();
    try {
      const attempts: string[] = [];
      setBrowserOpener(async (url) => {
        attempts.push(url);
        throw new Error('the browser is still starting');
      });
      // The user closed the browser: nothing has reported for longer than presence lasts, so every open from here is a cold start rather than a URL handed to a running browser.
      await vi.advanceTimersByTimeAsync(61_000);

      spawn({ workers: [{ task: 'first audit' }, { task: 'second audit' }], caller: { conversationId: PRIME_CHAT } });
      await flushDurable();
      await vi.advanceTimersByTimeAsync(10);
      await flushDurable();

      // worker-1's open failed and ended its command, so delivery advanced to worker-2 in the same beat. That is the beat this guard exists for: worker-2 waits for the browser worker-1 asked for instead of asking the operating system for a second one.
      expect(attempts).toHaveLength(1);
      expect(pendingCommands().some((command) => command.what === `worker:${currentRunId()}:worker-2`)).toBe(true);

      // Still nothing has reported, so the launch is now one this app has stopped believing in and worker-2 may have its own.
      await vi.advanceTimersByTimeAsync(60_001);
      await flushDurable();
      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Lost-ACK retirement settles only that marker; siblings already own their attempts. */
  it('does not reopen a sibling when a lost-ACK bootstrap retires', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'first audit' }, { task: 'second audit' }], caller: { conversationId: PRIME_CHAT } });

      const first = await redeem();
      expect(first.agent).toBe('worker-1');
      // The page redeemed and typed, but its ACK never arrived. `/events` is the recovery path, and it binds the worker without ever finishing the command.
      const reply = await request('POST', '/events', {
        body: {
          conversationId: LOST_ACK_CHAT,
          agent: 'worker-1',
          agentCommandId: first.id,
          events: [{ kind: 'turn_start', time: Date.now(), turnId: 'lost-ack-turn' }]
        }
      });
      expect(reply.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

      await waitForOpened(2);
      const next = await redeem(new URL(opened[1]!).searchParams.get('neuraflok-command')!);
      expect(next.agent).toBe('worker-2');
      await vi.advanceTimersByTimeAsync(COMMAND_DEADLINE_MS + 1_000);
      expect(opened).toHaveLength(2);
      expect(pendingCommands().some(command => command.id === first.id)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a slow new tab time to pick up its worker task', async () => {
    // VM stress test, 2026-10-06: two worker tabs loading next to a Loop's tabs took longer than 20 s to redeem, and both workers failed. A single tab there needs about 15 s at the 90th percentile.
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'slow page' }], caller: { conversationId: PRIME_CHAT } });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      const id = new URL(opened[0]!).searchParams.get('neuraflok-command')!;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(swarmState().agents.find(agent => agent.id === 'worker-1')?.state).not.toBe('failed');
      expect((await redeem(id)).agent).toBe('worker-1');
      expect(opened).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('fails an unredeemed opening without duplicating it or holding its sibling', async () => {
    vi.useFakeTimers();
    try {
      await pair();
      spawn({ workers: [{ task: 'first' }, { task: 'second' }], caller: { conversationId: PRIME_CHAT } });
      await vi.waitFor(() => expect(opened).toHaveLength(2));
      const first = new URL(opened[0]!).searchParams.get('neuraflok-command')!;
      const second = new URL(opened[1]!).searchParams.get('neuraflok-command')!;
      expect((await redeem(second)).agent).toBe('worker-2');
      await vi.advanceTimersByTimeAsync(WORKER_REDEEM_MS + 1_000);
      await vi.waitFor(() => expect(opened).toHaveLength(2));
      expect(second).not.toBe(first);
      expect(swarmState().agents.find(agent => agent.id === 'worker-1')?.state).toBe('failed');
      expect((await request('POST', '/commands/redeem', { body: { id: first, client: 'late-page' } })).status).toBe(404);
      await vi.advanceTimersByTimeAsync(WORKER_REDEEM_MS + 1_000);
      expect(opened).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  /** The absolute clock a still-`invited` worker lives under. A command still in line has no clock of its own; the limit is absolute from the invitation, so no combination of a late hand-out and a fresh lease can keep the slot past two minutes. */
  it('stops holding a slot invited two minutes after the invitation, however late its chat opens', async () => {
    vi.useFakeTimers();
    const previous = getConfig();
    try {
      await saveConfig({ ...previous, multiAgent: { ...previous.multiAgent, maxWorkers: 3 } });
      await pair();
      spawn({
        workers: [{ task: 'opens first' }, { task: 'waits behind it' }, { task: 'waits longest' }],
        caller: { conversationId: PRIME_CHAT }
      });
      expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1', 'worker-2', 'worker-3']);
      // Each failed opening releases its slot without opening the same command again.
      let elapsed = 0;
      const advance = async (ms: number): Promise<void> => {
        await vi.advanceTimersByTimeAsync(ms);
        elapsed += ms;
      };
      await vi.waitFor(() => expect(opened).toHaveLength(3));
      await request('GET', '/status');
      await advance(WORKER_REDEEM_MS + 1_000);
      expect(new Set(opened.map(url => new URL(url).searchParams.get('neuraflok-command'))).size).toBe(3);

      await advance(WORKER_BOOTSTRAP_LIMIT_MS + 1_000 - elapsed);
      // No zombie slot left behind: nothing is still owed a tab, and nothing is still invited.
      await vi.waitFor(() => expect(pendingWorkerSpawns()).toEqual([]));
      expect(swarmState().agents.every((agent) => agent.state !== 'invited')).toBe(true);
    } finally {
      vi.useRealTimers();
      await saveConfig(previous);
    }
  });
});
