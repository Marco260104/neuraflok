import { beforeEach, CHAT_SILENCE_MS, describe, expect, finishAgent, getConfig, getSession, it, liveConversations, noteAgentContextTokens, pair, PRO_SILENCE_MS, recordFinalForTest, recordToolCall, redeem, request, saveConfig, setChatBlocked, spawn, STALE_SWARM_MS, swarmState, swarmStateForCaller, sweepStaleSwarm, vi, WORKER_CONTEXT_CEILING_TOKENS, WORKER_SILENCE_MS } from "../../../test-context.js";
import { attributed, chatOf, endTurn, events, maintenance, openTurn, reopened, unattributed } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: missing tabs and worker recovery", () => {
  beforeEach(resetRecoveryFixture);

  it.each([undefined, false, true])('recovers an owned mid-turn departure only without manual dismissal (manual=%s)', async manual => {
        const SOLO = 'b2b2b2b2-1111-2222-3333-444444444444';
        await pair();
        await events(SOLO, [openTurn('turn-solo-closed')]);
        // One proved call is what makes this chat the app's business at all.
        await attributed(SOLO);
    
        await request('POST', '/closed', { body: { conversationId: SOLO, manual } });
    
        // Nothing is waited out: the close itself is the evidence.
        expect(chatOf(await maintenance())).toBe(manual === true ? null : SOLO);
      });

  /** And the fence on it. A chat that has never called a tool is somebody reading a recipe with this app installed; its tab is not this app's to put back, and reopening it would be the connector helping itself to a window nobody asked it to keep. Its open turn stays on the ordinary silence clock like any other — this is about the close, not about the turn. */
      it('leaves a chat that has never called a tool closed when its tab goes', async () => {
        const BROWSING = 'b3b3b3b3-1111-2222-3333-444444444444';
        await pair();
        await events(BROWSING, [openTurn('turn-browsing')]);
    
        await request('POST', '/closed', { body: { conversationId: BROWSING } });
    
        expect(await maintenance()).toBeNull();
      });

  it('immediately reopens an active Goal chat without tool calls while ordinary recovery is off', async () => {
        const previous = getConfig();
        const driven = 'b4b4b4b4-1111-2222-3333-444444444444';
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true },
          multiAgent: { ...previous.multiAgent, recoverAgentTabs: false } });
        try {
          await pair();
          await events(driven, [openTurn('turn-goal-no-tools')]);
          await request('POST', '/closed', { body: { conversationId: driven } });
          expect(await maintenance()).toMatchObject({ conversationId: driven, reason: 'no-tab' });
        } finally { await saveConfig(previous); }
      });

  it('gives an ordinary solo chat the same one-shot stale-turn reload as Prime', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-solo-silent')]);
          await attributed(recoveryState.OTHER);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(chatOf(reload)).toBe(recoveryState.OTHER);
    
          // A receipt proves Chrome carried the reload out. With no new durable observation, the next sweep abandons this open turn instead of reloading it again forever.
          expect(await maintenance(reload!.token)).toBeNull();
          // The reload is the chat's chance; the verdict on it waits the same two minutes the silence did.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  it('opens an exact chat after calls continue while its Chrome tab is gone', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-closed-while-tools-run')]);
          await request('POST', '/closed', { body: { conversationId: recoveryState.OTHER } });
    
          // The model keeps running server-side after Chrome has gone. Exact attribution is the activity authority; absence of a browser-local activeTurnId must not discard it.
          await attributed(recoveryState.OTHER);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(chatOf(await maintenance())).toBe(recoveryState.OTHER);
        } finally {
          vi.useRealTimers();
        }
      });

  it('spends recovery immediately when an attributed worker finish report is recorded', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [openTurn('turn-explicit-finish')]);
          await attributed(recoveryState.OTHER);
          await attributed(recoveryState.OTHER, true);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  it('re-arms the same chat only after real post-reload activity starts a new episode', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-reload-episode-one')]);
          await attributed(recoveryState.OTHER);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const first = await maintenance();
          expect(chatOf(first)).toBe(recoveryState.OTHER);
          expect(await maintenance(first!.token)).toBeNull();
          await vi.advanceTimersByTimeAsync(60_000);
          await sweepStaleSwarm(Date.now());
    
          // A confirmed reload alone is spent. A new exact call is the sole fact that starts episode 2. Missing replacement-page model proof still uses the ordinary two-minute clock.
          await attributed(recoveryState.OTHER);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
    
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          expect(chatOf(await maintenance())).toBe(recoveryState.OTHER);
        } finally {
          vi.useRealTimers();
        }
      });

  it('treats a real interim assistant update after reload as a new active episode', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-reload-interim-one')]);
          await attributed(recoveryState.OTHER);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const first = await maintenance();
          expect(chatOf(first)).toBe(recoveryState.OTHER);
          expect(await maintenance(first!.token)).toBeNull();
          await sweepStaleSwarm(Date.now());
    
          await events(recoveryState.OTHER, [{
            kind: 'assistant_message',
            time: Date.now(),
            messageId: 'assistant-after-reload',
            text: 'Continuing after reload',
            state: 'streaming',
            final: false,
            activeNow: true
          }]);
          // The old grant was spent; this unowned interim carries no fresh model selection.
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(chatOf(await maintenance())).toBe(recoveryState.OTHER);
        } finally {
          vi.useRealTimers();
        }
      });

  it('moves the stale deadline on real assistant progress and removes it on a stable final answer', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [openTurn('turn-solo-progress')]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          await events(recoveryState.OTHER, [{
            kind: 'assistant_message',
            time: Date.now(),
            messageId: 'assistant-solo-progress',
            turnId: 'turn-solo-progress',
            text: 'Still working through it',
            state: 'streaming',
            final: false,
            activeNow: true
          }]);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
    
          await events(recoveryState.OTHER, [{
            kind: 'assistant_message',
            time: Date.now(),
            messageId: 'assistant-solo-final',
            turnId: 'turn-solo-progress',
            text: 'Finished.',
            state: 'final',
            final: true,
            activeNow: true
          }]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  /** A tool call is attributed after the final answer it belongs to is already stored. The recorder can spend up to REQUEST_ID_GRACE_MS proving one request id, so the page's stable assistant message can reach this app before the call inside that answer is filed. The call's own start time must remain before that final boundary, regardless of recorder latency, or a completed answer gets reopened two minutes after the user already had it. */
      it('never reloads a chat whose stable final arrived before its last call was attributed', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [openTurn('turn-solo-late-join')]);
          const finalAt = Date.now();
          await events(recoveryState.OTHER, [{
            kind: 'assistant_message',
            time: finalAt,
            messageId: 'assistant-solo-late-final',
            turnId: 'turn-solo-late-join',
            text: 'Complete.',
            state: 'final',
            final: true
          }]);
          await attributed(recoveryState.OTHER, false, finalAt);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS * 2);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  /** The reported Prime trace: the page detached mid-generation and durably ended the local lifecycle as unknown. The model kept making calls whose exact request ids still proved this chat. Those calls are first-hand activity, not a late join to a completed answer, so their final two-minute silence must still recover the page once. */
      it('reloads a chat that keeps making attributed calls after its local turn ended unknown', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-lost-on-reload')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await events(recoveryState.OTHER, [endTurn('turn-lost-on-reload', 'unknown')]);
          await attributed(recoveryState.OTHER);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(chatOf(await maintenance())).toBe(recoveryState.OTHER);
        } finally {
          vi.useRealTimers();
        }
      });

  it('does not reload an uncertain chat after its stable final answer arrives', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [openTurn('turn-final-after-reload')]);
          await events(recoveryState.OTHER, [endTurn('turn-final-after-reload', 'unknown')]);
          await attributed(recoveryState.OTHER);
          const finalAt = Date.now();
          await events(recoveryState.OTHER, [{
            kind: 'assistant_message',
            time: finalAt,
            messageId: 'assistant-final-after-reload',
            turnId: 'turn-final-after-reload',
            text: 'The complete answer is here.',
            state: 'final',
            final: true
          }]);
          // Correlation may settle after the page final, just as it can after a normal turn_end. That late exact call must not resurrect a completed answer's reload clock.
          await attributed(recoveryState.OTHER, false, finalAt);
    
          // Cross both policy windows; the old four-minute assertion could pass just because unknown recovery had not reached its ten-minute deadline.
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS * 2);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

  /** An unrelated unattributed incident used to cancel a confirmed stale-turn recovery. `repairCandidates()` pruned the activity ledger on its own clock, two minutes behind the deadline it prunes. A silence recovery that Chrome had already carried out could therefore lose the grant that says which chats to spend, and the verdict on that reload was never reached: the Worker slot stayed occupied by a chat this app had already given up on, and the repair sat in flight forever. The open turn, not a second clock, decides this now. */
      it('still spends a confirmed stale-turn reload after an unrelated unattributed incident', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-worker-pruned')]);
          await attributed(recoveryState.WORKER);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(chatOf(reload)).toBe(recoveryState.WORKER);
          expect(await maintenance(reload!.token)).toBeNull();
    
          // The incident's own minute lands well past the silence deadline, which is exactly when the old ledger prune fired. The reload above is still the outstanding verdict.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await unattributed();
          await vi.advanceTimersByTimeAsync(60_000);
    
          await sweepStaleSwarm(Date.now());
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'sleeping',
            revivable: true
          });
        } finally {
          vi.useRealTimers();
        }
      });

  it.each(['gpt-5-6-pro', 'gpt-6-pro'])('updates %s worker tokens and proven model from a call without another page event', async model => {
        await pair();
        spawn({ workers: [{ task: 'measure exact recorded context' }], caller: { conversationId: recoveryState.PRIME } });
        const bootstrap = await redeem();
        const workerChat = model === 'gpt-5-6-pro' ? 'b1111111-1111-4111-8111-111111111111' : 'b2222222-1111-4111-8111-111111111111';
        await request('POST', '/commands/ack', { body: { id: bootstrap.id, status: 'sent', conversationId: workerChat, agent: 'worker-1' } });
        const began = Date.now();
        await events(workerChat, [{ kind: 'model_selection', model, reasoningEffort: 'pro', time: began }, { kind: 'turn_start', time: began, turnId: 'meter-' + model }]);
        const sessionId = (await request('GET', `/activity?conversationId=${workerChat}`)).body.sessionId;
        const before = swarmState().agents.find(agent => agent.conversationId === workerChat)!.contextTokens;
        const call = await recordToolCall({ tool: 'read', args: { path: '/project/file' }, content: [{ type: 'text', text: 'recorded work '.repeat(100) }], outcome: 'ok', durationMs: 1, startedAt: began + 1, conversationId: workerChat, sessionId });
        expect(call).toMatchObject({ model, reasoningEffort: 'pro' });
        const summary = await getSession(sessionId);
        expect(summary!.contextTokens).toBeGreaterThan(before);
        expect(swarmState().agents.find(agent => agent.conversationId === workerChat)!.contextTokens).toBe(summary!.contextTokens);
        // A changed picker now describes the next selection, not the still-running model.
        await events(workerChat, [{ kind: 'model_selection', model: 'gpt-5-6-thinking', reasoningEffort: 'high', time: began + 2 }]);
        const afterSwitch = await recordToolCall({ tool: 'read', args: {}, content: [{ type: 'text', text: 'more work' }], outcome: 'ok', durationMs: 1, startedAt: began + 3, conversationId: workerChat, sessionId });
        expect(afterSwitch?.model).toBeUndefined();
      });

  it('reloads a silent joined turn once, then sleeps the Worker only if it stays dead', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-worker-silent')]);
          await attributed(recoveryState.WORKER);
          expect(getConfig().multiAgent.recoverAgentTabs).toBe(true);
          expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
          expect(liveConversations().find((entry) => entry.conversationId === recoveryState.WORKER)).toMatchObject({ generating: true });
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(chatOf(reload)).toBe(recoveryState.WORKER);
          expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('active');
    
          expect(await maintenance(reload!.token)).toBeNull();
          // The reload is the chat's chance; the verdict on it waits the same two minutes the silence did.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'sleeping',
            revivable: true
          });
        } finally {
          vi.useRealTimers();
        }
      });

  it('parks but does not terminalize an unresolved worker turn that crossed the context ceiling', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit at the ceiling' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-worker-ceiling')]);
          await attributed(recoveryState.WORKER);
          noteAgentContextTokens(recoveryState.WORKER, WORKER_CONTEXT_CEILING_TOKENS);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(chatOf(reload)).toBe(recoveryState.WORKER);
          expect(await maintenance(reload!.token)).toBeNull();
          // The reload is the chat's chance; the verdict on it waits the same two minutes the silence did.
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'sleeping',
            revivable: false,
            silenceRecoveryTurnId: 'turn-worker-ceiling'
          });
    
          // Freeing the worker slot must not make an unresolved server turn disposable. Five minutes later it is still neither a reusable chat nor a browser-tab close candidate.
          vi.setSystemTime(Date.now() + 300_001);
          const budget = (await request('GET', '/status')).body;
          expect(budget.reusableConversations).not.toContain(recoveryState.WORKER);
          expect(budget.closableConversations).not.toContain(recoveryState.WORKER);
    
          await recordFinalForTest(recoveryState.WORKER, 'turn-worker-ceiling');
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'finished',
            revivable: false,
            silenceRecoveryTurnId: null
          });
        } finally {
          vi.useRealTimers();
        }
      });

  it.each(['turn_end', 'canonical_final'] as const)(
        'does not reuse a prior turn outcome when newer exact tool work has no recorded turn start (%s)',
        async terminalEvidence => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'keep current unstarted response alive' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          const now = Date.now();
          await events(recoveryState.WORKER, [openTurn('turn-prior-completed'), endTurn('turn-prior-completed', 'completed')]);
          // The next server response is observable only through its exact MCP request. No new turn_start arrived, so activeTurnId remains null while lastTurnOutcome is still the prior completed turn. That stale outcome must not become terminal authority for this work.
          await attributed(recoveryState.WORKER, false, now + 1);
          noteAgentContextTokens(recoveryState.WORKER, WORKER_CONTEXT_CEILING_TOKENS);
    
          await sweepStaleSwarm(now + STALE_SWARM_MS + 1);
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'active',
            revivable: false,
            silenceParked: false
          });
    
          await sweepStaleSwarm(now + WORKER_SILENCE_MS + 10_000);
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'sleeping',
            revivable: false,
            silenceParked: true,
            silenceRecoveryTurnId: null
          });
    
          vi.setSystemTime(Date.now() + 300_001);
          const budget = (await request('GET', '/status')).body;
          expect(budget.reusableConversations).not.toContain(recoveryState.WORKER);
          expect(budget.closableConversations).not.toContain(recoveryState.WORKER);
    
          if (terminalEvidence === 'turn_end') {
            await events(recoveryState.WORKER, [endTurn('turn-current-without-start', 'stopped')]);
          } else {
            await recordFinalForTest(recoveryState.WORKER, 'turn-current-without-start-final');
          }
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'finished',
            revivable: false,
            silenceParked: false,
            silenceRecoveryTurnId: null
          });
        } finally {
          vi.useRealTimers();
        }
      });

  it('terminalizes a parked ceiling worker from an exact durable turn end without a final row', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'finish on native turn boundary' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [
            { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() },
            openTurn('turn-worker-ceiling-ended')
          ]);
          await attributed(recoveryState.WORKER);
          noteAgentContextTokens(recoveryState.WORKER, WORKER_CONTEXT_CEILING_TOKENS);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(chatOf(reload)).toBe(recoveryState.WORKER);
          expect(await maintenance(reload!.token)).toBeNull();
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'sleeping',
            revivable: false,
            silenceRecoveryTurnId: 'turn-worker-ceiling-ended'
          });
    
          await events(recoveryState.WORKER, [endTurn('turn-worker-ceiling-ended', 'stopped')]);
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'finished',
            revivable: false,
            silenceRecoveryTurnId: null
          });
        } finally {
          vi.useRealTimers();
        }
      });

  it('terminalizes a parked ceiling-silenced worker when the user blocks that chat', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit until explicitly blocked' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [
            { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() },
            openTurn('turn-worker-ceiling-blocked')
          ]);
          await attributed(recoveryState.WORKER);
          noteAgentContextTokens(recoveryState.WORKER, WORKER_CONTEXT_CEILING_TOKENS);
    
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(chatOf(reload)).toBe(recoveryState.WORKER);
          expect(await maintenance(reload!.token)).toBeNull();
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'sleeping',
            revivable: false,
            silenceRecoveryTurnId: 'turn-worker-ceiling-blocked'
          });
    
          setChatBlocked(recoveryState.WORKER, true);
          await sweepStaleSwarm(Date.now());
          expect(swarmStateForCaller({ conversationId: recoveryState.PRIME }).agents.find((agent) => agent.id === 'worker-1')).toMatchObject({
            state: 'finished',
            revivable: false,
            silenceRecoveryTurnId: null
          });
        } finally {
          setChatBlocked(recoveryState.WORKER, false);
          vi.useRealTimers();
        }
      });

  it('never picks a worker that is over, and repairs the chat that is still generating', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          await events(recoveryState.PRIME, [openTurn('turn-live')]);
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          // The worker was the most recently seen chat by a distance, and it is also over.
          await events(recoveryState.WORKER, [openTurn('turn-worker'), endTurn('turn-worker', 'completed')]);
          finishAgent({ conversationId: recoveryState.WORKER }, 'audit done');
          await unattributed();
    
          await vi.advanceTimersByTimeAsync(60_000);
          expect(reopened(recoveryState.WORKER)).toEqual([]);
          expect(chatOf(await maintenance())).toBe(recoveryState.PRIME);
        } finally {
          vi.useRealTimers();
        }
      });
});
