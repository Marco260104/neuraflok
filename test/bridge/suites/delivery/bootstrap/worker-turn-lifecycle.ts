import { randomUUID } from "node:crypto";
import { beginPrimeTransfer, bindConversation, commitPrimeTransfer, deleteSession, describe, expect, faultGate, finishAgent, flushDurable, getSession, it, noteAgentAlive, noteAgentContextTokens, offerMessages, onSwarmPersistNow, opened, pair, pendingCommands, pendingWorkerRevivals, persistCriticalSwarmNow, PRIME_CHAT, PRIME_ID, readDurable, readEvents, recordChatObservations, redeem, request, resetBridgeForTests, resetRecorderForTests, resetSwarm, restoreCommands, restoreSwarm, snapshotSwarm, spawn, STALE_SWARM_MS, swarmState, swarmStateForCaller, sweepStaleSwarm, vi, waitForRevival, wake, WORKER_CONTEXT_CEILING_TOKENS, writeDurableNow } from "../../../test-context.js";
import type { SwarmSnapshot } from "../../../test-context.js";

describe("delivering a bootstrap: worker turn lifecycle", () => {
  it('puts a reusable worker to sleep when its settled assistant turn completes', async () => {
      await pair();
      spawn({ workers: [{ task: 'write the audit' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = 'beefbeef-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

      const now = Date.now();
      const recorded = await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            { kind: 'turn_start', time: now, turnId: 'g-worker-final' },
            {
              kind: 'assistant_message',
              time: now + 1,
              turnId: 'g-worker-final',
              messageId: 'assistant:g-worker-final',
              text: 'Final audit: request IDs are the authority and the slot is free now.',
              final: true
            },
            { kind: 'turn_end', time: now + 2, turnId: 'g-worker-final', outcome: 'completed' }
          ]
        }
      });
      expect(recorded.status).toBe(200);
      // The browser final is the last slot-consuming edge. The active global incarnation should disappear immediately, while the owning prime still sees the exact sleeping worker in its dormant history.
      expect(swarmState().running).toBe(false);
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('sleeping');
      expect(worker.revivable).toBe(true);
      expect(worker.result).toContain('Final audit: request IDs are the authority');
    });

  for (const order of ['ack-first', 'start-first', 'final-first', 'prime-compacted', 'restart-before-ack', 'stale-turn'] as const) {
      it(`reconciles a tool-free revival independent of send ACK ordering: ${order}`, async () => {
        await pair();
        spawn({ workers: [{ task: 'answer without tools' }], caller: { conversationId: PRIME_CHAT } });
        const bootstrap = await redeem();
        const conversationId = randomUUID();
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
        });
        const initial = await request('POST', '/events', { body: { conversationId, events: [
          { kind: 'turn_start', time: Date.now() - 100, turnId: 'previous-turn' },
          { kind: 'assistant_message', time: Date.now() - 90, turnId: 'previous-turn',
            messageId: 'previous-final', text: 'Previous work done.', final: true }
        ] } });
        let primeConversationId = PRIME_CHAT;
        const worker = () => swarmStateForCaller({ conversationId: primeConversationId }).agents.find(a => a.id === 'worker-1')!;
        expect(worker().state).toBe('sleeping');
        wake([{ to: 'worker-1', text: 'Answer this follow-up without tools.' }]);
        const { id } = await waitForRevival();
        await request('POST', '/commands/redeem', { body: { id, client: 'ordered-page', conversationId } });
        const at = order === 'stale-turn' ? Date.now() - 1000 : Date.now() + 1;
        const start = { kind: 'turn_start', time: at, turnId: 'follow-up-turn' };
        const final = { kind: 'assistant_message', time: at + 2, turnId: 'follow-up-turn',
          messageId: 'follow-up-final', text: 'Follow-up complete without tools.', final: true };
        const postEvents = (events: unknown[]) => request('POST', '/events', { body: { conversationId, events } });
        const ack = () => request('POST', '/commands/ack', {
          body: { id, status: 'sent', conversationId, client: 'ordered-page' }
        });
        if (order !== 'ack-first') {
          expect((await postEvents(order === 'start-first' ? [start] : [start, final])).status).toBe(200);
          expect(worker().state).toBe('waking');
        }
        if (order === 'prime-compacted') {
          primeConversationId = randomUUID();
          expect(beginPrimeTransfer(PRIME_CHAT)).toBe(true);
          expect(commitPrimeTransfer(PRIME_CHAT, primeConversationId)).toBe(true);
        }
        if (order === 'restart-before-ack') {
          await persistCriticalSwarmNow();
          await flushDurable();
          const saved = await readDurable<any>('swarm');
          resetSwarm();
          resetBridgeForTests();
          restoreSwarm(saved);
          await restoreCommands();
        }
        expect((await ack()).body.committed).toBe(true);
        if (order === 'stale-turn') {
          expect(worker().state).toBe('waking');
          expect(worker().pending).toBe(1);
          return;
        }
        if (order === 'ack-first' || order === 'start-first') {
          if (order === 'start-first') expect(worker().state).toBe('active');
          expect((await postEvents(order === 'ack-first' ? [start, final] : [final])).status).toBe(200);
        }
        expect(worker()).toMatchObject({ state: 'sleeping', pending: 0, result: final.text });
        expect(pendingWorkerRevivals()).toEqual([]);
        expect(pendingCommands().some(command => command.id === id)).toBe(false);
        if (order !== 'ack-first') expect((await ack()).body.committed).toBe(true);
        const reports = (await readEvents(initial.body.sessionId)).filter(event => event.kind === 'agent_message' &&
          event.message.text.includes(final.text));
        expect(reports).toHaveLength(1);
        expect(opened).toHaveLength(1);
      });
    }

  it('keeps page observations attributed to the exact dormant worker while another prime is active', async () => {
      await pair();
      spawn({ workers: [{ task: 'prime A worker' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const workerConversation = 'cafe0024-0000-4000-8000-000000000024';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId: workerConversation, agent: 'worker-1' }
      });
      const initial = await request('POST', '/events', {
        body: {
          conversationId: workerConversation,
          events: [{ kind: 'user_message', time: Date.now(), text: 'initial worker turn', messageId: 'worker-a-user' }]
        }
      });
      const sessionId = initial.body.sessionId as string;
      expect(sessionId).toBeTruthy();

      finishAgent({ conversationId: workerConversation }, 'A worker is dormant now');
      expect(await sweepStaleSwarm()).toBe(true);
      expect(swarmState().running).toBe(false);

      // A second owner may now reuse the same friendly worker id. An old page report from A must stay in A's exact session and retain its worker attribution rather than becoming an unattributed/solo row or being confused with B's worker-1.
      spawn({ workers: [{ task: 'prime B worker' }], caller: { conversationId: 'cafe0025-0000-4000-8000-000000000025' } });
      // Simulate session retention having removed A's old recorder file while its worker history remains intentionally permanent. Forget recorder caches too, as a later app process would.
      await deleteSession(sessionId);
      resetRecorderForTests();

      const observed = await request('POST', '/events', {
        body: {
          conversationId: workerConversation,
          events: [
            {
              kind: 'page_tool',
              time: Date.now(),
              turnId: 'old-worker-reload',
              text: 'Dormant worker historical activity',
              messageId: 'old-worker-page-tool'
            }
          ]
        }
      });
      const rebuiltSessionId = observed.body.sessionId as string;
      expect(rebuiltSessionId).toBeTruthy();
      expect(rebuiltSessionId).not.toBe(sessionId);

      const events = await readEvents(rebuiltSessionId);
      expect(events.find((event) => event.kind === 'page_tool' && event.messageId === 'old-worker-page-tool')).toMatchObject({
        agent: 'worker-1',
        label: 'Dormant worker historical activity'
      });
      expect((await getSession(rebuiltSessionId))?.origin).toMatchObject({
        kind: 'worker',
        agentId: 'worker-1',
        task: 'prime A worker'
      });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        task: 'prime B worker',
        state: 'invited'
      });
    });

  it('keeps a reported worker asleep while late same-turn prose and native status arrive', async () => {
      await pair();
      spawn({ workers: [{ task: 'first audit' }, { task: 'keep the family active' }], caller: { conversationId: PRIME_CHAT } });
      const bootstrap = await redeem();
      const conversationId = 'decafbad-7654-4210-8edc-ba9876543220';
      await request('POST', '/commands/ack', {
        body: { id: bootstrap.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      const now = Date.now();
      const post = (events: unknown[]) => request('POST', '/events', { body: { conversationId, events } });
      const initial = await post([
        { kind: 'user_message', time: now - 1000, messageId: 'reported-worker-question', text: 'Audit this task.' },
        { kind: 'turn_start', time: now - 900, turnId: 'reported-worker-turn' }
      ]);
      finishAgent({ conversationId }, 'The audit is done.');
      const state = () => swarmStateForCaller({ conversationId: PRIME_CHAT });
      const worker = () => state().agents.find(agent => agent.id === 'worker-1')!;
      const finished = worker();
      const reportCount = state().agents.find(agent => agent.id === 'prime')!.pending;
      expect(finished.state).toBe('sleeping');
      const late = Math.max(Date.now(), finished.sleptAt!) + 1;
      expect((await post([
        { kind: 'assistant_message', time: late, authoredAt: now - 850, turnId: 'reported-worker-turn',
          messageId: 'delayed-worker-intro', text: 'I am inspecting the source.', state: 'streaming', activeNow: true },
        { kind: 'page_tool', time: late + 1, turnId: 'reported-worker-turn', messageId: 'delayed-worker-status',
          text: 'Reviewed source', activeNow: true }
      ])).status).toBe(200);
      expect(worker()).toMatchObject({ state: 'sleeping', result: finished.result, sleptAt: finished.sleptAt });
      expect((await post([
        { kind: 'assistant_message', time: late + 2, turnId: 'reported-worker-turn', messageId: 'reported-worker-final',
          text: 'Audit complete and already reported.', final: true, activeNow: true },
        { kind: 'turn_end', time: late + 3, turnId: 'reported-worker-turn', outcome: 'completed' }
      ])).status).toBe(200);
      expect(worker()).toMatchObject({ state: 'sleeping', result: finished.result, sleptAt: finished.sleptAt });
      expect(state().agents.find(agent => agent.id === 'prime')!.pending).toBe(reportCount);
      expect((await readEvents(initial.body.sessionId)).some(event => event.kind === 'assistant_message' &&
        event.message.text === 'Audit complete and already reported.')).toBe(true);
      // A genuinely new accepted question still takes the slot normally.
      expect((await post([
        { kind: 'user_message', time: late + 4, messageId: 'new-worker-question', text: 'Now inspect the caller.', authoredNow: true },
        { kind: 'turn_start', time: late + 5, turnId: 'new-worker-turn' }
      ])).status).toBe(200);
      expect(worker()).toMatchObject({ state: 'active', result: null });
    });

  it('puts a reusable worker to sleep when its final assistant row and matching turn_end arrive in separate event batches', async () => {
      await pair();
      spawn({ workers: [{ task: 'finish across journal batches' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = 'decafbad-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
      });

      const now = Date.now();
      const ended = await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            { kind: 'turn_start', time: now, turnId: 'g-worker-split-final' },
            { kind: 'turn_end', time: now + 1, turnId: 'g-worker-split-final', outcome: 'completed' }
          ]
        }
      });
      expect(ended.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

      // finishGeneration() can enqueue turn_end immediately while its final Fiber refresh is still awaiting the MAIN-world round trip. The service-worker journal may therefore hand these two pieces of one durable turn to the bridge in different HTTP batches.
      const final = await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            {
              kind: 'assistant_message',
              time: now + 2,
              turnId: 'g-worker-split-final',
              messageId: 'assistant:g-worker-split-final',
              text: 'This final answer arrived one journal flush after its turn_end.',
              final: true
            }
          ]
        }
      });
      expect(final.status).toBe(200);
      expect(swarmState().running).toBe(false);
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('sleeping');
      expect(worker.revivable).toBe(true);
      expect(worker.result).toContain('one journal flush after its turn_end');
    });

  it('keeps a revived worker active when an older final answer receives a new canonical revision', async () => {
      await pair();
      spawn({ workers: [{ task: 'initial docs task' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = 'decafbad-7654-3210-fedc-ba9876543212';
      await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' } });
      const time = Date.now();
      const oldFinal = { kind: 'assistant_message', time: time + 1, turnId: 'worker-old-turn',
        messageId: 'worker-old-final', text: 'Docs done. No new validator yet.', state: 'final', final: true };
      const initial = await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'turn_start', time, turnId: 'worker-old-turn' }, oldFinal,
        { kind: 'turn_end', time: time + 2, turnId: 'worker-old-turn', outcome: 'completed' }
      ] } });
      expect(initial.status).toBe(200);
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find(row => row.id === 'worker-1')?.state).toBe('sleeping');
      const oldRow = (await readEvents(initial.body.sessionId)).find(row => row.kind === 'assistant_message' && row.messageId === oldFinal.messageId)!;

      wake([{ to: 'worker-1', text: 'Now implement and verify the validator.' }]);
      await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'turn_start', time: time + 10, turnId: 'worker-new-turn' }
      ] } });
      noteAgentAlive(conversationId, 'call');
      expect(swarmState().agents.find(row => row.id === 'worker-1')?.state).toBe('active');

      // The new turn receives its work on an ordinary tool result. Its eventual final can acknowledge that offer; an old final must never acknowledge it or end the new task.
      offerMessages('worker-1');

      // A late revision to an old final must not finish the worker's newer task.
      const replay = await request('POST', '/events', { body: { conversationId, events: [
        { ...oldFinal, text: 'Docs done. Still no new validator.' }
      ] } });
      expect(replay.status).toBe(200);
      const rows = await readEvents(initial.body.sessionId);
      const revised = rows.find(row => row.kind === 'assistant_message' && row.messageId === oldFinal.messageId)!;
      const newerStart = rows.find(row => row.kind === 'turn_start' && row.turnId === 'worker-new-turn')!;
      if (revised.kind !== 'assistant_message' || oldRow.kind !== 'assistant_message') throw new Error('Missing final rows');
      expect(revised.origin).toBe(oldRow.origin ?? oldRow.seq);
      expect(revised.seq).toBeGreaterThan(newerStart.seq);
      expect(swarmState().agents.find(row => row.id === 'worker-1')?.state).toBe('active');

      await request('POST', '/events', { body: { conversationId, events: [
        { ...oldFinal, time: time + 20, turnId: 'worker-new-turn', messageId: 'worker-new-final', text: 'Validator implemented and verified.' }
      ] } });
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find(row => row.id === 'worker-1')).toMatchObject({
        state: 'sleeping', result: 'Validator implemented and verified.'
      });
    });

  it('retires a worker on its stable final answer even when no turn_end ever arrives', async () => {
      await pair();
      spawn({ workers: [{ task: 'finish without a local turn_end' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = 'decafbad-7654-3210-fedc-ba9876543211';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
      });

      const now = Date.now();
      // The page detached, reloaded or simply lost its local lifecycle right after the answer settled, so it never wrote the end. The stable final answer is the terminal fact on its own; requiring the page's separate note about it parked a finished worker as a zombie.
      const final = await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            { kind: 'turn_start', time: now, turnId: 'g-worker-no-end' },
            {
              kind: 'assistant_message',
              time: now + 2,
              turnId: 'g-worker-no-end',
              messageId: 'assistant:g-worker-no-end',
              text: 'The complete worker report, with no turn_end behind it.',
              state: 'final',
              final: true
            }
          ]
        }
      });
      expect(final.status).toBe(200);
      const worker = swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('sleeping');
      expect(worker.result).toContain('no turn_end behind it');
    });

  it.each([false, true])('retires an exact image-only worker final without requiring a page-local turn (hasTurn=%s)', async hasTurn => {
      await pair();
      spawn({ workers: [{ task: 'produce the requested image' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = randomUUID();
      await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' } });
      const now = Date.now();
      const response = await request('POST', '/events', { body: { conversationId, events: [
        { kind: 'user_message', time: now, messageId: 'image-question', text: 'Create an image.' },
        ...(hasTurn ? [{ kind: 'turn_start', time: now, turnId: 'image-turn' }] : []),
        { kind: 'assistant_message', time: now + 1, ...(hasTurn ? { turnId: 'image-turn' } : {}),
          messageId: 'image-answer', providerMessageId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', text: '', state: 'final', final: true }
      ] } });
      expect(response.status).toBe(200);
      const { readCompletedFinal } = await import("../../../../../backend/domains/sessions/history/store.js");
      expect(await readCompletedFinal(response.body.sessionId, conversationId)).toMatchObject({
        messageId: 'image-answer', turnId: hasTurn ? 'image-turn' : null, text: ''
      });
      expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find(row => row.id === 'worker-1')?.state).toBe('sleeping');
    });

  it.each(['replay', 'new output', 'unattributed tool'] as const)('measures attached worker silence from accepted work despite page polls and another running MCP (%s)', async mode => {
      await pair();
      spawn({ workers: [{ task: 'observe native output' }, { task: 'a long running tool' }], caller: { conversationId: PRIME_CHAT } });
      const conversationId = randomUUID();
      const busyConversation = randomUUID();
      bindConversation('worker-1', conversationId);
      bindConversation('worker-2', busyConversation);
      const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
      const { trackInFlight, trackMcpRequest, emptyEvidence } = await import("../../../../../backend/infrastructure/tool-gateway/protocol/call-context.js");
      let release!: () => void;
      const held = trackMcpRequest(() => trackInFlight({ startedAt: start, transportKey: null, agent: 'worker-2', outcome: null,
        evidence: emptyEvidence(), caller: { conversationId: mode === 'unattributed tool' ? null : busyConversation, requestId: 'long-worker-call', transportKey: null } },
        () => new Promise<void>(resolve => { release = resolve; })));
      try {
        const opening = { kind: 'turn_start', time: start, turnId: 'observed-worker-turn' };
        const interim = { kind: 'assistant_message', time: start, turnId: opening.turnId, messageId: 'worker-progress',
          text: 'Inspecting the task.', state: 'streaming', final: false, activeNow: true };
        const post = (events: unknown[]) => request('POST', '/events', { body: { conversationId, events } });
        expect((await post([opening, interim])).status).toBe(200);
        clock.mockReturnValue(start + 120_000);
        const revision = mode === 'new output' ? { ...interim, text: 'The inspection found the missing handler.', time: Date.now() }
          : { ...interim, time: Date.now() };
        expect((await post([opening, revision])).status).toBe(200);
        const workAt = mode === 'new output' ? start + 120_000 : start;
        expect(swarmState().agents.find(row => row.id === 'worker-1')?.lastSeenAt).toBe(workAt);
        clock.mockReturnValue(workAt + 179_999);
        expect((await post([opening, revision])).status).toBe(200);
        await sweepStaleSwarm(Date.now());
        expect(swarmState().agents.find(row => row.id === 'worker-1')?.state).toBe('active');
        clock.mockReturnValue(workAt + 180_000);
        await sweepStaleSwarm(Date.now());
        expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find(row => row.id === 'worker-1')).toMatchObject({ state: 'sleeping', lastSeenAt: workAt });
        expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find(row => row.id === 'worker-2')?.state).toBe(mode === 'unattributed tool' ? 'sleeping' : 'active');
        expect((await post([opening, revision])).status).toBe(200);
        expect(swarmStateForCaller({ conversationId: PRIME_CHAT }).agents.find(row => row.id === 'worker-1')?.state).toBe('sleeping');
      } finally { release(); await held; clock.mockRestore(); }
    });

  it('does not acknowledge a worker final observation before its final report is durable', async () => {
      await pair();
      spawn({ workers: [{ task: 'finish durably' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = 'faceface-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      const durableBefore = await readDurable<any>('swarm');
      expect(durableBefore?.agents?.find((agent: any) => agent.info?.id === 'worker-1')?.info?.state).toBe('active');

      onSwarmPersistNow(async () => {
        throw new Error('disk full at worker finish');
      });
      try {
        const now = Date.now();
        const recorded = await request('POST', '/events', {
          body: {
            conversationId,
            events: [
              { kind: 'turn_start', time: now, turnId: 'g-worker-durable-final' },
              {
                kind: 'assistant_message',
                time: now + 1,
                turnId: 'g-worker-durable-final',
                messageId: 'assistant:g-worker-durable-final',
                text: 'The exact final report that must survive the browser ACK.',
                final: true
              },
              { kind: 'turn_end', time: now + 2, turnId: 'g-worker-durable-final', outcome: 'completed' }
            ]
          }
        });

        // Before the barrier existed this was 200 even though the only durable swarm snapshot still said active. A crash at that response boundary lets the extension retire its journal row and loses the worker's exact result from the broker.
        expect(recorded.status).toBe(503);
        expect(recorded.body).toMatchObject({ error: 'worker_state_not_durable', retryable: true });
        const durableAfter = await readDurable<any>('swarm');
        expect(durableAfter?.agents?.find((agent: any) => agent.info?.id === 'worker-1')?.info?.state).toBe('active');
      } finally {
        onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
      }
    });

  it('keeps a worker finish and its prime report unpublished while the durable barrier is held', async () => {
      await pair();
      spawn({ workers: [{ task: 'finish without leaking before fsync' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = 'fadedcab-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
      });

      const gate = faultGate();
      let projected: ReturnType<typeof snapshotSwarm> = null;
      onSwarmPersistNow(async (snapshot) => {
        projected = snapshot;
        await gate.hold();
        await writeDurableNow('swarm', snapshot);
      });

      try {
        const now = Date.now();
        const recording = request('POST', '/events', {
          body: {
            conversationId,
            events: [
              { kind: 'turn_start', time: now, turnId: 'g-worker-held-finish' },
              {
                kind: 'assistant_message',
                time: now + 1,
                turnId: 'g-worker-held-finish',
                messageId: 'assistant:g-worker-held-finish',
                text: 'Final result hidden until the acceptance write lands.',
                final: true
              },
              { kind: 'turn_end', time: now + 2, turnId: 'g-worker-held-finish', outcome: 'completed' }
            ]
          }
        });
        await gate.entered;

        // The immediate writer must see the exact proposed terminal generation, otherwise a success response could still crash back to an active worker after restart. The assignment occurs inside the persistence callback. TypeScript's synchronous control flow cannot infer from `gate.entered` that the callback has run, so name the runtime proof explicitly instead of letting it narrow the outer variable to its initial null.
        const projectedAfterEntry = projected as SwarmSnapshot | null;
        expect(projectedAfterEntry?.agents.find((agent) => agent.info.id === 'worker-1')?.info.state).toBe('sleeping');
        expect(projectedAfterEntry?.agents.find((agent) => agent.info.id === PRIME_ID)?.queue[0]?.text).toContain(
          'Final result hidden until the acceptance write lands.'
        );

        // But no concurrent live reader may see that proposal before fsync. Old code mutated the worker and queued its report before awaiting the barrier, so both assertions failed.
        expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
        expect(swarmState().agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(0);
        expect(snapshotSwarm()?.agents.find((agent) => agent.info.id === 'worker-1')?.info.state).toBe('active');
        expect(snapshotSwarm()?.agents.find((agent) => agent.info.id === PRIME_ID)?.queue).toEqual([]);

        gate.release();
        const recorded = await recording;
        expect(recorded.status).toBe(200);
        expect(swarmState().running).toBe(false);
        const ownerState = swarmStateForCaller({ conversationId: PRIME_CHAT });
        expect(ownerState.agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
        expect(ownerState.agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(1);
      } finally {
        gate.release();
        onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
      }
    });

  it('parks an unacknowledged terminal history immediately while preserving its prime report', async () => {
      spawn({ workers: [{ task: 'stale fallback proof' }], caller: { conversationId: PRIME_CHAT } });
      const workerConversation = 'stale-worker-terminal';
      expect(bindConversation('worker-1', workerConversation)).toBe(true);
      const now = Date.now();
      await recordChatObservations(PRIME_CHAT, [
        { kind: 'turn_start', time: now, turnId: 'g-prime-stale' },
        { kind: 'turn_end', time: now + 1, turnId: 'g-prime-stale', outcome: 'completed' }
      ], 'prime');
      await recordChatObservations(workerConversation, [
        { kind: 'turn_start', time: now, turnId: 'g-worker-stale' },
        { kind: 'turn_end', time: now + 1, turnId: 'g-worker-stale', outcome: 'completed' }
      ], 'worker-1');
      noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
      finishAgent({ conversationId: workerConversation }, 'worker finished, report still pending');
      expect(swarmState().running).toBe(true);
      expect(swarmState().agents.find((agent) => agent.role === 'prime')?.pending).toBe(1);

      expect(await sweepStaleSwarm(now + STALE_SWARM_MS - 1)).toBe(true);
      expect(swarmState().running).toBe(false);
      const ownerState = swarmStateForCaller({ conversationId: PRIME_CHAT });
      expect(ownerState.agents.find((agent) => agent.role === 'prime')?.pending).toBe(1);
      expect(ownerState.agents.find((agent) => agent.id === 'worker-1')?.state).toBe('finished');
    });
});
