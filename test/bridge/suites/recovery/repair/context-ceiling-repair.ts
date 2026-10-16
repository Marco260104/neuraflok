import { beforeEach, CHAT_SILENCE_MS, describe, expect, getConfig, goalPendingReplyFor, it, pair, PRO_SILENCE_MS, request, resetGoalStateForTests, saveConfig, sessionControlsFor, setSecret, sweepStaleSwarm, vi } from "../../../test-context.js";
import { attributed, endTurn, events, maintenance, openTurn } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: context ceiling repair", () => {
  beforeEach(resetRecoveryFixture);

  it.each([
        { pro: false, delay: 6_000 }, { pro: false, delay: 180_000 },
        { pro: true, delay: 6_000 }, { pro: true, delay: 180_000 }
      ])('reuses the exact silence receipt when its replacement reveals Thinking failed (Pro: $pro, delay: $delay)', async ({ pro, delay }) => {
        const goal = await import("../../../../../backend/domains/automation/goal.js");
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-delayed-failure');
        resetGoalStateForTests();
        vi.useFakeTimers();
        try {
          await pair();
          if (pro) await goal.setGoalSwitchNow(recoveryState.OTHER, 'loop', true, true);
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: pro ? 'gpt-6-pro' : 'GPT-5.6 Sol', reasoningEffort: pro ? 'pro' : 'high', time: Date.now() }, openTurn(`reload-source-${delay}`)]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await vi.advanceTimersByTimeAsync(pro ? PRO_SILENCE_MS : CHAT_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          expect(repair?.reason).toBe('silence');
          await maintenance(repair!.token);
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          await sweepStaleSwarm(Date.now());
          await vi.advanceTimersByTimeAsync(delay);
          await events(recoveryState.OTHER, [{ kind: 'turn_end', turnId: `reload-source-${delay}`, outcome: 'failed', reason: 'thinking_failed', time: Date.now() }]);
          expect(await maintenance()).toBeNull();
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          // New authored work owns a new episode, so retaining this receipt cannot mute the next legitimate quiet recovery.
          await events(recoveryState.OTHER, [openTurn(`next-reload-source-${delay}`)]);
          await attributed(recoveryState.OTHER, false, Date.now());
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          // The replacement page has not supplied model evidence for this new episode.
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toMatchObject({ reason: 'silence' });
        } finally {
          resetGoalStateForTests(); await setSecret('openRouterApiKey', ''); await saveConfig(previous); vi.useRealTimers();
        }
      });

  it.each([
        ['goal', false, true], ['loop', false, true], ['goal', true, true], ['loop', true, true],
        ['goal', false, false], ['loop', false, false], ['goal', true, false], ['loop', true, false]
      ] as const)('does not invent a %s decision after silence (completed tool-only: %s, model known: %s)', async (mode, completed, known) => {
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode } });
        await setSecret('openRouterApiKey', 'sk-or-silence');
        resetGoalStateForTests();
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [...(known ? [{ kind: 'model_selection', model: 'gpt-5-6-thinking', reasoningEffort: 'high', time: Date.now() }] : []), openTurn('turn-loop-dead')]);
          await attributed(recoveryState.OTHER, false, Date.now());
          if (completed) {
            await vi.advanceTimersByTimeAsync(20_000);
            await events(recoveryState.OTHER, [endTurn('turn-loop-dead', 'completed')]);
            const sessionId = (await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.sessionId;
            expect((await sessionControlsFor(sessionId)).recovery).toEqual([{ kind: 'silence', deadline: Date.now() + CHAT_SILENCE_MS, visibleAt: Date.now() + CHAT_SILENCE_MS - 30_000 }]);
          }
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          const handout = await maintenance();
          expect(handout).toMatchObject({ conversationId: recoveryState.OTHER, reason: 'silence' });
          expect(await maintenance(handout!.token)).toBeNull();
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          await vi.advanceTimersByTimeAsync(60_000);
          await sweepStaleSwarm(Date.now());
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          expect((await request('POST', '/goal/draft', { body: { conversationId: recoveryState.OTHER,
            turnId: 'turn-loop-dead', terminalRequired: true } })).status).toBe(409);
        } finally {
          resetGoalStateForTests();
          await setSecret('openRouterApiKey', '');
          await saveConfig(previous);
          vi.useRealTimers();
        }
      });

  for (const model of ['GPT-6 Pro', '6 Pro', 'GPT-5.6 Pro', '5.6 Pro', 'gpt-5-6-pro', 'gpt-5-5-pro', 'Pro']) it(`keeps ${model} silent until ten minutes without inventing a Goal final`, async () => {
        const previous = getConfig();
        await saveConfig({ ...previous, goal: { ...previous.goal, enabled: true, mode: 'loop' } });
        await setSecret('openRouterApiKey', 'sk-or-pro');
        resetGoalStateForTests();
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model, time: Date.now() }, openTurn('pro-silent-' + model)]);
          await attributed(recoveryState.OTHER, false, Date.now());
          await vi.advanceTimersByTimeAsync(1_000);
          await events(recoveryState.OTHER, [{ kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() }]);
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS - 1_001);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
          expect(PRO_SILENCE_MS).toBe(10 * 60_000);
          const live = await request('GET', `/activity?conversationId=${recoveryState.OTHER}`);
          const { sessionControlsFor } = await import("../../../../../backend/domains/browser/bridge.js");
          expect(live.body.activeTurnId).toBe('pro-silent-' + model);
          expect((await sessionControlsFor(live.body.sessionId)).activeTurnId).toBe('pro-silent-' + model);
          await vi.advanceTimersByTimeAsync(1);
          await sweepStaleSwarm(Date.now());
          const reload = await maintenance();
          expect(reload).toMatchObject({ reason: 'silence' });
          await maintenance(reload!.token);
          await vi.advanceTimersByTimeAsync(2);
          await sweepStaleSwarm(Date.now());
          expect(goalPendingReplyFor(recoveryState.OTHER)).toBeNull();
          expect(await maintenance()).toBeNull();
          expect((await request('GET', `/activity?conversationId=${recoveryState.OTHER}`)).body.activeTurnId).toBeNull();
          expect((await sessionControlsFor(live.body.sessionId)).activeTurnId).toBeNull();
          const refused = await request('POST', '/goal/draft', { body: { conversationId: recoveryState.OTHER, turnId: 'pro-silent-' + model, clientId: 'tab-1' } });
          expect(refused.status).toBe(409);
        } finally {
          resetGoalStateForTests(); await setSecret('openRouterApiKey', ''); await saveConfig(previous); vi.useRealTimers();
        }
      });
});
