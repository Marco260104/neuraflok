import { randomUUID } from "node:crypto";
import { beforeEach, CHAT_SILENCE_MS, describe, expect, getConfig, getLog, getSession, GOAL_QUIET_MS, goalDraftBusy, goalPendingReplyFor, it, liveConversations, pair, PRO_ACTIVITY_MS, PRO_SILENCE_MS, recordFinalForTest, redeem, request, resetGoalStateForTests, saveConfig, sessionControlsFor, setSecret, spawn, swarmState, sweepStaleSwarm, vi } from "../../../test-context.js";
import { attributed, endTurn, events, maintenance, openTurn } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: goal and recovery policy", () => {
  beforeEach(resetRecoveryFixture);

  for (const selection of ['missing', 'stale', 'after-start']) it(`does not synthesize a silence Goal without MCP proof (${selection} model evidence)`, async () => {
        // Persisted model observations survive the bridge reset: use a fresh conversation.
        const uncertainChat = `a4444444-1111-4111-8111-00000000000${["missing", "stale", "after-start"].indexOf(selection)}`;
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-uncertain');
        resetGoalStateForTests(); vi.useFakeTimers();
        try {
          await pair();
          if (selection === 'stale') await events(uncertainChat, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }]);
          await vi.advanceTimersByTimeAsync(1_000);
          await events(uncertainChat, [openTurn('uncertain-' + selection)]);
          if (selection === 'after-start') await events(uncertainChat, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() + 1 }]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(reload).toBeNull();
          await vi.advanceTimersByTimeAsync(60_000);
          await sweepStaleSwarm(Date.now());
          expect(goalPendingReplyFor(uncertainChat)).toBeNull();
        } finally { resetGoalStateForTests(); await setSecret('openRouterApiKey', ''); await saveConfig(previous); vi.useRealTimers(); }
      });

  it('anchors delayed Pro evidence to provider time and never rewinds it for older accepted revisions', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          const began = Date.now();
          await vi.advanceTimersByTimeAsync(60_000);
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-6 Pro', time: began }, { kind: 'turn_start', turnId: 'delayed-pro', time: began }]);
          const sessionId = (await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.sessionId;
          const { sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(began + PRO_ACTIVITY_MS);
          await vi.advanceTimersByTimeAsync(120_000);
          await events(recoveryState.OTHER, [{ kind: 'assistant_message', turnId: 'delayed-pro', messageId: 'newer-pro-interim', time: began + 120_000,
            text: 'Still working.', state: 'streaming', activeNow: true }]);
          const expected = began + 120_000 + PRO_ACTIVITY_MS;
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(expected);
          await events(recoveryState.OTHER, [{ kind: 'assistant_message', turnId: 'delayed-pro', messageId: 'older-pro-interim', time: began + 90_000,
            text: 'Earlier progress arrived late.', state: 'streaming', activeNow: true }]);
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBe(expected);
          await events(recoveryState.OTHER, [{ kind: 'turn_end', turnId: 'delayed-pro', time: Date.now(), outcome: 'unknown' }]);
          expect(sessionActivityExpiresAt((await getSession(sessionId))!)).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it('files no Goal ticket when the reloaded Goal chat shows signs of life within the minute', async () => {
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-silence');
        resetGoalStateForTests();
        vi.useFakeTimers();
        try {
          await pair();
          await events('a6666666-1111-4111-8111-000000000006', [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-loop-slow')]);
          await attributed('a6666666-1111-4111-8111-000000000006', false, Date.now());
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const handout = await maintenance();
          expect(handout).toMatchObject({ conversationId: 'a6666666-1111-4111-8111-000000000006', reason: 'silence' });
          expect(await maintenance(handout!.token)).toBeNull();
    
          // A tool call flutters in twenty seconds after the reload: the chat is working.
          await vi.advanceTimersByTimeAsync(20_000);
          await attributed('a6666666-1111-4111-8111-000000000006');
          await vi.advanceTimersByTimeAsync(50_000);
          await sweepStaleSwarm(Date.now());
          expect(goalPendingReplyFor('a6666666-1111-4111-8111-000000000006')).toBeNull();
        } finally {
          resetGoalStateForTests();
          await setSecret('openRouterApiKey', '');
          await saveConfig(previous);
          vi.useRealTimers();
        }
      });

  /** The other two signs of life, so the listen window is proven against every kind of signal a working chat gives off: an interim assistant row the fresh page reports, and a message the user typed. Each pushes the chat back onto its two-minute clock, so a chat that stops again later gets the same silence window and confirmed reload — the loop carries on. */
      for (const [what, sign] of [
        ['an interim assistant message', (turnId: string) => [{ kind: 'assistant_message', time: Date.now(), turnId, text: 'still on it', messageId: 'a-interim', state: 'streaming', activeNow: true }]],
        ['a user message', () => [{ kind: 'user_message', time: Date.now(), text: 'carry on', messageId: 'u-alive', authoredNow: true }]]
      ] as const) {
        it(`withdraws a silence ticket when ${what} arrives, and re-arms the silence clock`, async () => {
          const previous = getConfig();
          await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
          await setSecret('openRouterApiKey', 'sk-or-silence');
          resetGoalStateForTests();
          vi.useFakeTimers();
          try {
            await pair();
            const turnId = `turn-loop-${what.length}`;
            await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn(turnId)]);
            await attributed(recoveryState.OTHER, false, Date.now());
            await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
            await sweepStaleSwarm(Date.now());
            const handout = await maintenance();
            expect(handout).toMatchObject({ conversationId: recoveryState.OTHER, reason: 'silence' });
            expect(await maintenance(handout!.token)).toBeNull();
    
            await vi.advanceTimersByTimeAsync(20_000);
            await events(recoveryState.OTHER, sign(turnId));
            if (what === 'a user message') {
              await events(recoveryState.OTHER, [openTurn('next-user-work')]);
              await attributed(recoveryState.OTHER, false, Date.now());
            }
            await vi.advanceTimersByTimeAsync(50_000);
            await sweepStaleSwarm(Date.now());
            expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
    
            // Quiet again for the full two minutes: confirmed refresh files the ticket.
            await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
            await sweepStaleSwarm(Date.now());
            const again = await maintenance();
            expect(again).toMatchObject({ conversationId: recoveryState.OTHER, reason: 'silence' });
            expect(await maintenance(again!.token)).toBeNull();
            await sweepStaleSwarm(Date.now());
            expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          } finally {
            resetGoalStateForTests();
            await setSecret('openRouterApiKey', '');
            await saveConfig(previous);
            vi.useRealTimers();
          }
        });
      }

  /** Full final evidence wins immediately; controls, interim prose and old finals do not. */
      it.each(['exact final', 'final without end control', 'backfilled final after completion', 'different turn final', 'new active turn', 'interim only', 'end control only', 'new tool work', 'running local tool'] as const)(
        'only the full final for the current turn ends the silence wait: %s', async (proof) => {
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-final');
        resetGoalStateForTests();
        vi.useFakeTimers();
        let releaseTool = () => {};
        let heldTool: Promise<void> = Promise.resolve();
        try {
          await pair();
          const turnId = 'turn-exact-final-' + proof.replaceAll(' ', '-');
          await events(recoveryState.OTHER, [openTurn(turnId)]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await vi.advanceTimersByTimeAsync(1_000);
          if (proof === 'backfilled final after completion') {
            await events(recoveryState.OTHER, [endTurn(turnId, 'completed')]);
            await vi.advanceTimersByTimeAsync(1_000);
          }
          if (proof !== 'end control only') await events(recoveryState.OTHER, [{ kind: 'assistant_message', time: Date.now(), messageId: 'answer-' + turnId,
            turnId: proof === 'different turn final' ? 'older-turn' : turnId,
            text: 'The requested work is complete.', state: proof === 'interim only' ? 'streaming' : 'final', final: proof !== 'interim only', activeNow: proof !== 'backfilled final after completion' },
            ...(proof === 'final without end control' || proof === 'backfilled final after completion' ? [] : [endTurn(turnId, 'completed')])]);
          else await events(recoveryState.OTHER, [endTurn(turnId, 'completed')]);
          if (proof === 'new active turn') await events(recoveryState.OTHER, [openTurn('next-turn')]);
          if (proof === 'new tool work') { await vi.advanceTimersByTimeAsync(1); await attributed(recoveryState.OTHER, false, Date.now()); }
          if (proof === 'running local tool') {
            const { trackInFlight, emptyEvidence } = await import("../../../../../backend/infrastructure/tool-gateway/protocol/call-context.js");
            heldTool = trackInFlight({ startedAt: Date.now(), transportKey: null, agent: null, outcome: null,
              evidence: emptyEvidence(), caller: { conversationId: recoveryState.OTHER, requestId: 'held-final-call', transportKey: null } },
              () => new Promise<void>(resolve => { releaseTool = resolve; }));
          }
          const result = await request('POST', '/goal/draft', {
            body: { conversationId: recoveryState.OTHER, turnId, clientId: 'tab-1' }
          });
          if (proof === 'exact final' || proof === 'final without end control' || proof === 'backfilled final after completion') expect(result.status).toBe(200);
          else {
            expect(result.status).toBe(409);
            expect(result.body).toMatchObject({ error: 'chat_still_working' });
          }
          if (proof === 'running local tool') {
            releaseTool(); await heldTool;
            expect((await request('POST', '/goal/draft', { body: { conversationId: recoveryState.OTHER, turnId, clientId: 'tab-1' } })).status).toBe(200);
          }
        } finally {
          releaseTool(); await heldTool;
          resetGoalStateForTests();
          await setSecret('openRouterApiKey', '');
          await saveConfig(previous);
          vi.useRealTimers();
        }
      });

  it('refuses to draft for a chat whose tools ran within the last minute, then drafts once it is quiet', async () => {
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-quiet');
        resetGoalStateForTests();
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [openTurn('turn-false-end')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await vi.advanceTimersByTimeAsync(28_000);
          await events(recoveryState.OTHER, [endTurn('turn-false-end', 'completed')]);
    
          const early = await request('POST', '/goal/draft', {
            body: { conversationId: recoveryState.OTHER, turnId: 'turn-false-end', clientId: 'tab-1' }
          });
          expect(early.status).toBe(409);
          expect(early.body).toMatchObject({ error: 'chat_still_working', retryable: true });
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          expect(goalDraftBusy(recoveryState.OTHER)).toBe(false);
    
          await vi.advanceTimersByTimeAsync(GOAL_QUIET_MS);
          const quiet = await request('POST', '/goal/draft', {
            body: { conversationId: recoveryState.OTHER, turnId: 'turn-false-end', clientId: 'tab-1' }
          });
          expect(quiet.status).toBe(409); // Silence alone never proves the missing final.
        } finally {
          resetGoalStateForTests();
          await setSecret('openRouterApiKey', '');
          await saveConfig(previous);
          vi.useRealTimers();
        }
      });

  /** The record's own turn is the first thing the draft waits on. On 2026-09-03 the prime's turn had been reopened by its own tool calls and never ended again — the "Message delivery timed out" banner produced no turn end — yet the page asked twenty seconds later and was drafted. Quiet tools alone are not enough while the app still has the turn open. */
      it('refuses to draft while the app still has the turn open, however quiet the tools are', async () => {
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-open');
        resetGoalStateForTests();
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [openTurn('turn-still-open')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await vi.advanceTimersByTimeAsync(GOAL_QUIET_MS + 5_000);
    
          const open = await request('POST', '/goal/draft', {
            body: { conversationId: recoveryState.OTHER, turnId: 'turn-still-open', clientId: 'tab-1' }
          });
          expect(open.status).toBe(409);
          expect(open.body).toMatchObject({ error: 'chat_still_working', retryable: true });
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull(); // No unconfirmed final obligation.
    
          await recordFinalForTest(recoveryState.OTHER, 'turn-still-open');
          await events(recoveryState.OTHER, [endTurn('turn-still-open', 'completed')]);
          const ended = await request('POST', '/goal/draft', {
            body: { conversationId: recoveryState.OTHER, turnId: 'turn-still-open', clientId: 'tab-1' }
          });
          expect(ended.status).toBe(200);
        } finally {
          resetGoalStateForTests();
          await setSecret('openRouterApiKey', '');
          await saveConfig(previous);
          vi.useRealTimers();
        }
      });

  /** The silence ticket is the route a chat whose page lost its answer takes to the next message, and its turn is exactly the one nobody is left to close: the reload, the minute of nothing, and the ticket are the app's own finding that the answer is over. That draft is not held behind the open turn. */
      it('never drafts a Goal decision from an open lost turn', async () => {
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-silent-open');
        resetGoalStateForTests();
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }, openTurn('turn-lost')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const handout = await maintenance();
          expect(handout).toMatchObject({ conversationId: recoveryState.OTHER, reason: 'silence' });
          expect(await maintenance(handout!.token)).toBeNull();
          await sweepStaleSwarm(Date.now());
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          await vi.advanceTimersByTimeAsync(60_000);
          const drafted = await request('POST', '/goal/draft', {
            body: { conversationId: recoveryState.OTHER, turnId: 'turn-lost', clientId: 'tab-1', terminalRequired: true }
          });
          expect(drafted.status).toBe(409);
        } finally {
          resetGoalStateForTests();
          await setSecret('openRouterApiKey', '');
          await saveConfig(previous);
          vi.useRealTimers();
        }
      });

  it('keeps Pro silence out of Goal decisions and rearms recovery on MCP work', async () => {
        const OTHER = 'c9191919-1111-2222-3333-444444444444';
        const previous = getConfig();
        const goal = await import("../../../../../backend/domains/automation/goal.js");
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-pro-loop-test');
        resetGoalStateForTests();
        vi.useFakeTimers();
        try {
          await pair();
          await goal.setGoalSwitchNow(OTHER, 'loop', true, true);
          await events(OTHER, [{ kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: Date.now() }, openTurn('pro-loop-after-turn')]);
          await attributed(OTHER, false, Date.now());
          // Canonical revisions spend sequence numbers without adding presentation rows.
          for (const text of ['Working', 'Working on the requested pass']) await events(OTHER, [{ kind: 'assistant_message',
            messageId: 'pro-loop-interim', turnId: 'pro-loop-after-turn', time: Date.now(), text, state: 'streaming', activeNow: true }]);
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS - 1);
          expect(await maintenance()).toBeNull();
          expect(goalPendingReplyFor(OTHER)).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          expect(repair?.reason).toBe('silence');
          await maintenance(repair!.token);
          expect(goalPendingReplyFor(OTHER)).toBeNull();
          const activity = (await request('GET', `/activity?conversationId=${OTHER}`)).body;
          expect(activity.recordedTurnId).toBe('pro-loop-after-turn');
          await vi.advanceTimersByTimeAsync(1000);
          await attributed(OTHER, false, Date.now());
          await request('GET', `/activity?conversationId=${OTHER}`);
          expect(goalPendingReplyFor(OTHER)).toBeNull();
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS - 1);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          expect((await maintenance())?.reason).toBe('silence');
        } finally {
          resetGoalStateForTests(); await setSecret('openRouterApiKey', ''); await saveConfig(previous); vi.useRealTimers();
        }
      });

  it.each([
        ['goal', true, 'completed'], ['goal', false, 'completed'],
        ['loop', true, 'completed'], ['loop', false, 'completed'],
        ['goal', true, 'thinking_failed'], ['goal', false, 'thinking_failed'],
        ['loop', true, 'thinking_failed'], ['loop', false, 'thinking_failed']
      ] as const)('routes Astra %s with finish=%s at its confirmed %s boundary', async (mode, finishTool, kind) => {
        const OTHER = randomUUID();
        const previous = getConfig();
        const goal = await import("../../../../../backend/domains/automation/goal.js");
        await saveConfig({ ...previous, ui: { ...previous.ui, finishTool }, goal: { ...previous.goal, enabled: true, mode } });
        await setSecret('openRouterApiKey', 'sk-or-pro-loop-boundary'); resetGoalStateForTests();
        vi.useFakeTimers();
        try {
          await pair(); await goal.setGoalSwitchNow(OTHER, mode, true, finishTool);
          const turn = `astra-${mode}-${kind}`;
          await events(OTHER, [{ kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: Date.now() }, openTurn(turn)]);
          await attributed(OTHER, false, Date.now());
          const activity = (await request('GET', `/activity?conversationId=${OTHER}`)).body;
          expect(activity.goal).toMatchObject({ mode, afterTurn: true, proLoopDelivery: finishTool });
          expect((await sessionControlsFor(activity.sessionId)).proLoopDelivery).toBe(finishTool);
          await vi.advanceTimersByTimeAsync(kind === 'completed' ? PRO_SILENCE_MS : 330000);
          if (kind === 'completed') {
            await events(OTHER, [{ kind: 'assistant_message', messageId: `answer-${turn}`, turnId: turn, time: Date.now(),
              text: 'The requested pass is complete.', final: true, state: 'final', activeNow: true, goalEligible: true }, endTurn(turn, 'completed')]);
          } else await events(OTHER, [{ kind: 'turn_end', turnId: turn, outcome: 'failed', reason: 'thinking_failed', time: Date.now() }]);
          if (kind === 'thinking_failed') {
            expect(goalPendingReplyFor(OTHER)).toBeNull();
            await sweepStaleSwarm(Date.now());
            const repair = await maintenance();
            expect(repair?.reason).toBe('silence');
            await maintenance(repair!.token);
          }
          const pending = goalPendingReplyFor(OTHER);
          if (kind === 'thinking_failed') {
            expect(pending).toBeNull();
            return; // Continue is covered through real IPC hooks in input-delivery-integration.
          }
          expect(pending).not.toBeNull();
          const reply = await request('POST', '/goal/draft', { body: { conversationId: OTHER, turnId: pending!.turnId, terminalRequired: true } });
          expect(`${reply.status} ${JSON.stringify(reply.body)}`).toMatch(/^200 /);
        } finally { resetGoalStateForTests(); await setSecret('openRouterApiKey', ''); await saveConfig(previous); vi.useRealTimers(); }
      });

  it('blocks automatic Loop without source MCP but allows deliberate idle activation', async () => {
        const chat = 'c9494949-1111-2222-3333-444444444444';
        const goal = await import("../../../../../backend/domains/automation/goal.js");
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-loop-proof-test');
        try {
          await pair();
          await events(chat, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() },
            openTurn('loop-without-mcp'), { kind: 'assistant_message', turnId: 'loop-without-mcp', messageId: 'loop-no-tools-final',
              time: Date.now(), text: 'I cannot access the MCP tools.', final: true, state: 'final', activeNow: true, goalEligible: true },
            endTurn('loop-without-mcp', 'completed')]);
          expect(goalPendingReplyFor(chat)).toBeNull();
          const refused = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'loop-without-mcp' } });
          expect(refused.status).toBe(409);
          expect(refused.body).toMatchObject({ error: 'loop_mcp_call_missing', retryable: false });
          expect(refused.body.message).toContain('No local tool call was recorded in the last response');
          expect(refused.body.message).toContain('The selected provider may be waiting for input');
          expect(refused.body.message).toContain('the connection may have been lost');
          expect(refused.body.message).toContain('Loop remains enabled');
          expect(goal.goalViewFor(chat)).toBeNull();
          await request('POST', '/settings', { body: { conversationId: chat, loop: false } });
          await request('POST', '/settings', { body: { conversationId: chat, loop: true } });
          expect(goalPendingReplyFor(chat)).toMatchObject({ turnId: 'loop-without-mcp' });
          expect(goal.snapshotGoalReplies().replies.find(row => row.conversationId === chat)).toMatchObject({ explicitActivation: true });
          const allowed = await request('POST', '/goal/draft', { body: { conversationId: chat, turnId: 'loop-without-mcp', terminalRequired: true } });
          expect(`${allowed.status} ${JSON.stringify(allowed.body)}`).toMatch(/^200 /);
        } finally { resetGoalStateForTests(); await setSecret('openRouterApiKey', ''); await saveConfig(previous); }
      });

  it('leaves a silent plain chat where it fell when tab recovery is off', async () => {
        const previous = getConfig();
        await saveConfig({
          ...previous,
          multiAgent: { ...previous.multiAgent, recoverAgentTabs: false },
          goal: { ...previous.goal, enabled: false }
        });
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [openTurn('turn-plain-silent')]);
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally {
          await saveConfig(previous);
          vi.useRealTimers();
        }
      });

  it('can disable missing-tab and inactivity recovery without changing agent lifecycle', async () => {
        const previous = getConfig();
        expect(previous.multiAgent.recoverAgentTabs).toBe(true);
        await saveConfig({
          ...previous,
          multiAgent: { ...previous.multiAgent, recoverAgentTabs: false }
        });
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [openTurn('turn-worker-recovery-disabled')]);
          await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER } });
          expect(swarmState().agents.find((agent) => agent.id === 'worker-1')?.state).toBe('detached');
          expect(await maintenance()).toBeNull();
        } finally {
          const latest = getConfig();
          await saveConfig({
            ...latest,
            multiAgent: { ...latest.multiAgent, recoverAgentTabs: true }
          });
          expect(getConfig().multiAgent.recoverAgentTabs).toBe(true);
        }
      });

  it('keeps a completed chat closed across repeated history visits with an older unended turn', async () => {
        const SOLO = 'b2b2b2b2-1111-2222-3333-444444444444';
        await pair();
        await events(SOLO, [openTurn('turn-orphan-before-reload')]);
        await attributed(SOLO);
        await events(SOLO, [openTurn('turn-latest-completed'), endTurn('turn-latest-completed', 'completed')]);
        for (let attempt = 0; attempt < 4; attempt++) {
          await request('POST', '/closed', { body: { conversationId: SOLO } });
          expect(await maintenance()).toBeNull();
          // Opening history hydrates the recorder; it must not revive the orphan.
          await events(SOLO, [{ kind: 'conversation_title', time: Date.now(), text: 'Settled chat' }]);
          expect(liveConversations().find(entry => entry.conversationId === SOLO)?.activeTurnId).toBeNull();
        }
        // Explicit new work in the same chat still earns ordinary recovery.
        await events(SOLO, [openTurn('turn-new-work')]);
        await request('POST', '/closed', { body: { conversationId: SOLO } });
        expect(await maintenance()).toMatchObject({ conversationId: SOLO, reason: 'no-tab' });
      });

  /** A turn whose page went away mid-turn stays open on purpose: ChatGPT may still be working on it. But one left that way for days is not a running turn. Measured 2026-10-09: a test chat's turn had been open since 2026-10-01; opening the chat for a few seconds and leaving it made the app reopen its tab, and the watchdog ended the turn ten minutes later. Activity still counts on its own clock; only the bare open turn ages out. */
      it('does not reopen a chat whose only claim to work is a turn opened long ago', async () => {
        vi.useFakeTimers();
        try {
          const SOLO = 'b2b2b2b2-1111-2222-3333-444444444444';
          await pair();
          await events(SOLO, [openTurn('turn-left-open')]);
          await attributed(SOLO, true);
          vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
          await request('POST', '/closed', { body: { conversationId: SOLO } });
          expect(await maintenance()).toBeNull();
          expect(getLog().filter(entry => entry.message.includes('closed its last tab')).at(-1)?.message).toContain('no turn is running in it');
        } finally {
          vi.useRealTimers();
        }
      });
});
