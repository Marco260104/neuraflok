import { randomUUID } from "node:crypto";
import { abortContinuation, attachSummary, beforeEach, bindConversation, claimContinuationNow, commitContinuation, createSession, defaultConfig, describe, expect, faultGate, finishAgent, getConfig, getLog, GOAL_REPLIES_STATE, goalObjectiveFor, goalPendingReplyFor, it, openContinuationNow, pair, PRIME_CHAT, readDurable, recordChatObservations, recordFinalForTest, recordToolCall, redeem, repairPrimeConversationAfterRecovery, request, resetGoalStateForTests, resumeBootstrapText, SAMPLE_BRIEF, saveConfig, sessionControlsFor, setContinuationRecoveryHooks, setGoalObjective, setSecret, snapshotSwarm, spawn, sweepStaleSwarm, vi } from "../../test-context.js";

describe("the goal loop over the bridge: decisions and replies", () => {
  beforeEach(async () => {
      await saveConfig({
        ...defaultConfig(),
        sessions: { ...defaultConfig().sessions, record: true },
        goal: { ...defaultConfig().goal, backend: 'api', enabled: true, model: 'deepseek/deepseek-v4-flash', reasoning: 'default' }
      });
      await setSecret('openRouterApiKey', 'sk-or-bridge');
      resetGoalStateForTests();
    });

  /** A chat's own workers report back into that same chat, so its next automatic Goal step must not be decided from a context that is about to change. One rule decides that, in the module that owns worker state; the pickup tree asks it by deferring the reload rather than spending it, and both surfaces describe the same wait. Off, everything below is exactly what it was. */
    it.each([true, false] as const)('waits for this chat’s own workers only when the setting asks (waitForSubAgents=%s)', async waiting => {
      vi.useFakeTimers();
      try {
        await pair();
        const chat = 'cafe0093-0000-4000-8000-000000000093';
        const workerChat = 'cafe0094-0000-4000-8000-000000000094';
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'goal' },
          multiAgent: { ...previous.multiAgent, enabled: true, waitForSubAgents: waiting, recoverAgentTabs: false } });
        const recorded = await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-wait-user' },
          { kind: 'turn_start', time: Date.now(), turnId: 'g-wait' },
          { kind: 'turn_end', time: Date.now(), turnId: 'g-wait', outcome: 'completed' },
          { kind: 'assistant_message', time: Date.now(), turnId: 'g-wait', messageId: 'a-wait', text: 'First half done.',
            state: 'final', final: true, goalEligible: true, activeNow: true }
        ] } });
        const sessionId = recorded.body.sessionId as string;
        expect(goalPendingReplyFor(chat)).not.toBeNull();
        spawn({ workers: [{ task: 'carry the second half of this chat’s work' }], caller: { conversationId: chat } });
        expect(bindConversation('worker-1', workerChat)).toBe(true);

        const held = { reason: 'workers' }, settling = { reason: 'settling' };
        expect((await sessionControlsFor(sessionId)).goalWait).toEqual(waiting ? held : settling);
        expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.wait)
          .toEqual(waiting ? held : settling);

        // A wait is a delay, never a spent step: the debt is untouched, so the sweep after the last worker stops still finds it owed with the whole backoff ahead of it.
        await vi.advanceTimersByTimeAsync(120_001);
        await sweepStaleSwarm(Date.now());
        const firstSweep = ((await request('GET', '/status')).body.repairs ?? []).filter((row: any) => row.conversationId === chat);
        expect(firstSweep).toEqual(waiting ? [] : [expect.objectContaining({ conversationId: chat, reason: 'goal' })]);

        finishAgent({ conversationId: workerChat }, 'second half done');
        expect((await sessionControlsFor(sessionId)).goalWait).not.toEqual(held);
        await vi.advanceTimersByTimeAsync(120_001);
        await sweepStaleSwarm(Date.now());
        expect((await request('GET', '/status')).body.repairs ?? [])
          .toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: chat, reason: 'goal' })]));
      } finally { vi.useRealTimers(); }
    });

  it('never lets another chat’s sub-agents hold this one', async () => {
      vi.useFakeTimers();
      try {
        await pair();
        const chat = 'cafe0095-0000-4000-8000-000000000095';
        const stranger = 'cafe0096-0000-4000-8000-000000000096';
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'goal' },
          multiAgent: { ...previous.multiAgent, enabled: true, waitForSubAgents: true, recoverAgentTabs: false } });
        const recorded = await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'keep going', messageId: 'm-stranger-user' },
          { kind: 'turn_start', time: Date.now(), turnId: 'g-stranger' },
          { kind: 'turn_end', time: Date.now(), turnId: 'g-stranger', outcome: 'completed' },
          { kind: 'assistant_message', time: Date.now(), turnId: 'g-stranger', messageId: 'a-stranger', text: 'First half done.',
            state: 'final', final: true, goalEligible: true, activeNow: true }
        ] } });
        const sessionId = recorded.body.sessionId as string;
        spawn({ workers: [{ task: 'belongs to somebody else entirely' }], caller: { conversationId: stranger } });
        expect(bindConversation('worker-1', 'cafe0097-0000-4000-8000-000000000097')).toBe(true);

        expect((await sessionControlsFor(sessionId)).goalWait).toEqual({ reason: 'settling' });
        await vi.advanceTimersByTimeAsync(120_001);
        await sweepStaleSwarm(Date.now());
        expect((await request('GET', '/status')).body.repairs ?? [])
          .toEqual(expect.arrayContaining([expect.objectContaining({ conversationId: chat, reason: 'goal' })]));
      } finally { vi.useRealTimers(); }
    });

  it('advertises the configured Loop helper rather than the inactive API model', async () => {
      await pair();
      const config = defaultConfig();
      const conversation = 'cafe0081-0000-4000-8000-000000000081';
      await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', backend: 'api',
        loopBackend: 'web', model: 'z-ai/glm-5.3-flash' } });
      expect((await request('GET', `/activity?conversationId=${conversation}`)).body.goal)
        .toMatchObject({ backend: 'web', model: 'DeepSeek', mode: 'loop' });
      expect((await request('GET', '/settings')).body.goal)
        .toMatchObject({ backend: 'web', model: 'DeepSeek' });
      await saveConfig({ ...config, goal: { ...config.goal, enabled: true, mode: 'loop', loopBackend: 'api',
        model: 'local-model' }, providers: { api: { kind: 'custom', baseUrl: 'http://localhost:11434/v1' } } });
      expect((await request('GET', `/activity?conversationId=${conversation}`)).body.goal)
        .toMatchObject({ backend: 'api', provider: 'custom', model: 'local-model' });
    });

  it('retires a handoff source from Goal and Loop, including the app watchdog', async () => {
      vi.useFakeTimers();
      try {
        await pair();
        const from = 'cafe0091-0000-4000-8000-000000000091';
        const to = 'cafe0092-0000-4000-8000-000000000092';
        const recorded = await request('POST', '/events', {
          body: {
            conversationId: from,
            events: [
              { kind: 'user_message', time: Date.now(), text: 'continue until done', messageId: 'm-retired-goal' },
              { kind: 'turn_start', time: Date.now(), turnId: 'g-retired-goal' },
              { kind: 'turn_end', time: Date.now(), turnId: 'g-retired-goal', outcome: 'completed' },
              {
                kind: 'assistant_message',
                time: Date.now(),
                messageId: 'a-retired-goal',
                text: 'Ready to continue.',
                state: 'final',
                final: true,
                goalEligible: true,
                activeNow: true
              }
            ]
          }
        });
        const sessionId = recorded.body.sessionId as string;
        const continuation = await openContinuationNow(sessionId, from);
        expect(await attachSummary(continuation.token, SAMPLE_BRIEF)).not.toBeNull();
        await claimContinuationNow(continuation.token, 'retired-goal-test');
        expect(await commitContinuation(continuation.token, to)).toBe(true);

        const oldFeed = await request('GET', `/activity?conversationId=${from}`);
        expect(oldFeed.body.goal).toMatchObject({ enabled: false, own: true, blocked: 'continued', pending: null });
        expect((await request('POST', '/goal/draft', {
          body: { conversationId: from, turnId: 'g-retired-goal', terminalRequired: true, clientId: 'old-page' }
        })).body.error).toBe('conversation_superseded');
        expect((await request('POST', '/settings', {
          body: { conversationId: from, loop: true }
        })).body.error).toBe('conversation_superseded');

        await vi.advanceTimersByTimeAsync(40 * 60_000);
        await sweepStaleSwarm(Date.now());
        expect((await request('GET', '/status')).body.repairs).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

  it('repairs Goal onto the exact pre-fix resume-shadow chat and can draft there', async () => {
      await pair();
      const from = 'cafe0031-0000-4000-8000-000000000031';
      const to = 'cafe0032-0000-4000-8000-000000000032';
      const source = await createSession({ title: 'prime before resume-shadow collision', conversationId: from });
      spawn({ workers: [{ task: 'keep one worker alive across the broken resume' }], caller: { conversationId: from } });
      setGoalObjective(from, 'finish the release from the resumed prime chat');

      const openedContinuation = await openContinuationNow(source.id, from);
      const handoff = await attachSummary(openedContinuation.token, SAMPLE_BRIEF);
      expect(handoff).not.toBeNull();
      await claimContinuationNow(openedContinuation.token, 'resume-shadow-owner');
      const shadow = await createSession({
        title: 'Resumed · prime before resume-shadow collision',
        conversationId: to,
        origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
      });
      await recordChatObservations(to, [
        {
          kind: 'user_message',
          time: Date.now(),
          text: resumeBootstrapText(handoff!.text).replace('previous chat', `previous\u00c2\u00a0chat`),
          messageId: 'm-shadow-resume'
        },
        {
          kind: 'assistant_message',
          time: Date.now() + 1,
          text: 'The release is still unfinished.',
          messageId: 'a-shadow-resume',
          state: 'final',
          final: true
        }
      ]);
      expect(await commitContinuation(openedContinuation.token, to)).toBe(false);
      abortContinuation(openedContinuation.token, 'the replacement chat already belongs to another local session');
      expect(goalObjectiveFor(from)).toBe('finish the release from the resumed prime chat');
      expect(goalObjectiveFor(to)).toBe('');

      setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

      // `/activity` must not turn a plausible-looking resume origin into takeover authority. The exact bootstrap is the second half of the proof and this chat deliberately does not have it.
      const unrelated = 'cafe0033-0000-4000-8000-000000000033';
      await createSession({
        title: 'resume-looking but unrelated',
        conversationId: unrelated,
        origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
      });
      await recordChatObservations(unrelated, [
        { kind: 'user_message', time: Date.now(), text: 'a different bootstrap', messageId: 'm-unrelated-shadow' }
      ]);
      const unrelatedFeed = await request('GET', `/activity?conversationId=${unrelated}`);
      expect(unrelatedFeed.status).toBe(200);
      expect(unrelatedFeed.body.goal.objective).toBe('');
      expect(goalObjectiveFor(from)).toBe('finish the release from the resumed prime chat');
      expect(goalObjectiveFor(unrelated)).toBe('');

      // No agents/tool call performs the repair. The Goal activity poll itself must heal A→B.
      const feed = await request('GET', `/activity?conversationId=${to}`);
      expect(feed.status).toBe(200);
      expect(feed.body.sessionId).toBe(shadow.id);
      expect(feed.body.goal).toMatchObject({ enabled: true, objective: 'finish the release from the resumed prime chat' });
      expect(goalObjectiveFor(from)).toBe('');
      expect(goalObjectiveFor(to)).toBe('finish the release from the resumed prime chat');

      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        calls++;
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'keep going from B' }) } }]
        });
      }) as never;
      try {
        await recordFinalForTest(to, 'g-shadow-repaired');
        const drafted = await request('POST', '/goal/draft', {
          body: { conversationId: to, turnId: 'g-shadow-repaired', clientId: 'shadow-goal-tab' }
        });
        expect(drafted.status).toBe(200);
        expect(drafted.body.sessionId).toBe(shadow.id);
        expect(drafted.body.goal.turnId).toBe('g-shadow-repaired');
        await vi.waitFor(() => expect(calls).toBe(1));
      } finally {
        globalThis.fetch = realFetch;
      }
    });

  it('does not report the same no-Goal resume-shadow repair on every activity poll', async () => {
      await pair();
      const from = 'cafe0041-0000-4000-8000-000000000041';
      const to = 'cafe0042-0000-4000-8000-000000000042';
      const source = await createSession({ title: 'prime before no-goal resume-shadow collision', conversationId: from });
      spawn({ workers: [{ task: 'keep reusable ownership across the broken resume' }], caller: { conversationId: from } });

      const openedContinuation = await openContinuationNow(source.id, from);
      const handoff = await attachSummary(openedContinuation.token, SAMPLE_BRIEF);
      expect(handoff).not.toBeNull();
      await claimContinuationNow(openedContinuation.token, 'no-goal-shadow-owner');
      await createSession({
        title: 'Resumed · prime before no-goal resume-shadow collision',
        conversationId: to,
        origin: { kind: 'resume', fromSessionId: source.id, agentId: null, task: '' }
      });
      await recordChatObservations(to, [
        {
          kind: 'user_message',
          time: Date.now(),
          text: resumeBootstrapText(handoff!.text),
          messageId: 'm-no-goal-shadow-resume'
        }
      ]);
      expect(await commitContinuation(openedContinuation.token, to)).toBe(false);
      abortContinuation(openedContinuation.token, 'the replacement chat already belongs to another local session');
      setContinuationRecoveryHooks({ repairPrimeTransfer: repairPrimeConversationAfterRecovery });

      const repairWarnings = (): number =>
        getLog().filter(
          (entry) =>
            entry.level === 'warn' &&
            entry.message.includes('resume-shadow repair (') &&
            entry.message.endsWith(`moved missing projections into chat ${to}`)
        ).length;
      const warningsBefore = repairWarnings();

      const first = await request('GET', `/activity?conversationId=${to}`);
      expect(first.status).toBe(200);
      expect(snapshotSwarm()?.primeConversationId).toBe(to);
      expect(first.body.goal.objective).toBe('');
      expect(repairWarnings()).toBe(warningsBefore + 1);

      const second = await request('GET', `/activity?conversationId=${to}`);
      expect(second.status).toBe(200);
      expect(second.body.goal.objective).toBe('');
      expect(repairWarnings()).toBe(warningsBefore + 1);
    });

  /** The page needs to know three things, and it gets them on the feed it already polls. */
    it('reports the settings on the activity feed', async () => {
      await pair();
      await request('POST', '/events', {
        body: {
          conversationId: 'cafe0001-0000-4000-8000-000000000001',
          events: [{ kind: 'user_message', time: Date.now(), text: 'do the work', messageId: 'm-goal-1' }]
        }
      });

      const reply = await request('GET', '/activity?conversationId=cafe0001-0000-4000-8000-000000000001');
      expect(reply.status).toBe(200);
      expect(reply.body.goal).toMatchObject({
        enabled: true,
        hasKey: true,
        model: 'deepseek/deepseek-v4-flash',
        draft: null
      });
    });

  it('makes an accepted Goal turn durable before the provider can fail or the page can reload', async () => {
      await pair();
      const chat = 'cafe0050-0000-4000-8000-000000000050';
      const turnId = 'g-provider-failed-before-reload';
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [{ kind: 'user_message', time: Date.now(), text: 'continue until done', messageId: 'm-durable-goal' }]
        }
      });
      await recordFinalForTest(chat, turnId);

      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => Response.json(
        { error: { message: 'Provider returned error' } },
        { status: 429 }
      )) as never;
      try {
        const started = await request('POST', '/goal/draft', {
          body: { conversationId: chat, turnId, clientId: 'page-before-reload' }
        });
        expect(started.status).toBe(200);
        await vi.waitFor(async () => {
          const draft = (await request('GET', `/activity?conversationId=${chat}&goalClient=page-before-reload`)).body.goal.draft;
          expect(draft).toMatchObject({ stage: 'failed', turnId, retryable: true });
        });

        const failed = (await request('GET', `/activity?conversationId=${chat}&goalClient=page-before-reload`)).body.goal;
        expect(failed.pending).toEqual({
          replyId: `turn:${turnId}`,
          turnId,
          eventSeq: 0,
          acceptedAt: expect.any(Number)
        });
        expect((await request('POST', '/goal/ack', {
          body: { conversationId: chat, token: failed.draft.token, clientId: 'page-before-reload' }
        })).body.acknowledged).toBe(true);

        // A failed attempt is not an answer. Once its transient payload is acknowledged, a replacement document still receives the durable obligation and can ask again.
        const afterReload = (await request('GET', `/activity?conversationId=${chat}&goalClient=page-after-reload`)).body.goal;
        expect(afterReload.draft).toBeNull();
        expect(afterReload.pending).toEqual({
          replyId: `turn:${turnId}`,
          turnId,
          eventSeq: 0,
          acceptedAt: expect.any(Number)
        });
      } finally {
        globalThis.fetch = realFetch;
      }
    });

  it('turns a post-reload stable final answer into one durable Goal model call', async () => {
      await pair();
      const chat = 'cafe0051-0000-4000-8000-000000000051';
      await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [
            { kind: 'user_message', time: Date.now(), text: 'finish the release', messageId: 'm-reload-goal' },
            { kind: 'turn_start', time: Date.now(), turnId: 'g-before-page-reload' },
            { kind: 'turn_end', time: Date.now(), turnId: 'g-before-page-reload', outcome: 'unknown' }
          ]
        }
      });

      const replyId = 'assistant-final-seen-after-reload';
      const terminal = await request('POST', '/events', {
        body: {
          conversationId: chat,
          events: [{
            kind: 'assistant_message',
            time: Date.now(),
            messageId: replyId,
            text: 'The requested release work is complete.',
            state: 'final',
            final: true
          }]
        }
      });
      expect(terminal.status).toBe(200);

      const pending = (await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending;
      expect(pending).toEqual({
        replyId,
        turnId: `reply:${replyId}`,
        eventSeq: expect.any(Number),
        acceptedAt: expect.any(Number)
      });

      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        calls++;
        return Response.json({
          choices: [{ message: { content: JSON.stringify({ action: 'stop', reply: '' }) } }]
        });
      }) as never;
      try {
        const drafted = await request('POST', '/goal/draft', {
          body: {
            conversationId: chat,
            turnId: pending.turnId,
            terminalRequired: true,
            clientId: 'reloaded-goal-page'
          }
        });
        expect(drafted.status).toBe(200);
        await vi.waitFor(() => expect(calls).toBe(1));
        const decided = (await request('GET', `/activity?conversationId=${chat}&goalClient=reloaded-goal-page`)).body.goal.draft;
        expect(decided).toMatchObject({ stage: 'no-reply', turnId: pending.turnId });
        expect((await request('POST', '/goal/ack', {
          body: { conversationId: chat, token: decided.token, clientId: 'reloaded-goal-page' }
        })).body.acknowledged).toBe(true);

        // At-least-once page delivery of the same stable reply cannot mint another obligation.
        expect((await request('POST', '/events', {
          body: {
            conversationId: chat,
            events: [{
              kind: 'assistant_message',
              time: Date.now(),
              messageId: replyId,
              text: 'The requested release work is complete.',
              state: 'final',
              final: true
            }]
          }
        })).status).toBe(200);
        expect((await request('GET', `/activity?conversationId=${chat}`)).body.goal.pending).toBeNull();
        expect(calls).toBe(1);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

  /** Checked here as well as in the page, because the page's copy of the setting is a poll old and this is the request that spends money. */
    /** The switch is the prime's, not the run's. A spawned worker already has an author for its user turns — the prime, through the agents tool — and the brief it was handed is the whole of its objective. A second model typing into it as well is two hands on one wheel: the worker answers a question its prime never asked and finishes against that instead. And with the loop armed run-wide, every worker would be spending OpenRouter credit in parallel on drafts the prime is about to override. So the worker is off whatever the global setting says, and a chat that is no part of the run is untouched. */
    it('leaves the loop on for the prime and off for every worker it spawns', async () => {
      await pair();
      spawn({ workers: [{ task: 'Audit the settings sheet' }], caller: { conversationId: PRIME_CHAT } });
      const command = await redeem();
      const worker = 'cafe0011-0000-4000-8000-000000000011';
      await request('POST', '/commands/ack', {
        body: { id: command.id, status: 'sent', agent: 'worker-1', conversationId: worker }
      });

      const solo = 'cafe0012-0000-4000-8000-000000000012';
      for (const conversationId of [worker, solo]) {
        await request('POST', '/events', {
          body: {
            conversationId,
            events: [{ kind: 'user_message', time: Date.now(), text: 'go', messageId: `m-${conversationId}` }]
          }
        });
      }

      // The feed is what arms the loop in the page, so the refusal has to be visible there rather than only at the moment the draft would be paid for.
      expect((await request('GET', `/activity?conversationId=${worker}`)).body.goal.enabled).toBe(false);
      // A chat that belongs to no agent in the run is an ordinary chat and keeps the loop.
      expect((await request('GET', `/activity?conversationId=${solo}`)).body.goal.enabled).toBe(true);

      // And the route refuses independently, because the page's copy is always a poll old.
      const drafted = await request('POST', '/goal/draft', { body: { conversationId: worker, turnId: 'g-worker' } });
      expect(drafted.status).toBe(409);
      expect(drafted.body.error).toBe('goal_disabled');

      // The setting itself is untouched: this is a rule about who may spend it, not a write.
      expect(getConfig().goal.enabled).toBe(true);
    });

  it('refuses to draft when the loop is off or has no key', async () => {
      await pair();
      await request('POST', '/events', {
        body: {
          conversationId: 'cafe0002-0000-4000-8000-000000000002',
          events: [{ kind: 'user_message', time: Date.now(), text: 'go', messageId: 'm-goal-2' }]
        }
      });

      await saveConfig({
        ...defaultConfig(),
        sessions: { ...defaultConfig().sessions, record: true },
        goal: { ...defaultConfig().goal, backend: 'api', enabled: false }
      });
      const off = await request('POST', '/goal/draft', { body: { conversationId: 'cafe0002-0000-4000-8000-000000000002', turnId: 'g-1' } });
      expect(off.status).toBe(409);
      expect(off.body.error).toBe('goal_disabled');

      await saveConfig({
        ...defaultConfig(),
        sessions: { ...defaultConfig().sessions, record: true },
        goal: { ...defaultConfig().goal, backend: 'api', enabled: true }
      });
      await setSecret('openRouterApiKey', '');
      const keyless = await request('POST', '/goal/draft', { body: { conversationId: 'cafe0002-0000-4000-8000-000000000002', turnId: 'g-1' } });
      expect(keyless.status).toBe(409);
      expect(keyless.body.error).toBe('no_api_key');
    });

  /** A generation is the draft's identity, so it has to be given one. */
    it('refuses a draft with no generation to answer', async () => {
      await pair();
      const reply = await request('POST', '/goal/draft', { body: { conversationId: 'cafe0001-0000-4000-8000-000000000001' } });
      expect(reply.status).toBe(400);
      expect(reply.body.error).toBe('bad_turn_id');
    });

  /** Nothing to continue from is not the same as a failure to continue. */
    it('refuses a chat this app has never recorded', async () => {
      await pair();
      const reply = await request('POST', '/goal/draft', {
        body: { conversationId: 'cafe0004-0000-4000-8000-000000000004', turnId: 'g-1' }
      });
      expect(reply.status).toBe(409);
      expect(reply.body.error).toBe('session_not_recorded');
    });

  it('finds an older recorded chat through the durable ownership index, not the capped UI list', async () => {
      await pair();
      await saveConfig({
        ...defaultConfig(),
        sessions: { ...defaultConfig().sessions, record: true },
        goal: { ...defaultConfig().goal, backend: 'api', enabled: true }
      });
      await setSecret('openRouterApiKey', 'sk-or-test');
      const conversationId = 'cafe0099-0000-4000-8000-000000000099';
      await createSession({ title: 'older but still owned', conversationId });
      for (let index = 0; index < 65; index++) {
        await createSession({ title: `newer session ${index}`, conversationId: null });
      }

      await recordFinalForTest(conversationId, 'g-old-recording');
      const reply = await request('POST', '/goal/draft', {
        body: { conversationId, turnId: 'g-old-recording' }
      });
      expect(reply.status).toBe(200);
      expect(reply.body.error).not.toBe('session_not_recorded');
    });

  /** The whole round trip: the draft starts, the structured answer arrives, the page acknowledges it once, and the next poll no longer offers a message to type. */
    it.each(['goal', 'loop'] as const)('settles a final still labelled generating once for %s with the shared busy wait', async mode => {
      await pair();
      const chat = randomUUID();
      const goal = await import("../../../../backend/domains/automation/goal.js");
      await goal.setGoalSwitchNow(chat, mode, true);
      await request('POST', '/events', { body: { conversationId: chat, events: [
        { kind: 'model_selection', time: Date.now(), model: 'gpt-5.6-sol', reasoningEffort: 'high' },
        { kind: 'user_message', time: Date.now(), text: 'Finish this task', messageId: 'busy-final-user' }
      ] } });
      const body = { conversationId: chat, turnId: 'busy-final', clientId: 'owner', nativeBusy: true };
      expect((await request('POST', '/goal/draft', { body })).body.error).toBe('goal_final_not_confirmed');
      await request('POST', '/events', { body: { conversationId: chat, events: [
        { kind: 'turn_start', time: Date.now(), turnId: 'busy-final' }
      ] } });
      const requestId = `busy-final-${mode}`;
      await request('POST', '/events', { body: { conversationId: chat, events: [
        { kind: 'tool_evidence', time: Date.now(), calls: [{ messageId: 'busy-read', tool: 'read', order: 0, answered: false, requestId }] }
      ] } });
      await recordToolCall({ tool: 'read', args: {}, content: [], outcome: 'ok', durationMs: 1,
        startedAt: Date.now(), requestId });
      await request('POST', '/events', { body: { conversationId: chat, events: [
        { kind: 'assistant_message', time: Date.now(), turnId: 'busy-final', messageId: 'final-busy-final',
          text: 'Finished.', state: 'final', final: true, goalEligible: true, activeNow: true }
      ] } });
      const first = await request('POST', '/goal/draft', { body });
      expect(first.body.recovery, JSON.stringify(first.body)).toMatchObject({ stop: false });
      const deadline = first.body.recovery.listenUntil;
      expect(deadline - Date.now()).toBeGreaterThan(59_000);
      expect(goal.goalViewFor(chat)).toBeNull(); // No decision generation during preparation.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline);
      try {
        expect((await request('POST', '/goal/draft', { body })).body.recovery.stop).toBe(true);
        const saved = await readDurable<import("../../../../backend/domains/automation/goal.js").GoalRepliesSnapshot>(GOAL_REPLIES_STATE);
        expect(saved?.replies.find(row => row.conversationId === chat)?.recoveryStopClaimed).toBe(true);
        goal.restoreGoalReplies(saved);
        expect((await request('POST', '/goal/draft', { body: { ...body, clientId: 'other-document' } })).body.recovery.stop).toBe(false);
        await request('POST', '/events', { body: { conversationId: chat, events: [
          { kind: 'user_message', time: Date.now(), text: 'New work', messageId: 'new-busy-final-user' }
        ] } });
        expect((await request('POST', '/goal/draft', { body })).body.error).toBe('goal_final_not_confirmed');
      } finally { clock.mockRestore(); }
    });

  it.each(['normal', 'pro'])('defers an exact ready continuation after renewed work without disabling %s Goal', async model => {
      await pair();
      const chat = 'cafe0094-0000-4000-8000-000000000094';
      const goal = await import("../../../../backend/domains/automation/goal.js");
      await request('POST', '/events', { body: { conversationId: chat, events: [
        { kind: 'model_selection', time: Date.now(), model: model === 'pro' ? 'gpt-5-pro' : 'GPT-5.6 Sol', reasoningEffort: model === 'pro' ? 'pro' : 'high' },
        { kind: 'user_message', time: Date.now(), text: 'Finish this task', messageId: 'busy-user' }
      ] } });
      await recordFinalForTest(chat, 'busy-source');
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'Run the checks' }) } }] })) as never;
      try {
        const started = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'busy-source', clientId: 'owner' } });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        await vi.waitFor(() => expect(goal.goalViewFor(chat)?.stage).toBe('ready'));
        const body = { conversationId: chat, token: started.body.goal.token, clientId: 'owner', nativeBusy: true };
        expect((await request('POST', '/goal/ack', { body: { ...body, clientId: 'other' } })).body.deferred).toBe(false);
        expect((await request('POST', '/goal/ack', { body: { ...body, token: 'wrong-token' } })).body.deferred).toBe(false);
        expect(goal.goalViewFor(chat)?.stage).toBe('ready');
        const before = Date.now();
        const response = await request('POST', '/goal/ack', { body });
        expect(response.body).toMatchObject({ acknowledged: false, deferred: true });
        const deadline = response.body.listenUntil;
        expect(deadline).toBeGreaterThanOrEqual(before + (model === 'pro' ? 300_000 : 60_000));
        expect(goal.goalViewFor(chat)).toBeNull();
        expect(goal.goalArmedFor(chat)).toBe(true);
        expect(goal.goalPendingReplyFor(chat)).toMatchObject({ turnId: 'busy-source', listenUntil: deadline });
        expect((await request('POST', '/goal/ack', { body })).body).toMatchObject({ acknowledged: false, deferred: false });
        expect(goal.goalPendingReplyFor(chat)?.listenUntil).toBe(deadline);
        const durable = await readDurable<import("../../../../backend/domains/automation/goal.js").GoalRepliesSnapshot>(GOAL_REPLIES_STATE);
        expect(durable?.replies.find(row => row.conversationId === chat)).toMatchObject({ state: 'pending', listenUntil: deadline });
        expect((await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'busy-source', clientId: 'owner' } })).body.error).toBe('chat_still_working');
        const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline);
        try {
          const restarted = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'busy-source', clientId: 'owner' } });
          expect(restarted.status, JSON.stringify(restarted.body)).toBe(200);
          expect(restarted.body.goal.token).not.toBe(body.token);
          await vi.waitFor(() => expect(goal.goalViewFor(chat)?.stage).toBe('ready'));
          expect((await request('POST', '/goal/ack', { body })).body.deferred).toBe(false);
          expect(goal.goalViewFor(chat)?.token).toBe(restarted.body.goal.token);
          expect(goal.goalPendingReplyFor(chat)?.listenUntil).toBe(deadline);
        } finally { clock.mockRestore(); }
      } finally { globalThis.fetch = realFetch; }
    });

  it('withholds a ready activity draft revoked while its authority read is paused', async () => {
      await pair();
      const chat = 'cafe0092-0000-4000-8000-000000000092';
      const goal = await import("../../../../backend/domains/automation/goal.js");
      await request('POST', '/events', { body: { conversationId: chat,
        events: [{ kind: 'user_message', time: Date.now(), text: 'Finish this task', messageId: 'race-user' }] } });
      await recordFinalForTest(chat, 'race-source');
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'continue', reply: 'Run the checks' }) } }] })) as never;
      const gate = faultGate();
      let restoreAuthority = () => {};
      try {
        expect((await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'race-source' } })).status).toBe(200);
        await vi.waitFor(() => expect(goal.goalViewFor(chat)?.stage).toBe('ready'));
        const authority = vi.spyOn(goal, 'loopReplyHasAuthority').mockImplementationOnce(async () => { await gate.hold(); return true; });
        restoreAuthority = () => authority.mockRestore();
        const pendingFeed = request('GET', `/activity?conversationId=${chat}`);
        await gate.entered;
        // The same immediate invalidation used by new MCP activity.
        await goal.setGoalReplyActiveNow(chat, false);
        expect(goal.goalViewFor(chat)).toBeNull();
        gate.release();
        const feed = await pendingFeed;
        expect(feed.body.pendingTools).toBe(0);
        expect(feed.body.goal.draft).toBeNull();
        expect(feed.body.goal.pending).toBeNull();
      } finally { gate.release(); restoreAuthority(); globalThis.fetch = realFetch; }
    });

  it('reports replaced continuation rather than missing MCP after an authority race', async () => {
      await pair();
      const chat = 'cafe0093-0000-4000-8000-000000000093';
      const goal = await import("../../../../backend/domains/automation/goal.js");
      await saveConfig({ ...getConfig(), goal: { ...getConfig().goal, mode: 'loop' } });
      await request('POST', '/events', { body: { conversationId: chat,
        events: [{ kind: 'user_message', time: Date.now(), text: 'Finish this task', messageId: 'race-user' }] } });
      await recordFinalForTest(chat, 'race-source');
      const gate = faultGate();
      const authority = vi.spyOn(goal, 'loopReplyHasAuthority').mockImplementationOnce(async () => { await gate.hold(); return false; });
      try {
        const pendingRequest = request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'race-source' } });
        await gate.entered;
        const saved = goal.snapshotGoalReplies();
        goal.restoreGoalReplies({ ...saved, replies: saved.replies.map(row => row.conversationId === chat
          ? { ...row, replyId: 'new-reply', turnId: 'new-turn', eventSeq: row.eventSeq + 1, state: 'pending', acceptedAt: row.acceptedAt + 1 } : row) });
        expect(goal.goalPendingReplyFor(chat)?.turnId).toBe('new-turn');
        gate.release();
        expect((await pendingRequest).body).toMatchObject({ error: 'goal_reply_not_pending', retryable: false });
      } finally { gate.release(); authority.mockRestore(); }
    });

  it('drafts once, hands the message over once, and forgets it on acknowledgement', async () => {
      await pair();
      await request('POST', '/events', {
        body: {
          conversationId: 'cafe0003-0000-4000-8000-000000000003',
          events: [{ kind: 'user_message', time: Date.now(), text: 'write the parser', messageId: 'm-goal-3' }]
        }
      });
      await recordFinalForTest('cafe0003-0000-4000-8000-000000000003', 'g-1');

      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        calls++;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ action: 'continue', reply: 'what about the tests' })
              }
            }
          ]
        });
      }) as never;

      try {
        const started = await request('POST', '/goal/draft', {
          body: { conversationId: 'cafe0003-0000-4000-8000-000000000003', turnId: 'g-1' }
        });
        expect(started.status).toBe(200);
        expect(started.body.goal.turnId).toBe('g-1');

        // A retried POST is the same draft, not a second message into somebody's chat.
        const again = await request('POST', '/goal/draft', {
          body: { conversationId: 'cafe0003-0000-4000-8000-000000000003', turnId: 'g-1' }
        });
        expect(again.body.goal.token).toBe(started.body.goal.token);

        let feed: any = null;
        for (let attempt = 0; attempt < 200; attempt++) {
          feed = await request('GET', '/activity?conversationId=cafe0003-0000-4000-8000-000000000003');
          if (feed.body.goal?.draft?.stage === 'ready') break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(calls).toBe(1);
        expect(feed.body.goal.draft.reply).toBe('what about the tests');

        const acked = await request('POST', '/goal/ack', {
          body: { conversationId: 'cafe0003-0000-4000-8000-000000000003', token: started.body.goal.token }
        });
        expect(acked.body.acknowledged).toBe(true);

        const after = await request('GET', '/activity?conversationId=cafe0003-0000-4000-8000-000000000003');
        expect(after.body.goal.draft).toBeNull();
      } finally {
        globalThis.fetch = realFetch;
      }
    });

  /** The composer's settings sheet writes through here, and it may write exactly two things. Everything else in this app's settings decides what ChatGPT can reach on this machine, and a route a web page can post to must never be able to widen that. */
    it('lets the page set the two switches it owns, and nothing else', async () => {
      await pair();
      const reply = await request('POST', '/settings', { body: { autoCompact: true, goal: false } });
      expect(reply.status).toBe(200);
      expect(getConfig().compaction.auto).toBe(true);
      expect(getConfig().goal.enabled).toBe(false);
      expect(reply.body.context.auto).toBe(true);
      expect(reply.body.goal).toMatchObject({ enabled: false, hasKey: true });

      const readOnly = getConfig().readOnly;
      const capabilities = { ...getConfig().capabilities };
      const rejected = await request('POST', '/settings', {
        body: { readOnly: false, capabilities: { command: true }, roots: [{ name: 'c', path: 'C:' }] }
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe('nothing_to_change');
      expect(getConfig().readOnly).toBe(readOnly);
      expect(getConfig().capabilities).toEqual(capabilities);
    });
});
