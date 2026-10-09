import {
  PRIME_CHAT,
  PRIME_ID,
  REFUSED_ON_ROOTS,
  WORKER_CONTEXT_CEILING_TOKENS,
  WORKER_SILENCE_MS,
  bindConversation,
  fillContext,
  findSessionByConversation,
  finishAgent,
  noteAgentContextTokens,
  offerMessages,
  offerMessagesForConversation,
  onSwarmPersist,
  onSwarmPersistNow,
  pendingCount,
  prime,
  readRecentEvents,
  recordChatObservations,
  releaseQuiescentRun,
  requestTurnOwnershipCutoff,
  silentCeilingRecoveryTurn,
  sleepSilentWorkers,
  snapshotSwarm,
  spawn,
  startSwarm,
  startWorker,
  swarmRunning,
  swarmState,
  swarmStateForCaller,
} from './context.js';
import {
  agents,
  agentsWithRequestId,
  asChat,
  ordinaryWithRequestId,
  startMcpEndpoint,
  stopMcpEndpoint,
  textOfReply,
} from './mcp-context.js';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

describe('through the MCP endpoint', () => {
  beforeEach(startMcpEndpoint);
  afterEach(stopMcpEndpoint);

  it('waits for late exact identity while dormant worker histories exist, then revives that worker', async () => {
      startSwarm(1);
      const worker = startWorker('worker-1');
      finishAgent(worker.caller, 'sleep before late evidence');
      expect(releaseQuiescentRun()).toBe(true);

      const requestId = 'wfr_dormant_worker_late';
      const pending = ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] });
      // Initial cheap correlation has already had a chance to miss. Deliver the exact page mate while the kernel is in its dormant-worker evidence window.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now(), turnId: 't-dormant-late' },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId: 't-dormant-late',
          calls: [{ messageId: 'm-dormant-late', tool: 'read', order: 0, answered: false, requestId }]
        }
      ]);
      // The exact worker is still calling, so it never stopped: no other prime owns the slot, and the call takes its family out of parking and the worker out of sleep. On 2026-09-01 six workers were refused WORKER_SLEEPING mid-turn here for being the last to "finish".
      const text = textOfReply(await pending);
      expect(text).not.toContain('WORKER_SLEEPING');
      expect(swarmRunning()).toBe(true);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    });

  it('recovers a dormant ceiling-silenced worker only from the exact retained request turn', async () => {
      startSwarm(1);
      startWorker('worker-1');
      const requestId = 'wfr_ceiling_same_turn';
      const turnId = 't-ceiling-same-turn';
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now(), turnId },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId,
          calls: [{ messageId: 'm-ceiling-same-turn', tool: 'read', order: 0, answered: false, requestId }]
        }
      ]);
      expect(textOfReply(await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] }))).toMatch(REFUSED_ON_ROOTS);
      const session = await findSessionByConversation('c-worker-1', { requireUnique: true });
      const cutoff = await requestTurnOwnershipCutoff(session!.id, 'c-worker-1');

      fillContext('c-worker-1');
      sleepSilentWorkers(
        Date.now() + WORKER_SILENCE_MS + 1,
        undefined,
        () => false,
        () => turnId,
        () => cutoff
      );
      expect(releaseQuiescentRun()).toBe(true);
      expect(silentCeilingRecoveryTurn('c-worker-1')).toBe(turnId);

      const late = textOfReply(await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] }));
      expect(late).not.toContain('WORKER_CONTEXT_LIMITED');
      expect(late).toMatch(REFUSED_ON_ROOTS);
      expect(swarmRunning()).toBe(true);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'active',
        silenceRecoveryTurnId: null
      });
    });

  it('refuses a new post-sleep turn in the same ceiling worker conversation', async () => {
      startSwarm(1);
      startWorker('worker-1');
      const oldRequestId = 'wfr_ceiling_old_turn';
      const oldTurnId = 't-ceiling-old-turn';
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now(), turnId: oldTurnId },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId: oldTurnId,
          calls: [{ messageId: 'm-ceiling-old-turn', tool: 'read', order: 0, answered: false, requestId: oldRequestId }]
        }
      ]);
      await ordinaryWithRequestId(oldRequestId, 'read', { paths: ['/anything'] });
      const session = await findSessionByConversation('c-worker-1', { requireUnique: true });
      const cutoff = await requestTurnOwnershipCutoff(session!.id, 'c-worker-1');
      fillContext('c-worker-1');
      sleepSilentWorkers(
        Date.now() + WORKER_SILENCE_MS + 1,
        undefined,
        () => false,
        () => oldTurnId,
        () => cutoff
      );
      expect(releaseQuiescentRun()).toBe(true);

      const newRequestId = 'wfr_ceiling_new_turn';
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now() + 1, turnId: 't-ceiling-new-turn' },
        {
          kind: 'tool_evidence',
          time: Date.now() + 1,
          turnId: 't-ceiling-new-turn',
          calls: [{ messageId: 'm-ceiling-new-turn', tool: 'read', order: 0, answered: false, requestId: newRequestId }]
        }
      ]);
      const refused = textOfReply(await ordinaryWithRequestId(newRequestId, 'read', { paths: ['/anything'] }));
      expect(refused).toContain('WORKER_CONTEXT_LIMITED');
      expect(refused).toContain('Nothing was run');
      expect(swarmRunning()).toBe(false);
      expect(silentCeilingRecoveryTurn('c-worker-1')).toBe(oldTurnId);
    });

  it('refuses ordinary tools from a null-marker ceiling park', async () => {
      startSwarm(1);
      startWorker('worker-1');
      fillContext('c-worker-1');
      sleepSilentWorkers(
        Date.now() + WORKER_SILENCE_MS + 1,
        undefined,
        () => false,
        () => null
      );
      expect(releaseQuiescentRun()).toBe(true);

      const requestId = 'wfr_ceiling_null_marker_new';
      await recordChatObservations('c-worker-1', [{
        kind: 'tool_evidence',
        time: Date.now() + 1,
        turnId: 't-ceiling-null-marker-new',
        calls: [{ messageId: 'm-ceiling-null-marker-new', tool: 'read', order: 0, answered: false, requestId }]
      }]);
      const refused = textOfReply(await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] }));
      expect(refused).toContain('WORKER_CONTEXT_LIMITED');
      expect(refused).toContain('Nothing was run');
      expect(refused).toContain('No complete pre-park request/turn recovery proof was retained');
      expect(swarmRunning()).toBe(false);
    });

  it('does not let post-park request attribution manufacture same-old-turn authority', async () => {
      startSwarm(1);
      startWorker('worker-1');
      const oldRequestId = 'wfr_ceiling_cutoff_old';
      const oldTurnId = 't-ceiling-cutoff-old';
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now(), turnId: oldTurnId },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId: oldTurnId,
          calls: [{ messageId: 'm-ceiling-cutoff-old', tool: 'read', order: 0, answered: false, requestId: oldRequestId }]
        }
      ]);
      await ordinaryWithRequestId(oldRequestId, 'read', { paths: ['/anything'] });
      const session = await findSessionByConversation('c-worker-1', { requireUnique: true });
      const cutoff = await requestTurnOwnershipCutoff(session!.id, 'c-worker-1');
      fillContext('c-worker-1');
      sleepSilentWorkers(
        Date.now() + WORKER_SILENCE_MS + 1,
        undefined,
        () => false,
        () => oldTurnId,
        () => cutoff
      );
      expect(releaseQuiescentRun()).toBe(true);

      const newRequestId = 'wfr_ceiling_cutoff_new';
      await recordChatObservations('c-worker-1', [
        { kind: 'user_message', time: Date.now() + 1, messageId: 'new-question-without-turn-start', text: 'new task' },
        {
          kind: 'tool_evidence',
          time: Date.now() + 2,
          turnId: oldTurnId,
          calls: [{ messageId: 'm-ceiling-cutoff-new', tool: 'read', order: 0, answered: false, requestId: newRequestId }]
        }
      ]);

      const first = textOfReply(await ordinaryWithRequestId(newRequestId, 'read', { paths: ['/anything'] }));
      const second = textOfReply(await ordinaryWithRequestId(newRequestId, 'read', { paths: ['/anything'] }));
      expect(first).toContain('WORKER_CONTEXT_LIMITED');
      expect(second).toContain('WORKER_CONTEXT_LIMITED');
      expect(first).toContain('Nothing was run');
      expect(second).toContain('Nothing was run');
      expect(swarmRunning()).toBe(false);
      expect(silentCeilingRecoveryTurn('c-worker-1')).toBe(oldTurnId);
    });

  it('refuses agents finish from a new post-sleep turn instead of treating it as a lost finish retry', async () => {
      startSwarm(1);
      startWorker('worker-1');
      const oldRequestId = 'wfr_ceiling_finish_old';
      const oldTurnId = 't-ceiling-finish-old';
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now(), turnId: oldTurnId },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId: oldTurnId,
          calls: [{ messageId: 'm-ceiling-finish-old', tool: 'read', order: 0, answered: false, requestId: oldRequestId }]
        }
      ]);
      await ordinaryWithRequestId(oldRequestId, 'read', { paths: ['/anything'] });
      const session = await findSessionByConversation('c-worker-1', { requireUnique: true });
      const cutoff = await requestTurnOwnershipCutoff(session!.id, 'c-worker-1');
      fillContext('c-worker-1');
      sleepSilentWorkers(
        Date.now() + WORKER_SILENCE_MS + 1,
        undefined,
        () => false,
        () => oldTurnId,
        () => cutoff
      );
      expect(releaseQuiescentRun()).toBe(true);

      const newRequestId = 'wfr_ceiling_finish_new';
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now() + 1, turnId: 't-ceiling-finish-new' },
        {
          kind: 'tool_evidence',
          time: Date.now() + 1,
          turnId: 't-ceiling-finish-new',
          calls: [{ messageId: 'm-ceiling-finish-new', tool: 'agents', order: 0, answered: false, requestId: newRequestId }]
        }
      ]);
      const refused = await agentsWithRequestId(newRequestId, 'finish', { result: 'wrong turn must not finish' });
      expect(refused).toContain('WORKER_CONTEXT_LIMITED');
      expect(refused).toContain('Nothing was run');
      expect(silentCeilingRecoveryTurn('c-worker-1')).toBe(oldTurnId);
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'sleeping',
        revivable: false,
        silenceRecoveryTurnId: oldTurnId
      });
    });

  it('accepts agents finish from the exact pre-park ceiling turn', async () => {
      startSwarm(1);
      startWorker('worker-1');
      const requestId = 'wfr_ceiling_finish_same';
      const turnId = 't-ceiling-finish-same';
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now(), turnId },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId,
          calls: [{ messageId: 'm-ceiling-finish-same', tool: 'read', order: 0, answered: false, requestId }]
        }
      ]);
      await ordinaryWithRequestId(requestId, 'read', { paths: ['/anything'] });
      const session = await findSessionByConversation('c-worker-1', { requireUnique: true });
      const cutoff = await requestTurnOwnershipCutoff(session!.id, 'c-worker-1');
      fillContext('c-worker-1');
      sleepSilentWorkers(
        Date.now() + WORKER_SILENCE_MS + 1,
        undefined,
        () => false,
        () => turnId,
        () => cutoff
      );
      expect(releaseQuiescentRun()).toBe(true);

      const finished = await agentsWithRequestId(requestId, 'finish', { result: 'same old turn done' });
      expect(finished).toMatch(/finished/i);
      expect(finished).not.toContain('WORKER_CONTEXT_LIMITED');
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'finished',
        revivable: false,
        silenceParked: false,
        silenceRecoveryTurnId: null
      });
    });

  it('delivers and acknowledges a parked prime inbox by exact conversation without adopting another history', async () => {
      startSwarm(1);
      startWorker('worker-1');

      const finished = await asChat('c-worker-1', 'finish', { result: 'parked-prime-report' });
      expect(finished).toMatch(/reported and is now asleep/i);
      expect(finished).toContain('This acknowledgment does not confirm delivery to the prime');
      expect(finished).not.toContain('The prime agent has your result');
      expect(swarmRunning()).toBe(false);

      const pending = () => snapshotSwarm()!.dormantRuns
        ?.find(family => family.primeConversationId === PRIME_CHAT)
        ?.agents.find(agent => agent.info.id === PRIME_ID)?.queue ?? [];
      expect(pending()).toHaveLength(1);
      expect(pending()[0]).toMatchObject({ offeredAt: null, offers: 0, ackedAt: null });
      const retry = await asChat('c-worker-1', 'finish', { result: 'retry must not replace the original report' });
      expect(retry).toContain('This acknowledgment does not confirm delivery to the prime');
      expect(retry).not.toContain('already has that result');
      expect(pending()).toHaveLength(1);
      expect(pending()[0]).toMatchObject({ offeredAt: null, offers: 0, ackedAt: null });
      expect(pending()[0]!.text).toContain('parked-prime-report');
      expect(pending()[0]!.text).not.toContain('retry must not replace');

      // The final worker report lives in A's dormant prime queue. There is no live agent:prime identity to address here, so delivery must resolve from the exact prime conversation.
      const first = await asChat(PRIME_CHAT, 'status');
      expect(first).toContain('--- 1 message(s) for prime ---');
      expect(first).toContain('parked-prime-report');
      expect(swarmRunning()).toBe(false);

      // Make another prime active with the same friendly `prime`/`worker-1` ids before A proves receipt. Friendly-id recording would now resolve `prime` to B, which is exactly the leak this regression guards against.
      spawn({ workers: [{ task: 'B is the active owner now' }], caller: { conversationId: 'c-prime-b' } });
      await recordChatObservations('c-prime-b', [{ kind: 'turn_start', time: Date.now(), turnId: 'b-active-turn' }]);

      // This authenticated follow-up proves the preceding result arrived and retires that offer. The historical worker/result can still appear in the status table, but the inbox row must not be pushed a second time.
      const second = await asChat(PRIME_CHAT, 'status');
      expect(second).not.toContain('--- 1 message(s) for prime ---');
      expect(swarmRunning()).toBe(true);

      const aSession = await findSessionByConversation(PRIME_CHAT, { requireUnique: true });
      const bSession = await findSessionByConversation('c-prime-b', { requireUnique: true });
      expect(aSession).toBeTruthy();
      expect(bSession).toBeTruthy();
      const aDelivered = (await readRecentEvents(aSession!.id, 50, { kinds: ['agent_message'] })).filter(
        (event) => event.kind === 'agent_message' && event.delivery === 'delivered' && event.message.text.includes('parked-prime-report')
      );
      const bDelivered = (await readRecentEvents(bSession!.id, 50, { kinds: ['agent_message'] })).filter(
        (event) => event.kind === 'agent_message' && event.delivery === 'delivered' && event.message.text.includes('parked-prime-report')
      );
      expect(aDelivered).toHaveLength(1);
      expect(bDelivered).toHaveLength(0);
    });

  it('makes a pending context-ceiling authority change durable before status publishes it', async () => {
      startSwarm(1);
      const worker = startWorker('worker-1');
      finishAgent(worker.caller, 'sleep before the late context measurement');
      expect(releaseQuiescentRun()).toBe(true);

      // Simulate the exact authority edge measureSleepingWorkers can discover from the durable worker session: the parked chat is now over 400k and therefore no longer revivable. Leave that critical revision pending, then prove the read-only status path itself drains it.
      noteAgentContextTokens('c-worker-1', WORKER_CONTEXT_CEILING_TOKENS);
      let written: ReturnType<typeof snapshotSwarm> | undefined;
      onSwarmPersistNow(async (snapshot) => {
        written = snapshot;
      });

      const text = await asChat(PRIME_CHAT, 'status');
      expect(text).toMatch(/worker-1.*finished \(not reusable\)/s);
      expect(text).not.toContain('REUSE FIRST: worker-1');
      const persistedWorker = written?.dormantRuns
        ?.flatMap((history) => history.agents)
        .find((entry) => entry.info.id === 'worker-1' && entry.info.conversationId === 'c-worker-1');
      expect(persistedWorker?.info).toMatchObject({
        state: 'finished',
        revivable: false,
        contextTokens: WORKER_CONTEXT_CEILING_TOKENS
      });
    });

  it('refuses a control call it cannot place at all, and says where to look', async () => {
      startSwarm(1);
      // No page evidence: this call could have come from anywhere, so it is not treated as a stranger and it is certainly not given a credential to carry instead.
      const text = await agents('status');
      expect(text).toContain('WORKER_IDENTITY_LOST');
      expect(text).toMatch(/No agent operation was performed/);
      expect(text).not.toContain('worker-1');
    });

  it('uses the inbound HTTP request id instead of stealing a worker’s earlier agents evidence', async () => {
      startSwarm(1);
      expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
      const now = Date.now();

      // The worker has an unclaimed agents request visible first. Before the HTTP-id hardening, callerNow() saw this while the prime page was one poll late and authenticated the prime call as worker-1, producing the live "An agent cannot message itself" failure.
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: now, turnId: 'worker-stale' },
        {
          kind: 'tool_evidence',
          time: now,
          turnId: 'worker-stale',
          calls: [
            {
              messageId: 'worker-stale-agents',
              tool: 'agents',
              order: 0,
              answered: false,
              requestId: 'wfr_worker_stale',
              createTime: now / 1000
            }
          ]
        }
      ]);

      const pending = agentsWithRequestId('wfr_prime_current', 'message', {
        to: 'worker-1',
        text: 'prime correction'
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await recordChatObservations(PRIME_CHAT, [
        { kind: 'turn_start', time: now + 80, turnId: 'prime-current' },
        {
          kind: 'tool_evidence',
          time: now + 80,
          turnId: 'prime-current',
          calls: [
            {
              messageId: 'prime-current-agents',
              tool: 'agents',
              order: 0,
              answered: false,
              requestId: 'wfr_prime_current',
              createTime: (now + 80) / 1000
            }
          ]
        }
      ]);

      const text = await pending;
      expect(text).toContain('Queued for worker-1');
      expect(text).not.toContain('cannot message itself');
      expect(pendingCount('worker-1')).toBe(1);
    });

  it('publishes no message when its durable acceptance barrier fails, and a retry queues exactly one', async () => {
      startSwarm(1);
      const snapshots: Array<ReturnType<typeof snapshotSwarm>> = [];
      onSwarmPersist(() => snapshots.push(snapshotSwarm()));
      let fail = true;
      onSwarmPersistNow(async () => {
        if (fail) {
          fail = false;
          throw new Error('injected disk barrier failure');
        }
      });

      const failed = await asChat(PRIME_CHAT, 'message', { to: 'worker-1', text: 'check the parser' });
      expect(failed).toMatch(/durable (?:acceptance )?barrier|nothing was queued/i);
      // The staged queue entry was never visible to the worker while the write was in flight, and rollback removed it before the failed call returned.
      expect(pendingCount('worker-1')).toBe(0);
      expect(offerMessages('worker-1')).toEqual([]);
      expect(swarmRunning()).toBe(true);
      expect(swarmState().agents.find((entry) => entry.id === 'worker-1')).toMatchObject({ pending: 0 });
      const afterFailure = snapshotSwarm();
      expect(afterFailure).not.toBeNull();
      expect(afterFailure?.agents.find((entry) => entry.info.id === 'worker-1')?.queue ?? []).toEqual([]);
      // rollback is itself a critical mutation and therefore emits a newer safe snapshot. This supersedes durable.ts's retained failed generation instead of letting it resurrect the rejected message later. The injected failure can now be consumed by the earlier context/revival measurement barrier, before message staging exists at all. In that case no rollback snapshot is necessary. If any debounced snapshots were published, none may contain the rejected row.
      expect(
        snapshots.every(
          (snapshot) => snapshot?.agents.find((entry) => entry.info.id === 'worker-1')?.queue.length !== 1
        )
      ).toBe(true);

      const retried = await asChat(PRIME_CHAT, 'message', { to: 'worker-1', text: 'check the parser' });
      expect(retried).toContain('Queued for worker-1');
      expect(pendingCount('worker-1')).toBe(1);
      expect(offerMessages('worker-1').map((message) => message.text)).toEqual(['check the parser']);
    });

  it('publishes no worker finish or prime report when its durable acceptance barrier fails', async () => {
      startSwarm(1);
      expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);
      let fail = true;
      onSwarmPersistNow(async () => {
        if (fail) {
          fail = false;
          throw new Error('injected finish durability failure');
        }
      });

      const failed = await asChat('c-worker-1', 'finish', { result: 'finished the audit' });
      expect(failed).toMatch(/durable acceptance barrier|nothing was published|finish durability failure/i);
      // Old finish mutated the worker and queued its report before awaiting the disk barrier, so the worker became terminal and a concurrent prime call could consume a result whose own caller was being told to retry. A failed acceptance must leave no live trace instead.
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
      expect(pendingCount(PRIME_ID)).toBe(0);
      expect(offerMessages(PRIME_ID)).toEqual([]);

      const retried = await asChat('c-worker-1', 'finish', { result: 'finished the audit' });
      expect(retried).toMatch(/reported and is now asleep/i);
      expect(swarmRunning()).toBe(false);
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === PRIME_ID)?.pending).toBe(1);
      expect(offerMessagesForConversation(PRIME_CHAT)?.messages).toHaveLength(1);
    });

  it('carries a worker through message and finish on its conversation alone', async () => {
      startSwarm(1);
      // The extension reports the chat it opened, exactly as it does in production. That is the whole of the worker's startup: no join, no key, nothing typed by the model.
      expect(bindConversation('worker-1', 'c-worker-1')).toBe(true);

      const sent = await asChat('c-worker-1', 'message', { to: PRIME_ID, text: 'the parser is the problem' });
      expect(sent).toContain('Queued for prime');
      expect(pendingCount(PRIME_ID)).toBe(1);

      const finished = await asChat('c-worker-1', 'finish', { result: 'fixed the parser' });
      expect(finished).toMatch(/reported and is now asleep/i);
      expect(swarmRunning()).toBe(false);
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.state).toBe('sleeping');
    });
});

