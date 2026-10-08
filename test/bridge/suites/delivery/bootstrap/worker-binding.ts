import { currentCoreInstructions } from "../../../../../backend/infrastructure/tool-gateway/protocol/instructions.js";
import { userPromptText } from "../../../../../contracts/messaging/provider-message-envelope.js";
import { acknowledgeOffers, bindConversation, COMMAND_DEADLINE_MS, createSession, describe, dir, expect, finishAgent, flushDurable, it, noteAgentContextTokens, offerMessages, onSwarmPersistNow, pair, pendingCommands, pendingWorkerSpawns, persistCriticalSwarmNow, PRIME_CHAT, PRIME_ID, queueResume, readDurable, readyContinuation, redeem, request, resetBridgeForTests, resetSwarm, restoreCommands, restoreSwarm, retiredWorkerForConversation, saveConfig, spawn, suiteConfig, swarmState, WORKER_CONTEXT_CEILING_TOKENS, writeDurableNow } from "../../../test-context.js";

describe("delivering a bootstrap: worker binding", () => {
  it('types the worker its task, and nothing about joining, keys or identity', async () => {
      await pair();
      spawn({ workers: [{ task: 'Audit the compaction transaction end to end' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();

      expect(command.agent).toBe('worker-1');
      // Shared guidance comes before the task. The app still binds worker identity; there is no joining/key handshake for the model to invent.
      expect(command.text).toContain(await currentCoreInstructions());
      const task = userPromptText(command.text)!;
      expect(task.startsWith('Audit the compaction transaction end to end')).toBe(true);
      expect(task).not.toMatch(/join/i);
      expect(task).not.toMatch(/agent[_ ]key/i);
      expect(command.text).not.toContain('joinKey');
      // It still says how to report, because that is about the work rather than about who it is.
      expect(command.text).toContain('action=message');
      expect(command.text).toContain('finish');

      await flushDurable();
      const stored = await readDurable<unknown>('bridge-commands');
      expect(JSON.stringify(stored)).not.toContain('joinKey');
    });

  it.each(['worker', 'resume'] as const)('adds setup only to a new worker, never a resumed chat (%s)', async kind => {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const { addProject, assignSessionProject } = await import("../../../../../backend/domains/workspace/projects.js");
      const folder = path.join(dir, `prompt-project-${kind}`);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'AGENTS.md'), 'SCOPED_AGENTS_HEAD\n' + 'a'.repeat(150000) + '\nSCOPED_AGENTS_TAIL');
      await saveConfig({ ...suiteConfig, roots: [{ name: 'project', path: folder }] });
      const project = await addProject(folder);
      const conversationId = `c-prompt-project-${kind}`;
      const source = await createSession({ title: 'Project source', conversationId });
      await assignSessionProject(source.id, project.id);
      await pair();
      let command;
      if (kind === 'worker') {
        spawn({ workers: [{ task: 'PROJECT_TASK_PRESERVED' }], caller: { conversationId } });
        command = await redeem();
      } else {
        const continuation = await readyContinuation(source.id, 'PROJECT_TASK_PRESERVED', conversationId);
        const pending = queueResume(source.id, continuation)!;
        command = await redeem(pending.id);
      }
      expect(command.text.length).toBeLessThanOrEqual(96000);
      if (kind === 'worker') {
        expect(command.text).toContain(await currentCoreInstructions());
        expect(command.text).toContain('SCOPED_AGENTS_HEAD');
        expect(command.text).toContain('Read AGENTS.md yourself');
        expect(userPromptText(command.text)).toContain('PROJECT_TASK_PRESERVED');
        expect(userPromptText(command.text)).not.toMatch(/SCOPED_AGENTS|Cut off/);
      } else {
        expect(command.text).not.toContain('[[NEURAFLOK_MESSAGE_V1:');
        expect(command.text).not.toContain('SCOPED_AGENTS_HEAD');
        expect(command.text).toContain('PROJECT_TASK_PRESERVED');
      }
      expect(command.text).not.toContain('SCOPED_AGENTS_TAIL');
    });

  /** Binding is the completion boundary. The command used to stay leased after the bootstrap was typed, "waiting for the worker to join", because joining was a thing a model had to do and could be prevented from doing. The extension's report *is* the worker starting, so the same acknowledgement that carries the conversation id both activates the worker and finishes the command. */
    it('activates the worker and retires its command on the acknowledgement that names the chat', async () => {
      await pair();
      spawn({ workers: [{ task: 'audit the compaction' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = 'abcdef12-3456-7890-abcd-ef1234567890';
      expect(command.expiresAt).toBeGreaterThan(Date.now());
      expect(command.expiresAt).toBeLessThanOrEqual(Date.now() + COMMAND_DEADLINE_MS);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('invited');

      await request('POST', '/commands/ack', {
        // Deliberately wrong. The worker slot comes from the app-owned command id, never from a page/body field that merely repeats what it was told.
        body: { id: command.id, status: 'sent', conversationId, agent: 'worker-99' }
      });

      const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('active');
      expect(worker.conversationId).toBe(conversationId);
      expect(pendingCommands()).toEqual([]);
      expect(pendingWorkerSpawns()).toEqual([]);
    });

  it('binds a fresh worker from exact early request correlation before its delayed command acknowledgement', async () => {
      await pair();
      spawn({ workers: [{ task: 'report through agents as soon as the first tool call begins' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem(undefined, 'early-correlation-worker-page');
      const conversationId = 'acacacac-3456-7890-abcd-ef1234567890';
      const correlate = (agentCommandId: string, requestId: string) => request('POST', '/correlations', {
        body: {
          conversationId,
          agent: 'worker-1',
          agentCommandId,
          calls: [{ requestId, messageId: null, tool: 'exec_command', order: 0, answered: false }]
        }
      });

      const stale = await correlate('not-the-leased-command', 'f0f00001-1111-4111-8111-111111111111');
      expect(stale.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'invited',
        conversationId: null
      });

      const exact = await correlate(command.id, 'f0f00002-1111-4111-8111-111111111111');
      expect(exact.status).toBe(200);
      expect(exact.body).toMatchObject({ conversationId, confirmed: ['f0f00002-1111-4111-8111-111111111111'] });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'active',
        conversationId
      });
    });

  it('recovers the exact leased worker command if a crash loses an early correlation binding before ACK', async () => {
      await pair();
      spawn({ workers: [{ task: 'survive the early-correlation crash window' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem(undefined, 'early-correlation-crash-page');
      const conversationId = 'abababab-3456-7890-abcd-ef1234567890';

      // Model the durable state immediately before the new fast path: the worker invitation and exact claimed browser command are already on disk, but the worker conversation is not.
      expect(await persistCriticalSwarmNow()).toBe(true);
      const invitedSwarm = await readDurable<any>('swarm');
      expect(invitedSwarm).not.toBeNull();
      expect((await readDurable<any>('bridge-commands'))?.commands).toContainEqual(expect.objectContaining({
        id: command.id,
        phase: 'leased',
        owner: 'early-correlation-crash-page'
      }));

      const first = await request('POST', '/correlations', {
        body: {
          conversationId,
          agent: 'worker-1',
          agentCommandId: command.id,
          calls: [{ requestId: 'f0f00004-1111-4111-8111-111111111111', messageId: null }]
        }
      });
      expect(first.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'active',
        conversationId
      });

      // Crash before the debounced swarm write. The safe side is the old invited snapshot plus the still-leased exact command; restart must therefore be able to bind the same slot again instead of needing a guessed run/worker fallback.
      restoreSwarm(invitedSwarm);
      resetBridgeForTests();
      await restoreCommands();
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'invited',
        conversationId: null
      });
      expect(pendingCommands()).toContainEqual(expect.objectContaining({ id: command.id }));

      const retry = await request('POST', '/correlations', {
        body: {
          conversationId,
          agent: 'worker-1',
          agentCommandId: command.id,
          calls: [{ requestId: 'f0f00005-1111-4111-8111-111111111111', messageId: null }]
        }
      });
      expect(retry.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
        state: 'active',
        conversationId
      });

      const ack = await request('POST', '/commands/ack', {
        body: {
          id: command.id,
          status: 'sent',
          conversationId,
          client: 'early-correlation-crash-page'
        }
      });
      expect(ack.status).toBe(200);
      expect(pendingCommands().some((entry) => entry.id === command.id)).toBe(false);
    });

  it('keeps the worker command durable until the worker binding itself crosses its crash barrier', async () => {
      await pair();
      spawn({ workers: [{ task: 'prove ack ordering' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem(undefined, 'ordered-worker-page');
      const conversationId = 'dddddddd-3456-7890-abcd-ef1234567890';

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const bindingWriteStarted = new Promise<void>((resolve) => {
        entered = resolve;
      });
      onSwarmPersistNow(async (snapshot) => {
        bindingWriteStarted.then(() => undefined);
        entered();
        await gate;
        await writeDurableNow('swarm', snapshot);
      });

      try {
        let ackSettled = false;
        const ack = request('POST', '/commands/ack', {
          body: {
            id: command.id,
            status: 'sent',
            conversationId,
            client: 'ordered-worker-page'
          }
        }).then((reply) => {
          ackSettled = true;
          return reply;
        });

        await bindingWriteStarted;
        // Binding is already published in memory, but the browser command remains the durable retry point until the matching swarm generation reaches disk. A crash right here must therefore restore the leased command rather than an invited worker with no command.
        expect(swarmState().agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
          state: 'active',
          conversationId
        });
        expect(ackSettled).toBe(false);
        const before = await readDurable<{ commands?: Array<{ id?: string }>; receipts?: Array<{ id?: string }> }>('bridge-commands');
        expect(before?.commands?.some((entry) => entry.id === command.id)).toBe(true);
        expect(before?.receipts?.some((entry) => entry.id === command.id)).toBe(false);

        release();
        const reply = await ack;
        expect(reply.status).toBe(200);
        const after = await readDurable<{ commands?: Array<{ id?: string }>; receipts?: Array<{ id?: string }> }>('bridge-commands');
        expect(after?.commands?.some((entry) => entry.id === command.id)).toBe(false);
        expect(after?.receipts?.some((entry) => entry.id === command.id)).toBe(true);
      } finally {
        release();
        onSwarmPersistNow((snapshot) => writeDurableNow('swarm', snapshot));
      }
    });

  it('restores a durable command receipt so a lost ACK response can be replayed after restart', async () => {
      await pair();
      spawn({ workers: [{ task: 'prove receipt recovery' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem(undefined, 'receipt-replay-page');
      const conversationId = 'eeeeeeee-3456-7890-abcd-ef1234567890';
      const ack = {
        id: command.id,
        status: 'sent',
        conversationId,
        client: 'receipt-replay-page'
      };

      const first = await request('POST', '/commands/ack', { body: ack });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ final: true, committed: true, conversationId });
      await flushDurable();
      const stored = await readDurable<{ version?: number; receipts?: Array<{ id?: string }> }>('bridge-commands');
      expect(stored?.version).toBe(4);
      expect(stored?.receipts?.some((entry) => entry.id === command.id)).toBe(true);

      // Simulate the main-process restart after the durable commit but before the browser got the HTTP response. The service worker has its own durable ACK outbox and will replay the exact ACK, so the bridge must recover the tombstone rather than answer "gone".
      resetBridgeForTests();
      await restoreCommands();
      const replay = await request('POST', '/commands/ack', { body: ack });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ final: true, committed: true, conversationId });
    });

  it('refuses an acknowledgement from a document that does not own the redeemed command', async () => {
      await pair();
      spawn({ workers: [{ task: 'ownership audit' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem(undefined, 'owner-page');
      const conversationId = 'abcdef12-3456-7890-abcd-ef1234567890';

      const stale = await request('POST', '/commands/ack', {
        body: {
          id: command.id,
          status: 'sent',
          conversationId,
          client: 'old-page'
        }
      });
      expect(stale.status).toBe(409);
      expect(pendingCommands().some((entry) => entry.id === command.id)).toBe(true);
      expect(pendingWorkerSpawns().map((worker) => worker.id)).toEqual(['worker-1']);

      const current = await request('POST', '/commands/ack', {
        body: {
          id: command.id,
          status: 'sent',
          conversationId,
          client: 'owner-page'
        }
      });
      expect(current.status).toBe(200);
      expect(pendingCommands().some((entry) => entry.id === command.id)).toBe(false);
    });

  it('does not let stale events from an old worker bind the same friendly id in a new run', async () => {
      await pair();
      spawn({ workers: [{ task: 'old run work' }], caller: { conversationId: PRIME_CHAT } });
      const oldCommand = await redeem();
      const oldConversation = 'aaaaaaaa-1111-2222-3333-444444444444';
      await request('POST', '/commands/ack', {
        body: { id: oldCommand.id, status: 'sent', conversationId: oldConversation, client: 'tab-1' }
      });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe(oldConversation);

      // End run A, then create run B. Friendly worker ids intentionally start over at worker-1.
      resetSwarm();
      spawn({ workers: [{ task: 'new run work' }], caller: { conversationId: PRIME_CHAT } });
      const newCommand = await redeem(undefined, 'new-run-page');
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('invited');

      // A delayed service-worker journal from the old page still carries `agent: worker-1`. That label is not an incarnation and must never establish the new run's binding.
      const stale = await request('POST', '/events', {
        body: {
          conversationId: oldConversation,
          agent: 'worker-1',
          agentCommandId: oldCommand.id,
          events: [{ kind: 'progress', time: Date.now(), text: 'late event from run A' }]
        }
      });
      expect(stale.status).toBe(200);
      const beforeAck = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
      expect(beforeAck.state).toBe('invited');
      expect(beforeAck.conversationId).toBeNull();

      const newConversation = 'bbbbbbbb-1111-2222-3333-444444444444';
      const ack = await request('POST', '/commands/ack', {
        body: {
          id: newCommand.id,
          status: 'sent',
          conversationId: newConversation,
          client: 'new-run-page'
        }
      });
      expect(ack.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBe(newConversation);
    });

  it('recovers a lost worker ACK only when events carry the exact redeemed command id', async () => {
      await pair();
      spawn({ workers: [{ task: 'recover my binding' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem(undefined, 'worker-page');
      expect(command.agent).toBe('worker-1');
      const conversationId = 'cccccccc-1111-2222-3333-444444444444';

      const missingRun = await request('POST', '/events', {
        body: {
          conversationId,
          agent: 'worker-1',
          events: [{ kind: 'progress', time: Date.now(), text: 'old extension shape' }]
        }
      });
      expect(missingRun.status).toBe(200);
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.conversationId).toBeNull();

      const recovered = await request('POST', '/events', {
        body: {
          conversationId,
          agent: 'worker-1',
          agentCommandId: command.id,
          events: [{ kind: 'progress', time: Date.now(), text: 'same-run recovery' }]
        }
      });
      expect(recovered.status).toBe(200);
      const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
      expect(worker.state).toBe('active');
      expect(worker.conversationId).toBe(conversationId);
    });

  it('detaches an active worker when the browser reports its final chat tab closed', async () => {
      await pair();
      spawn({ workers: [{ task: 'close lifecycle' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = 'fedcba98-7654-3210-fedc-ba9876543210';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', conversationId, agent: 'worker-1' }
      });
      expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');

      const closed = await request('POST', '/closed', { body: { conversationId } });
      expect(closed.body.ok).toBe(true);
      const worker = swarmState().agents.find((agent) => agent.id === 'worker-1')!;
      // The tab is not the turn. A ChatGPT turn runs on OpenAI's servers, so a closed tab means this app has lost sight of the worker, not that the worker has stopped.
      expect(worker.state).toBe('detached');
      expect(swarmState().running).toBe(true);
    });

  it('keeps a retired worker tool fence after its browser tab closes', async () => {
      await pair();
      // /closed accepts only real provider conversation IDs. The shared PRIME_CHAT test fixture is deliberately human-readable and therefore does not cross that HTTP validation boundary; using it here made the regression stop before it ever exercised retired-worker cleanup.
      const primeConversation = '11111111-2222-4333-8444-555555555555';
      spawn({ workers: [{ task: 'finish before the run closes' }], caller: { conversationId: primeConversation } });
      const workerConversation = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      expect(bindConversation('worker-1', workerConversation)).toBe(true);
      noteAgentContextTokens(workerConversation, WORKER_CONTEXT_CEILING_TOKENS);
      finishAgent({ conversationId: workerConversation }, 'worker finished before the prime went away');
      // This test is about the post-run retired-worker fence, not pending-report survival. A terminal report must be delivered before the run may retire; the separate agent tests cover closing the prime while that report is still owed.
      offerMessages(PRIME_ID);
      acknowledgeOffers(PRIME_ID);

      const primeClosed = await request('POST', '/closed', { body: { conversationId: primeConversation } });
      expect(primeClosed.body.ok).toBe(true);
      expect(swarmState().running).toBe(false);
      expect(retiredWorkerForConversation(workerConversation)).toMatchObject({
        id: 'worker-1',
        conversationId: workerConversation
      });

      // Closing the browser view is not evidence that OpenAI's server-side turn can no longer call this connector. The post-run retired lease is therefore still required after the page disappears; otherwise the same finished worker chat regains ordinary tool access.
      const workerClosed = await request('POST', '/closed', { body: { conversationId: workerConversation } });
      expect(workerClosed.body.ok).toBe(true);
      expect(retiredWorkerForConversation(workerConversation)).toMatchObject({
        id: 'worker-1',
        conversationId: workerConversation
      });
    });
});
