import {
  DEFAULT_CAPABILITIES,
  PRIME_CHAT,
  PRIME_ID,
  bindConversation,
  claimWorkerRevival,
  clearAgent,
  currentRunId,
  dir,
  fillContext,
  findSessionByConversation,
  finishAgent,
  noteWorkerRevived,
  offerMessages,
  offerMessagesForConversation,
  onSwarmPersistNow,
  pendingCount,
  pendingWorkerRevivals,
  prime,
  reactivateDormantRunForConversation,
  readRecentEvents,
  recordChatObservations,
  releaseQuiescentRun,
  runningToolCalls,
  sendMessage,
  snapshotSwarm,
  spawn,
  stageMessages,
  startMcpServer,
  startSwarm,
  startWorker,
  statusForCaller,
  swarmStateForCaller,
} from './context.js';
import type { Caller } from './context.js';
import {
  agentsWithRequestId,
  asChat,
  mcpState,
  post,
  startMcpEndpoint,
  stopMcpEndpoint,
  structuredAsChat,
  waitForRunningToolCall,
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

  it('does not tell the prime a worker missed a message that the finish call itself confirms', async () => {
      startSwarm(1);
      bindConversation('worker-1', 'c-worker-1');
      sendMessage(prime, 'worker-1', 'include the parser edge case in your final result');

      // This result offers the instruction. It stays pending until the worker's *next* exact call, because that next call is the broker's evidence that this result reached ChatGPT.
      const offered = await asChat('c-worker-1', 'status');
      expect(offered).toContain('include the parser edge case');
      expect(pendingCount('worker-1')).toBe(1);

      // The next call happens to be finish. Kernel acknowledgement runs after the handler so the old finish planner still saw the offered row as unacked and wrote a false warning into the final report, even though this exact call immediately marks that same row delivered.
      await asChat('c-worker-1', 'finish', { result: 'parser edge case included' });
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(0);
      const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
        message.text.includes('[worker-1 reported]')
      );
      expect(report?.text).toContain('parser edge case included');
      expect(report?.text).not.toContain('ended without ever confirming');
    });

  it('does not call a message unread when it arrived after the worker\'s last step and is still queued for it (#551)', async () => {
      startSwarm(1);
      bindConversation('worker-1', 'c-worker-1');
      // Live 2.1.17 trace: the prime queued the next assignment while the worker was finishing the previous one. The report said the worker "ended without ever confirming" it, and a millisecond later the app woke the worker to deliver exactly that message.
      sendMessage(prime, 'worker-1', 'second assignment: run the canary again');
      await asChat('c-worker-1', 'finish', { result: 'first assignment done' });
      const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
        message.text.includes('[worker-1 reported]')
      );
      expect(report?.text).toContain('first assignment done');
      expect(report?.text).not.toContain('ended without ever confirming');
      expect(report?.text).not.toContain('may not have read');
      expect(report?.text).toContain('still queued for it');
      // And it really is: the unread assignment waits for the worker instead of being dropped.
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(1);
    });

  it('tells the prime how much worker capacity the report just freed, and that the worker is reusable', async () => {
      // A worker that reports is capacity coming back, and the prime is the only party that can spend it. The final report used to end at the result, so "finished" read as an ending and remaining work sat unspawned. The count is what makes it actionable: it has to be the slots free *after* this worker stops, not the whole limit. And the slot is not the only thing coming back — the worker itself is, in the chat it already has.
      startSwarm(2);
      bindConversation('worker-1', 'c-worker-1');
      bindConversation('worker-2', 'c-worker-2');

      const workerResult = await asChat('c-worker-1', 'finish', { result: 'first half done' });
      expect(workerResult).toContain('remains reusable');
      expect(workerResult).toContain('wake this same chat with agents action=message before spawning a replacement');
      const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
        message.text.includes('[worker-1 reported]')
      );
      // worker-2 is still live against a limit of 3, so two slots are free — not three.
      expect(report?.text).toContain('2 of 3 worker slots are free');
      expect(report?.text).toContain('worker-1 sleeping');
      expect(report?.text).toContain('Reuse first: agents action=message to="worker-1"');
      expect(report?.text).toContain('Spawn only when no sleeping worker is suitable');
      expect(report?.text).not.toContain('cannot be reused');

      const status = await asChat(PRIME_CHAT, 'status');
      expect(status).toContain('worker-1  worker  sleeping (reusable; wake with action=message)');
      expect(status).toContain('REUSE FIRST: worker-1');
      expect(status).toContain('For related follow-up work, do this before action=spawn');

      // With the last worker asleep the whole limit is free, and the singular reads correctly.
      await asChat('c-worker-2', 'finish', { result: 'second half done' });
      const last = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
        message.text.includes('[worker-2 reported]')
      );
      expect(last?.text).toContain('3 of 3 worker slots are free');
    });

  it('tells the prime a worker is gone for good only once its own chat is full', async () => {
      startSwarm(1);
      bindConversation('worker-1', 'c-worker-1');
      fillContext('c-worker-1');

      const workerResult = await asChat('c-worker-1', 'finish', { result: 'all of it done' });
      expect(workerResult).toContain('reached its context limit');
      expect(workerResult).toContain('This acknowledgment does not confirm delivery to the prime');
      expect(workerResult).not.toContain('The prime agent has your result');
      expect(workerResult).not.toContain('remains reusable');
      const report = offerMessagesForConversation(PRIME_CHAT)?.messages.find((message) =>
        message.text.includes('[worker-1 finished]')
      );
      expect(report?.text).toContain('context limit');
      expect(report?.text).toContain('Spawn a new worker');
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.revivable).toBe(false);
    });

  it('carries a wake label through the MCP schema, in a message batch only', async () => {
      startSwarm(1);
      const worker = startWorker('worker-1');
      finishAgent(worker.caller, 'done');
      const message = { to: 'worker-1', text: 'review the new task', label: 'Review' };
      // The single to+text form has no label (it keeps the agents schema within its budget).
      expect(await asChat(PRIME_CHAT, 'message', message)).toMatch(/input validation|unrecognized key/i);
      const result = await asChat(PRIME_CHAT, 'message', { messages: [message] });
      expect(result).toContain('Waking worker-1');
      expect(statusForCaller(prime).state.agents.find(agent => agent.id === 'worker-1')?.label).toBe('Review');
    });

  it('cannot be spoofed by naming an agent in the arguments', async () => {
      startSwarm(1);
      bindConversation('worker-1', 'c-worker-1');
      const spoofed = await asChat('c-outsider', 'message', { agent: 'worker-1', to: PRIME_ID, text: 'spoof' });
      // The live schema now rejects the retired `agent` field before broker identity runs. That is stronger than the old AGENTS_BUSY path: caller-controlled identity is not even a syntactically valid request anymore. Keep the broker invariant below as the real outcome.
      expect(spoofed).toMatch(/input validation|unrecognized key|AGENTS_BUSY|unknown/i);
      expect(pendingCount(PRIME_ID)).toBe(0);
    });

  it('pushes waiting messages onto a worker result and acknowledges them on the next call', async () => {
      startSwarm(1);
      bindConversation('worker-1', 'c-worker-1');

      sendMessage(prime, 'worker-1', 'stop and check the parser first');
      const withMessage = await asChat('c-worker-1', 'status');
      expect(withMessage).toContain('stop and check the parser first');

      // The next placed call is what retires it, so a lost result is re-offered.
      const after = await asChat('c-worker-1', 'status');
      expect(after).not.toContain('stop and check the parser first');
      expect(pendingCount('worker-1')).toBe(0);
    });

  it('does not let an MCP call already in flight across a browser revival ACK consume or repeat the wake text', async () => {
      startSwarm(1);
      bindConversation('worker-1', 'c-worker-1');
      finishAgent({ conversationId: 'c-worker-1' }, 'first piece done');
      stageMessages(prime, [{ to: 'worker-1', text: 'wake text belongs to the browser user turn' }]).commit();
      const revival = pendingWorkerRevivals()[0]!;
      expect(claimWorkerRevival('worker-1', 'c-worker-1')).toBe(true);

      // Re-open this test's MCP endpoint with one real command tool so the handler can remain in flight while the browser ACK lands. The exact request-id evidence is recorded *before* the request, which is also a real ordering supported by ChatGPT's connector renderer.
      await mcpState.endpoint.stop();
      mcpState.endpoint = await startMcpServer(() => ({
        roots: [{ name: 'probe', path: dir }],
        caps: { ...DEFAULT_CAPABILITIES, command: true },
        readOnly: false,
        sessionTools: false,
        agentTools: true
      }));
      const requestId = `wfr_exec_held_${++mcpState.evidenceSeq}`;
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now(), turnId: `t-held-${mcpState.evidenceSeq}` },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId: `t-held-${mcpState.evidenceSeq}`,
          calls: [{ messageId: `m-held-${mcpState.evidenceSeq}`, tool: 'exec_command', order: 0, answered: false, requestId }]
        }
      ]);

      const started = Date.now();
      const shell =
        process.platform === 'win32'
          ? `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
          : '/bin/sh';
      const heldCommand =
        process.platform === 'win32'
          ? "Start-Sleep -Milliseconds 750; Write-Output 'held-call-done'"
          : "sleep 1; printf '%s\\n' held-call-done";
      const pending = post(
        {
          jsonrpc: '2.0',
          id: mcpState.nextId++,
          method: 'tools/call',
          params: {
            name: 'exec_command',
            arguments: {
              cmd: heldCommand,
              workdir: dir,
              shell,
              yield_time_ms: 30_000
            }
          }
        },
        { 'x-request-id': `${requestId}/relay` }
      );
      await waitForRunningToolCall();
      expect(runningToolCalls('c-worker-1')).toBeGreaterThan(0);

      expect(noteWorkerRevived('worker-1', 'c-worker-1', revival.messageIds)).toBe(true);
      const offeredAt = snapshotSwarm()!.agents.find((entry) => entry.info.id === 'worker-1')!.queue[0]!.offeredAt!;
      expect(offeredAt).toBeGreaterThanOrEqual(started);

      const reply = await pending;
      const text = ((reply.result?.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join('\n');
      expect(text).toContain('held-call-done');
      expect(text).not.toContain('wake text belongs to the browser user turn');
      // This call began before the browser offered the real user message, so completing later is not evidence that it saw that message. The row remains pending but is non-reofferable.
      expect(pendingCount('worker-1')).toBe(1);
      expect(offerMessages('worker-1')).toEqual([]);

      // The next authenticated call really did begin after the user-message delivery and may retire it. It still must not repeat those words through its own result.
      const later = await asChat('c-worker-1', 'status');
      expect(later).not.toContain('wake text belongs to the browser user turn');
      expect(pendingCount('worker-1')).toBe(0);
    }, 45_000);

  it('keeps a terminal worker tombstone only for finish retry and re-offers the lost finish inbox', async () => {
      startSwarm(1);
      bindConversation('worker-1', 'c-worker-1');
      sendMessage(prime, 'worker-1', 'check the parser before you stop');
      // A tombstone is only ever a worker that ended for good; anything else sleeps and is welcome back on its own next call.
      fillContext('c-worker-1');

      // The message is first offered on the finish result. If that result is lost, another finish call is not evidence that the worker saw it and must not ACK it.
      const first = await asChat('c-worker-1', 'finish', { result: 'done' });
      expect(first).toContain('check the parser before you stop');
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(1);

      const retry = await asChat('c-worker-1', 'finish', { result: 'done, retry after lost result' });
      expect(retry).toMatch(/already finished|already.*done/i);
      expect(retry).toContain('check the parser before you stop');
      expect(swarmStateForCaller(prime).agents.find((agent) => agent.id === 'worker-1')?.pending).toBe(1);

      // The tombstone is not general membership. The same terminal chat still cannot use the ordinary agents surface after it has finished.
      const status = await asChat('c-worker-1', 'status');
      expect(status).toMatch(/WORKER_ENDED|AGENTS_BUSY/);
    });

  it('enforces worker-to-worker refusal over the wire', async () => {
      startSwarm(2);
      bindConversation('worker-1', 'c-worker-1');
      bindConversation('worker-2', 'c-worker-2');
      // This regression is about the worker-to-worker policy, not the separate late page-evidence window exercised by asChat(). Give the request its exact browser mate before HTTP so a slow hosted runner cannot turn an unrelated correlation race into WORKER_IDENTITY_LOST.
      const seq = ++mcpState.evidenceSeq;
      const requestId = `wfr_agents_worker_policy_${seq}`;
      await recordChatObservations('c-worker-1', [
        { kind: 'turn_start', time: Date.now(), turnId: `t-${seq}` },
        {
          kind: 'tool_evidence',
          time: Date.now(),
          turnId: `t-${seq}`,
          calls: [{ messageId: `m-${seq}`, tool: 'agents', order: 0, answered: false, requestId }]
        }
      ]);
      const refused = await agentsWithRequestId(requestId, 'message', { to: 'worker-2', text: 'psst' });
      expect(refused).toMatch(/prime/i);
      expect(pendingCount('worker-2')).toBe(0);
    });

  it('messages several workers in one call, on one identity resolution', async () => {
      startSwarm(2);
      bindConversation('worker-1', 'c-worker-1');
      bindConversation('worker-2', 'c-worker-2');

      const text = await asChat(PRIME_CHAT, 'message', {
        messages: [
          { to: 'worker-1', text: 'ignore the UI' },
          { to: 'worker-2', text: 'check the README too' }
        ]
      });

      expect(text).toContain('worker-1');
      expect(text).toContain('worker-2');
      expect(pendingCount('worker-1')).toBe(1);
      expect(pendingCount('worker-2')).toBe(1);
    });

  it('refuses a message call that spells the same operation both ways at once', async () => {
      startSwarm(1);
      bindConversation('worker-1', 'c-worker-1');

      const text = await asChat(PRIME_CHAT, 'message', {
        to: 'worker-1',
        text: 'one way',
        messages: [{ to: 'worker-1', text: 'the other way' }]
      });

      expect(text).toMatch(/either to\+text or messages/i);
      expect(pendingCount('worker-1')).toBe(0);
    });

  it('lets existing primes exchange messages by explicit run address without exposing foreign workers', async () => {
      const primeB: Caller = { conversationId: 'mcp-peer-prime-b' };
      const a = spawn({ caller: prime, workers: [{ task: 'A worker' }] });
      const b = spawn({ caller: primeB, workers: [{ task: 'B worker' }] });
      expect(bindConversation('worker-1', 'mcp-peer-worker-a', a.runId)).toBe(true);

      const sent = await structuredAsChat(PRIME_CHAT, 'message', {
        target_run_id: b.runId,
        text: 'B, audit the parser lane'
      });
      expect(sent).toMatchObject({
        action: 'message',
        run_id: a.runId,
        target_run_id: b.runId,
        queued: [{ to: PRIME_ID }]
      });

      const received = await asChat(primeB.conversationId!, 'status');
      expect(received).toContain('B, audit the parser lane');
      expect(received).toContain(`source_run_id=${a.runId}`);
      expect(received).not.toContain('mcp-peer-worker-a');

      const reply = await asChat(primeB.conversationId!, 'message', {
        target_run_id: a.runId,
        text: 'A, parser lane is covered'
      });
      expect(reply).toContain(b.runId);
      const bSession = await findSessionByConversation(primeB.conversationId!);
      const delivered = bSession
        ? (await readRecentEvents(bSession.id, 50, { kinds: ['agent_message'] })).filter(
            event => event.kind === 'agent_message' && event.delivery === 'delivered' && event.message.text === 'B, audit the parser lane'
          )
        : [];
      expect(delivered).toEqual([expect.objectContaining({ fromRunId: a.runId })]);
      const returned = await asChat(PRIME_CHAT, 'status');
      expect(returned).toContain('A, parser lane is covered');
      expect(returned).toContain(`source_run_id=${b.runId}`);

      const refused = await asChat('mcp-peer-worker-a', 'message', {
        target_run_id: b.runId,
        text: 'worker bypass'
      });
      expect(refused).toMatch(/only a prime/i);

      const foreignWorker = await asChat(PRIME_CHAT, 'message', {
        target_run_id: b.runId,
        to: 'worker-1',
        text: 'reach through to B worker'
      });
      expect(foreignWorker).toMatch(/destination prime/i);
    });

  it('rolls back a cross-prime message on a failed durable write and accepts exactly one retry', async () => {
      const peer = { conversationId: 'mcp-peer-durability' };
      spawn({ caller: prime, workers: [{ task: 'A worker' }] });
      const b = spawn({ caller: peer, workers: [{ task: 'B worker' }] });
      onSwarmPersistNow(async () => { throw new Error('injected peer write failure'); });

      const failed = await asChat(PRIME_CHAT, 'message', { target_run_id: b.runId, text: 'audit parser' });
      expect(failed).toContain('Nothing was queued; retry the same message request. (injected peer write failure)');
      expect(offerMessagesForConversation(peer.conversationId)?.messages).toEqual([]);
      expect(snapshotSwarm()?.activeRuns?.find(run => run.runId === b.runId)
        ?.agents.find(agent => agent.info.id === PRIME_ID)?.queue).toEqual([]);

      onSwarmPersistNow(async () => undefined);
      const retried = await asChat(PRIME_CHAT, 'message', { target_run_id: b.runId, text: 'audit parser' });
      expect(retried).toContain(`Queued for prime family ${b.runId}`);
      expect(offerMessagesForConversation(peer.conversationId)?.messages.map(message => message.text)).toEqual(['audit parser']);
    });

  it('refuses a cross-prime message if its destination disappears during the durable write', async () => {
      spawn({ caller: prime, workers: [{ task: 'A worker' }] });
      const b = spawn({ caller: { conversationId: 'mcp-peer-retired' }, workers: [{ task: 'B worker' }] });
      onSwarmPersistNow(async () => { clearAgent(PRIME_ID, b.runId); });

      const failed = await asChat(PRIME_CHAT, 'message', { target_run_id: b.runId, text: 'late handoff' });
      expect(failed).toContain('TARGET_RUN_UNAVAILABLE: the destination prime family changed before acceptance. Nothing was queued.');
      expect(currentRunId('mcp-peer-retired')).toBeNull();
      expect(swarmStateForCaller(prime).agents.find(agent => agent.id === PRIME_ID)?.pending).toBe(0);
    });

  it('keeps an unacknowledged cross-prime reply address valid across more than eight source incarnations', async () => {
      const primeB: Caller = { conversationId: 'mcp-peer-reply-prime-b' };
      const a = spawn({ caller: prime, workers: [{ task: 'A worker' }] });
      const b = spawn({ caller: primeB, workers: [{ task: 'B worker' }] });
      expect(bindConversation('worker-1', 'mcp-peer-reply-worker-a', a.runId)).toBe(true);

      const sent = await asChat(PRIME_CHAT, 'message', {
        target_run_id: b.runId,
        text: 'B, hold this reply route while A sleeps'
      });
      expect(sent).toContain(`target_run_id=${a.runId}`);

      // B has seen A's source_run_id, but has not made the next authenticated call that ACKs this result yet. A can legitimately sleep and wake repeatedly in the meantime.
      const received = await asChat(primeB.conversationId!, 'status');
      expect(received).toContain(`source_run_id=${a.runId}`);
      finishAgent({ conversationId: 'mcp-peer-reply-worker-a' }, 'A sleeps');
      expect(releaseQuiescentRun({}, a.runId)).toBe(true);

      let currentA = a.runId;
      for (let incarnation = 0; incarnation < 12; incarnation += 1) {
        expect(reactivateDormantRunForConversation('mcp-peer-reply-worker-a')).toBe(true);
        const nextA = currentRunId(PRIME_CHAT)!;
        expect(nextA).not.toBe(currentA);
        expect(releaseQuiescentRun({}, nextA)).toBe(true);
        currentA = nextA;
      }
      const parkedA = snapshotSwarm()!.dormantRuns!.find(run => run.primeConversationId === PRIME_CHAT)!;
      expect(parkedA.formerRunIds).toHaveLength(9);
      expect(parkedA.formerRunIds?.[0]).toBe(a.runId);

      // This is B's next authenticated call, so the kernel ACKs the previously offered row before dispatching the reply. The source_run_id printed in that row must still be a valid address.
      const reply = await asChat(primeB.conversationId!, 'message', {
        target_run_id: a.runId,
        text: 'A, the delayed peer reply still routes'
      });
      expect(reply).toContain('Queued for prime family');

      const returned = await asChat(PRIME_CHAT, 'status');
      expect(returned).toContain('A, the delayed peer reply still routes');
    });

  it('carries the run and every agent in machine-readable form beside the prose', async () => {
      startSwarm(1);
      bindConversation('worker-1', 'c-worker-1');

      const structured = await structuredAsChat(PRIME_CHAT, 'status');
      expect(structured.action).toBe('status');
      expect(structured.self).toBe(PRIME_ID);
      expect(structured.run_id).toBeTypeOf('string');
      const worker = (structured.agents as Array<Record<string, unknown>>).find((agent) => agent.id === 'worker-1');
      expect(worker).toMatchObject({ id: 'worker-1', role: 'worker', state: 'active' });
    });
});

