import { webProviderConversationId } from "../../../../../contracts/web-providers.js";
import { bridgePort, bridgeState, cancelPrimeTransfer, commandUrl, commitContinuation, compactedSession, continuationByToken, createSession, describe, expect, getLog, getSession, it, noteChatOrigin, opened, pair, pendingCommands, pendingWorkerSpawns, PRIME_CHAT, queueResume, readyContinuation, recordChatObservations, redeem, request, resetBridgeForTests, resetRecorderForTests, resetSwarm, setBrowserOpener, shutdownBridge, spawn, startBridge, stopBridge, vi, waitForOpened } from "../../../test-context.js";

describe("delivering a bootstrap: opening and resume", () => {
  it('does not publish or deliver a bridge start after stop begins', async () => {
      // Model Cmd+Q/settings stop while a fresh bridge is between listen() and startup recovery. An invited worker already exists in broker state, so registering the startup replay listener is enough to queue and deliver a browser bootstrap. The old stopBridge() waited for all of that to finish before stopping the socket, which opened ChatGPT after shutdown had begun even though the final bridge state was correctly "stopped".
      await stopBridge();
      resetBridgeForTests();
      opened.length = 0;
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      resetSwarm();
      spawn({ workers: [{ task: 'must not open during shutdown' }], caller: { conversationId: PRIME_CHAT } });
      expect(pendingWorkerSpawns()).toHaveLength(1);

      const starting = startBridge();
      const stopping = stopBridge();
      await Promise.all([starting, stopping]);

      expect(opened).toEqual([]);
      expect(bridgePort()).toBeNull();
      expect(pendingCommands()).toEqual([]);

      // Restore the suite's ordinary live bridge without replaying the deliberately cancelled run.
      resetSwarm();
      resetBridgeForTests();
      setBrowserOpener(async (url) => {
        opened.push(url);
      });
      const restarted = await startBridge();
      expect(restarted).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${restarted}`;
      opened.length = 0;
    });

  it('lets a newer start win over a queued stop while the previous start is still settling', async () => {
      await stopBridge();
      resetBridgeForTests();
      resetSwarm();

      // A = start already in flight. The stop invalidates A immediately, then B expresses the newest desired state before A has even finished its listen callback. The old bridgeStarting design made B join A's now-cancelled promise, so both starts returned null and the bridge stayed off even though the last request was "start".
      const startA = startBridge();
      const stop = stopBridge();
      const startB = startBridge();
      const [a, , b] = await Promise.all([startA, stop, startB]);

      expect(a).toBeNull();
      expect(b).not.toBeNull();
      expect(bridgePort()).toBe(b);
      bridgeState.base = `http://127.0.0.1:${b}`;
    });

  it('makes final app shutdown terminal even if a later settings save asks to start the bridge', async () => {
      // Ordinary stop/start deliberately uses latest intent so a rapid Settings toggle can recover. Final app shutdown is different: an IPC settings handler that was already awaiting config or persistence when Cmd+Q began can resume afterwards and call startBridge(). That stale runtime work must not reopen localhost admission or browser delivery during bounded teardown.
      const shuttingDown = shutdownBridge();
      const staleSettingsStart = startBridge();
      const [, restarted] = await Promise.all([shuttingDown, staleSettingsStart]);

      expect(restarted).toBeNull();
      expect(bridgePort()).toBeNull();

      // Test process continues after simulating final shutdown; a real Electron process exits here.
      resetBridgeForTests();
      const restored = await startBridge();
      expect(restored).not.toBeNull();
      bridgeState.base = `http://127.0.0.1:${restored}`;
    });

  it('opens the chat, hands the brief to the page that redeems it, and forgets it on success', async () => {
      await pair();
      expect(pendingCommands()).toEqual([]);

      const { sessionId, token } = await compactedSession(webProviderConversationId('deepseek', '11111111-2222-3333-4444-555555555555'), 'NEXT — finish the bridge rewrite.');
      const command = queueResume(sessionId, token);
      expect(command).not.toBeNull();
      // Opened by the app after the leased command phase is durable, with nothing having asked for it. The disk boundary is asynchronous even though no browser poll is involved.
      await waitForOpened(1);
      expect(opened).toEqual([commandUrl(command!.id, 'deepseek')]);

      expect((await request('GET', '/status')).body.commandIds).toContain(command!.id);

      // The brief itself is what gets typed: there is no tool call to make and no id to quote.
      const redeemed = await redeem(command!.id);
      expect(redeemed.id).toBe(command!.id);
      expect(redeemed.kind).toBe('open-chat');
      // This is browser authority, not presentation metadata. content.js arms hidden-tab Goal recovery only for a real Compact & Resume replacement after its ACK; without the wire type the production bridge looked identical to a worker bootstrap here even though content-script unit tests supplied a mocked `type: 'resume'`.
      expect(redeemed.type).toBe('resume');
      expect(redeemed.text).toContain('NEXT — finish the bridge rewrite.');

      const ack = await request('POST', '/commands/ack', {
        body: { id: command!.id, status: 'sent', conversationId: 'abcdef12-3456-7890-abcd-ef1234567890' }
      });
      expect(ack.status).toBe(200);
      expect(ack.body.committed).toBe(true);
      expect(pendingCommands()).toEqual([]);
      expect((await request('GET', '/status')).body.commandIds).not.toContain(command!.id);
    });

  it('recycles only settled app-owned chats, preserving personal history and open turns', async () => {
      await pair();
      const settled = 'aaaaaaaa-2222-4222-8333-444444444441';
      const personal = 'aaaaaaaa-2222-4222-8333-444444444442';
      const working = 'aaaaaaaa-2222-4222-8333-444444444443';
      for (const id of [settled, working]) await noteChatOrigin(id, { kind: 'desktop', fromSessionId: null, agentId: null, task: '' });
      for (const id of [settled, personal, working]) {
        await request('POST', '/events', { body: { conversationId: id, events: [
          { kind: 'turn_start', time: Date.now(), turnId: 'old-turn' },
          { kind: 'turn_end', time: Date.now(), turnId: 'old-turn', outcome: 'completed' }
        ] } });
      }
      await request('POST', '/events', { body: { conversationId: working, events: [
        { kind: 'turn_start', time: Date.now(), turnId: 'still-running' }
      ] } });
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 121_000);
      try {
        const early = (await request('POST', '/status', { body: { openConversations: [settled, personal, working] } })).body;
        expect(early.reusableConversations).toEqual([settled]);
        expect(early.closableConversations).toEqual([]);
        clock.mockReturnValue(now + 301_000);
        const expired = (await request('POST', '/status', { body: { openConversations: [settled, personal, working] } })).body;
        expect(expired.closableConversations).toEqual([settled]);
        expect(expired.retiredConversations).toEqual([]);
      } finally { clock.mockRestore(); }
    });

  it('projects the proven worker opening even beyond the activity cursor, never a later visible question', async () => {
      await pair();
      const worker = '66666666-3333-2222-1111-000000000081';
      spawn({ workers: [{ task: 'Read the bounded fixture' }], caller: { conversationId: PRIME_CHAT } });
      const boot = await redeem();
      await request('POST', '/commands/ack', { body: { id: boot.id, status: 'sent', conversationId: worker, agent: 'worker-1' } });
      await request('POST', '/events', { body: { conversationId: worker, events: [
        { kind: 'user_message', time: Date.now(), messageId: 'worker-opening', text: boot.text },
        { kind: 'user_message', time: Date.now() + 1, messageId: 'worker-followup', text: 'Now read another file' }
      ] } });
      expect((await request('GET', `/activity?conversationId=${worker}&since=999999`)).body.bootstrapMessageId).toBe('worker-opening');

      // The worker bootstrap is typed into the fresh chat by this app, so ChatGPT's composer escapes it exactly as it escapes a resume brief — measured from 2026-09-16. The opening row is still the bootstrap; refusing it here loses the boundary that keeps chat A's repair notices out of chat B's feed.
      const escapedWorker = '66666666-3333-2222-1111-000000000083';
      await noteChatOrigin(escapedWorker, { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'Read the bounded fixture' });
      await request('POST', '/events', { body: { conversationId: escapedWorker, events: [
        { kind: 'user_message', time: Date.now(), messageId: 'escaped-opening',
          text: boot.text.replace(/([_:#*[\]`])/g, '\\$1') }
      ] } });
      expect((await request('GET', `/activity?conversationId=${escapedWorker}&since=999999`)).body.bootstrapMessageId)
        .toBe('escaped-opening');

      const missing = '66666666-3333-2222-1111-000000000082';
      await noteChatOrigin(missing, { kind: 'worker', fromSessionId: null, agentId: 'worker-1', task: 'Read the bounded fixture' });
      await request('POST', '/events', { body: { conversationId: missing, events: [
        { kind: 'user_message', time: Date.now(), messageId: 'only-followup', text: 'Now read another file' }
      ] } });
      expect((await request('GET', `/activity?conversationId=${missing}`)).body.bootstrapMessageId).toBeNull();
    });

  it('projects only the current committed resume receipt through repeated compaction', async () => {
      await pair();
      const { upsertMessageEvent } = await import("../../../../../backend/domains/sessions/history/store.js");
      const { beginContinuationDestinationSendNow, dispatchContinuationDestinationSendNow, bindContinuationDestinationMessageNow } =
        await import("../../../../../backend/domains/sessions/continuity/continuation.js");
      const from = '77777777-3333-2222-1111-000000000081';
      const middle = '77777777-3333-2222-1111-000000000082';
      const to = '77777777-3333-2222-1111-000000000083';
      const session = await createSession({ conversationId: from, origin: { kind: 'desktop', fromSessionId: null, agentId: null, task: '' } });
      for (const [source, target, messageId] of [[from, middle, 'resume-one'], [middle, to, 'resume-two']]) {
        const token = await readyContinuation(session.id, 'Resume fixture', source!);
        await beginContinuationDestinationSendNow(token);
        await dispatchContinuationDestinationSendNow(token);
        expect(await bindContinuationDestinationMessageNow(token, target!, messageId!)).toBe(true);
        expect(await commitContinuation(token, target!)).toBe(true);
        const body = `[[NEURAFLOK-RESUME:${token}]]\n\nResume fixture`;
        await upsertMessageEvent(session.id, { source: 'extension', time: Date.now(), kind: 'user_message', messageId: messageId!,
          message: { text: body, chars: body.length, truncated: false } });
        expect((await request('GET', `/activity?conversationId=${target}&since=999999`)).body.bootstrapMessageId).toBe(messageId);
        expect((await request('GET', `/activity?conversationId=${source}`)).body.bootstrapMessageId).toBeNull();
      }
      expect((await request('GET', `/activity?conversationId=${middle}`)).body.bootstrapMessageId).toBeNull();
    });

  it('protects a resume destination before the browser opener can record a shadow session', async () => {
      await pair();
      const from = '91919191-1111-2222-3333-444444444444';
      const destination = '92929292-1111-2222-3333-444444444444';
      const { sessionId, token: continuation } = await compactedSession(from, 'carry this session forward');
      let earlyObservation: Promise<{ sessionId: string | null; stored: number }> | null = null;

      // This is the live 2026-08-25 race: the replacement page can expose conversation B and flush an already-journalled observation before B has redeemed its continuation marker. Unless the bridge announces the pending replacement *before* opening the browser, the recorder eagerly creates a second local session for B. The later ACK then refuses the real A→B move with "the replacement chat already belongs to another local session".
      setBrowserOpener(async () => {
        earlyObservation = recordChatObservations(destination, [
          { kind: 'conversation_title', time: Date.now(), text: 'Resumed · carry this session forward' }
        ]);
      });

      const command = queueResume(sessionId, continuation)!;
      await vi.waitFor(() => expect(earlyObservation).not.toBeNull());

      const redeemed = await request('POST', '/commands/redeem', {
        body: { id: command.id, client: 'resume-tab-before-recorder' }
      });
      expect(redeemed.status).toBe(200);

      const ack = await request('POST', '/commands/ack', {
        body: {
          id: command.id,
          status: 'sent',
          conversationId: destination,
          client: 'resume-tab-before-recorder'
        }
      });
      expect(ack.status).toBe(200);
      expect(ack.body.committed).toBe(true);
      await expect(earlyObservation!).resolves.toMatchObject({ sessionId });
      expect((await getSession(sessionId))?.conversationId).toBe(destination);
    });

  /** Document ownership is replaceable up to the click and never past it. Holding the claim is not having sent: it is written before the composer is submitted at all, so a page that dies there left nothing behind and the next page may have the prompt. Arming is the opposite — the click comes first and its acceptance only seconds later — so from there on no page is offered this bootstrap again. */
    it('lets a reloaded page adopt a resume until one arms the click, and refuses every page afterwards', async () => {
      await pair();
      const { sessionId, token } = await compactedSession('99999999-8888-7777-6666-555555555555', 'the only brief');
      const command = queueResume(sessionId, token)!;

      expect((await redeem(command.id, 'tab-1')).text).toContain('the only brief');
      const second = await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-2' } });
      expect(second.status).toBe(200);

      const claimed = await request('POST', '/compact', { body: { token, commandId: command.id, client: 'tab-2', destinationAttempt: true } });
      expect(claimed.body.allowed).toBe(true);
      expect((await redeem(command.id, 'tab-3')).text).toContain('the only brief');

      const armed = await request('POST', '/compact', { body: { token, commandId: command.id, client: 'tab-3', destinationDispatch: true } });
      expect(armed.body.armed).toBe(true);
      expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-3' } })).status).toBe(409);
      expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-4' } })).status).toBe(409);
    });

  it('offers the brief to a fresh chat once the page proves it lost the draft before Send', async () => {
      // 2026-09-02: the replacement chat opened, the brief landed, and the user's Escape emptied the composer in the same instant. The ticket then sat armed for its six hours, the page journalled nothing typed into it, and the run could not move on.
      await pair();
      const { sessionId, token } = await compactedSession('99999999-8888-7777-6666-555555555556', 'the lost brief');
      const command = queueResume(sessionId, token)!;
      expect((await redeem(command.id, 'tab-1')).text).toContain('the lost brief');
      expect((await request('POST', '/compact', { body: { token, commandId: command.id, client: 'tab-1', destinationAttempt: true } })).body.allowed).toBe(true);
      expect((await request('POST', '/compact', { body: { token, commandId: command.id, client: 'tab-1', destinationDispatch: true } })).body.armed).toBe(true);
      expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-2' } })).status).toBe(409);

      const before = opened.length;
      const lost = await request('POST', '/compact', { body: { token, commandId: command.id, client: 'tab-1', destinationLost: true } });
      expect(lost.status).toBe(200);
      expect(lost.body.released).toBe(true);
      // The lease went with the page that lost the draft, and a fresh chat opens for the same brief at once instead of waiting out the quarter-hour lease.
      expect((await request('POST', '/commands/redeem', { body: { id: command.id, client: 'tab-1' } })).status).toBe(404);
      await vi.waitFor(() => expect(opened.length).toBeGreaterThan(before));
      const reopened = new URL(opened[opened.length - 1]!).searchParams.get('neuraflok-command')!;
      expect(reopened).not.toBe(command.id);
      expect((await redeem(reopened, 'tab-3')).text).toContain('the lost brief');
      expect((await request('POST', '/compact', { body: { token: 'ffffffffffffffffffffffffffffffff', destinationLost: true } })).status).toBe(409);
    });

  it('aborts a resume whose commit the session layer refused, so chat A is not left waiting on it', async () => {
      // 2026-09-01: the marked replacement message committed, the session layer refused the commit, and the 409 went back with the continuation still `claimed`. Nothing retries a claimed continuation, an automatic one never expires, and chat A's control reads its state off that record — so A sat behind "opening the new chat" and B, never bound, called tools as nobody. A refusal is final: the session stays in A and A is told.
      await pair();
      const chatA = 'a1a1a1a1-2222-4333-8444-555555555555';
      const chatB = 'b1b1b1b1-2222-4333-8444-555555555555';
      spawn({ workers: [{ task: 'keep a swarm bound to A' }], caller: { conversationId: chatA } });
      const { sessionId, token } = await compactedSession(chatA, 'the brief for the refused move');
      const command = queueResume(sessionId, token)!;
      expect((await redeem(command.id, 'tab-b')).text).toContain('the brief for the refused move');
      expect((await request('POST', '/compact', { body: { token, commandId: command.id, client: 'tab-b', destinationAttempt: true } })).body.allowed).toBe(true);
      expect((await request('POST', '/compact', { body: { token, commandId: command.id, client: 'tab-b', destinationDispatch: true } })).body.armed).toBe(true);
      // The handover is gone while the continuation is live: the swarm preflight will refuse.
      cancelPrimeTransfer(chatA);

      const reply = await request('POST', '/compact', {
        body: { conversationId: chatB, token, destinationMessageId: 'm-b-marked-resume' }
      });
      expect(reply.status).toBe(409);
      expect(reply.body.error).toBe('resume_commit_rejected');
      const diagnostics = getLog().filter(entry => entry.message.includes(`marked replacement ${chatB}`));
      expect(diagnostics.map(entry => entry.message)).toEqual([
        expect.stringContaining('commit rejected')
      ]);
      expect(continuationByToken(token)?.state).toBe('aborted');
      expect(continuationByToken(token)?.error).toMatch(/handover/);
      expect((await getSession(sessionId))?.conversationId).toBe(chatA);
      expect(pendingCommands().some((entry) => entry.id === command.id)).toBe(false);
    });

  it('says once that a settled marker names no continuation, however often that page reloads', async () => {
      // The marker stays in the replacement chat's transcript for good, so every later load of that page reads it again and names the same finished handoff. Measured 2026-09-19: 62 such lines across 8 chats in four days, 17 for a single chat, each saying the same thing about a continuation that had committed hours before. The 409 is the right answer every time; repeating the sentence is how a line that matters goes unread.
      await pair();
      const settled = 'd4d4d4d4-2222-4333-8444-555555555555';
      const token = 'AtokenNothingHoldsAnyMore';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reply = await request('POST', '/compact', {
          body: { conversationId: settled, token, destinationMessageId: `m-settled-${attempt}` }
        });
        expect(reply.status).toBe(409);
        expect(reply.body.error).toBe('no_such_continuation');
      }
      expect(
        getLog().filter((entry) => entry.message.includes(`marked replacement ${settled}`))
      ).toHaveLength(1);
    });

  it('arms the resumed chat the moment the session moves onto it', async () => {
      // 2026-09-02: chat B's first two calls each waited out the identity window as nobody's, and the unattributed incident had no suspect to reload because B had never reported a turn. From the commit on, B is expected to work: it is on the activity clock like any chat with an open turn, so the incident can reload it and silence can reload it once.
      await pair();
      const chatA = 'a2a2a2a2-2222-4333-8444-555555555555';
      const chatB = 'b2b2b2b2-2222-4333-8444-555555555555';
      const { sessionId, token } = await compactedSession(chatA, 'the brief for the armed move');
      const command = queueResume(sessionId, token)!;
      expect((await redeem(command.id, 'tab-b2')).text).toContain('the brief for the armed move');
      expect((await request('POST', '/compact', { body: { token, commandId: command.id, client: 'tab-b2', destinationAttempt: true } })).body.allowed).toBe(true);
      expect((await request('POST', '/compact', { body: { token, commandId: command.id, client: 'tab-b2', destinationDispatch: true } })).body.armed).toBe(true);
      const logged = new Set(getLog());

      const reply = await request('POST', '/compact', {
        body: { conversationId: chatB, token, destinationMessageId: 'm-b2-marked-resume' }
      });
      expect(reply.status).toBe(200);
      expect(reply.body.committed).toBe(true);
      expect((await getSession(sessionId))?.conversationId).toBe(chatB);
      expect(
        getLog()
          .filter(entry => !logged.has(entry))
          .some((entry) => entry.message.includes(`resumed chat ${chatB} armed`))
      ).toBe(true);
      expect((await request('GET', '/status')).body.recoveryMonitoring).toBe(true);

      // Idempotent re-reads of the marked message (a reloaded B) do not arm it a second time.
      const again = await request('POST', '/compact', {
        body: { conversationId: chatB, token, destinationMessageId: 'm-b2-marked-resume' }
      });
      expect(again.status).toBe(200);
      const diagnostics = getLog().filter(entry => entry.message.includes(`marked replacement ${chatB}`));
      expect(diagnostics.map(entry => entry.message)).toEqual([
        expect.stringContaining('committed')
      ]);
      expect(
        getLog()
          .filter(entry => !logged.has(entry))
          .filter((entry) => entry.message.includes(`resumed chat ${chatB} armed`))
      ).toHaveLength(1);
    });

  /** The name the fresh chat ends up with. The bootstrap this app types is the first thing said in the chat it opened, and the recorder's ordinary rule — name a session after the first thing said in it — turned that into the session's name. The installed build's list was a column of rows all called `Continue the previous ChatGPT ...`. The acknowledgement is the only moment at which the queued command and the conversation it became are both known, so this is where the name is settled. */
    it('names the chat it opened after the work, not after the bootstrap it typed', async () => {
      await pair();
      const source = await createSession({ title: 'Harden the MCP workflows' });
      const command = queueResume(source.id, await readyContinuation(source.id, 'carry on'))!;
      await redeem(command.id);
      const conversationId = 'cccccccc-dddd-eeee-ffff-000000000000';
      await request('POST', '/commands/ack', { body: { id: command.id, status: 'sent', conversationId } });

      const reply = await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            {
              kind: 'user_message',
              time: Date.now(),
              text: 'Continue the previous NEURAFLOK session. Read the handoff below.',
              messageId: 'boot-resume'
            }
          ]
        }
      });
      const summary = await getSession(reply.body.sessionId);
      expect(summary?.title).toBe('Resumed · Harden the MCP workflows');
      expect(summary?.origin).toEqual({ kind: 'resume', fromSessionId: source.id, agentId: null, task: '' });
    });

  it('names a worker chat after the agent and the task it was given', async () => {
      await pair();
      spawn({ workers: [{ task: 'Rewrite the recorder fixture' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = '12121212-3434-5656-7878-909090909090';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId }
      });

      const reply = await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            { kind: 'model_selection', time: Date.now(), model: 'gpt-5.6-sol', reasoningEffort: 'high' },
            {
              kind: 'user_message',
              time: Date.now(),
              text: 'Rewrite the recorder fixture',
              messageId: 'boot-worker'
            }
          ]
        }
      });
      expect((await getSession(reply.body.sessionId))?.title).toBe('worker-1 · Rewrite the recorder fixture');
      expect((await getSession(reply.body.sessionId))?.selectedModel).toMatchObject({ conversationId, model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    });

  it('rebuilds a worker origin from the durable broker binding if the recorder restarts before first observation', async () => {
      await pair();
      spawn({ workers: [{ task: 'Keep durable worker attribution' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const conversationId = 'abababab-3434-5656-7878-909090909090';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', conversationId }
      });

      // The ack retired its command after binding the worker, but the recorder had not created a session yet. Losing recorder memory here used to lose SessionOrigin permanently even though the swarm snapshot still held worker-1 + its task + this exact conversation.
      resetRecorderForTests();
      const reply = await request('POST', '/events', {
        body: {
          conversationId,
          events: [
            {
              kind: 'user_message',
              time: Date.now(),
              text: 'Keep durable worker attribution',
              messageId: 'boot-worker-after-recorder-restart'
            }
          ]
        }
      });
      const summary = await getSession(reply.body.sessionId);
      expect(summary?.origin).toEqual({
        kind: 'worker',
        fromSessionId: null,
        agentId: 'worker-1',
        task: 'Keep durable worker attribution'
      });
      expect(summary?.title).toBe('worker-1 · Keep durable worker attribution');
    });

  /** A bootstrap that never reached a tab has no chat to name. */
    it('does not name anything for a failed acknowledgement', async () => {
      await pair();
      const source = await createSession({ title: 'Never opened' });
      const command = queueResume(source.id, await readyContinuation(source.id, 'carry on'))!;
      await redeem(command.id);
      const conversationId = 'dddddddd-eeee-ffff-0000-111111111111';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'failed', error: 'tab died', conversationId }
      });

      const reply = await request('POST', '/events', {
        body: {
          conversationId,
          events: [{ kind: 'user_message', time: Date.now(), text: 'a chat the user started', messageId: 'm-own' }]
        }
      });
      const summary = await getSession(reply.body.sessionId);
      expect(summary?.title).toBe('a chat the user started');
      expect(summary?.origin).toBeNull();
    });

  /** One command is one delivery, and a page that gives up ends it. There is no retry budget, nothing sweeping the queue behind this, and no status a page can send to buy itself more time — `working` existed for exactly that and went with the ticker that sent it. A bootstrap that fails fails now, and takes its continuation down with it, so the session is left in the chat it is already in and the user can see that and press the button again. */
    it('ends a failed bootstrap instead of retrying it, and has no way to postpone one', async () => {
      await pair();
      const { sessionId, token } = await compactedSession('22222222-3333-4444-5555-666666666666', 'carry on');
      const command = queueResume(sessionId, token)!;
      await redeem(command.id);

      await request('POST', '/commands/ack', { body: {
        id: command.id,
        status: 'failed',
        error: 'tab died'
      } });
      // Gone from the queue, and gone as a transaction: nothing is coming for this session.
      expect(pendingCommands()).toEqual([]);
      expect(continuationByToken(token)?.state).toBe('aborted');
      // A second press is a second command — the user's decision, not the app's timer.
      const { sessionId: againId, token: againToken } = await compactedSession(
        '33333333-4444-5555-6666-777777777777',
        'carry on'
      );
      const second = queueResume(againId, againToken)!;
      expect(pendingCommands()).toHaveLength(1);

      // An unknown legacy status is treated as the old "sent" shape. Without a conversation id that is retryable, never a 2xx false-success that would retire the only transport.
      const nonsense = await request('POST', '/commands/ack', { body: { id: second.id, status: 'working' } });
      expect(nonsense.status).toBe(503);
      expect(nonsense.body).toMatchObject({ error: 'conversation_required', retryable: true });
      expect(pendingCommands()).toHaveLength(1);
      expect(continuationByToken(againToken)?.state).not.toBe('aborted');
    });
});
