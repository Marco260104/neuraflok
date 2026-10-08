import { beforeEach, BROWSER_RECOVERY_COOLDOWN_MS, CHAT_SILENCE_MS, describe, expect, getConfig, it, pair, PRO_SILENCE_MS, redeem, request, saveConfig, spawn, sweepStaleSwarm, vi } from "../../../test-context.js";
import { attributed, endTurn, events, maintenance, openTurn } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: stalled tabs and provider limits", () => {
  beforeEach(resetRecoveryFixture);

  it('waits out the shared cooldown before reloading a tab Chrome keeps stalling', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          // Keep live work beyond the three-minute browser cooldown; unknown work now exhausts ordinary silence after two minutes.
          await events(recoveryState.WORKER, [{ kind: 'model_selection', model: 'gpt-6-pro', reasoningEffort: 'pro', time: Date.now() }, openTurn('turn-worker-stall-loop')]);
          const stalled = async () =>
            ((await request('POST', '/status', { body: { openConversations: [recoveryState.WORKER], stalledConversations: [recoveryState.WORKER] } })).body
              .repairs ?? []) as Array<{ conversationId: string; token: string; reason: string }>;
    
          const first = (await stalled()).find((row) => row.conversationId === recoveryState.WORKER);
          expect(first?.reason).toBe('stalled');
          await request('POST', `/status?repaired=${encodeURIComponent(first!.token)}&repairAction=reloaded`, {
            body: { openConversations: [recoveryState.WORKER], stalledConversations: [] }
          });
    
          expect((await stalled()).filter((row) => row.conversationId === recoveryState.WORKER)).toEqual([]);
          await vi.advanceTimersByTimeAsync(BROWSER_RECOVERY_COOLDOWN_MS - 1);
          expect((await stalled()).filter((row) => row.conversationId === recoveryState.WORKER)).toEqual([]);
          await vi.advanceTimersByTimeAsync(1);
          const second = (await stalled()).find((row) => row.conversationId === recoveryState.WORKER);
          expect(second?.reason).toBe('stalled');
          expect(second!.token).not.toBe(first!.token);
        } finally {
          vi.useRealTimers();
        }
      });

  it('leaves a stalled ordinary tab asleep when tab recovery is off for it', async () => {
        await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
        await pair();
        await events(recoveryState.OTHER, [openTurn('turn-ordinary-stalled')]);
        await attributed(recoveryState.OTHER);
    
        const status = (await request('POST', '/status', { body: { openConversations: [recoveryState.OTHER], stalledConversations: [recoveryState.OTHER] } })).body;
        expect((status.repairs ?? []).filter((row: any) => row.conversationId === recoveryState.OTHER)).toEqual([]);
      });

  it('ignores a stalled report for a chat the same pass did not report open', async () => {
        await pair();
        spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
        const bootstrap = await redeem();
        await request('POST', '/commands/ack', {
          body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
        });
        await events(recoveryState.WORKER, [openTurn('turn-worker-not-open')]);
    
        // A stalled shell is defined by its surviving tab. Without one the report names nothing — the missing-tab path, not this one, owns a genuinely absent tab.
        const status = (await request('POST', '/status', { body: { openConversations: [], stalledConversations: [recoveryState.WORKER] } })).body;
        expect((status.repairs ?? []).filter((row: any) => row.conversationId === recoveryState.WORKER)).toEqual([]);
      });

  it('repairs a stalled compaction source on the ticket’s own evidence, even with tab recovery off', async () => {
        await saveConfig({ ...getConfig(), multiAgent: { ...getConfig().multiAgent, recoverAgentTabs: false } });
        await pair();
        const conversationId = 'a1a1a1a1-0000-4000-8000-00000000ad01';
        await request('POST', '/events', {
          body: {
            conversationId,
            events: [{ kind: 'user_message', time: Date.now(), text: 'compact me later', messageId: 'stalled-source' }]
          }
        });
        const filed = await request('POST', '/compact', { body: { conversationId, ticket: true } });
        expect(filed.status).toBe(202);
    
        const status = (await request('POST', '/status', { body: { openConversations: [conversationId], stalledConversations: [conversationId] } })).body;
        const handout = (status.repairs ?? []).find((row: any) => row.conversationId === conversationId);
        expect(handout?.reason).toBe('stalled');
      });

  it('rejects a malformed stalled report', async () => {
        await pair();
        expect((await request('POST', '/status', { body: { openConversations: [], stalledConversations: ['not-a-conversation'] } })).status).toBe(400);
      });

  it('records explicit provider access limits without scheduling a reload or silence retry', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('limited-turn')]);
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: 'limited-turn', recoverable: false,
            text: 'Too many requests We have temporarily limited access to conversations to protect your data. Please wait a few minutes.' }]);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(180_000);
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  // The same dialog, in the language the account is actually reading. The DOM classifier already recognises it and marks it blocking; only the app's English prose match decided whether the chat came off the silence clock, so a Korean user's rate limit ran the response watchdog down and asked the browser to reload against a provider block.
      it('records a provider access limit the classifier flagged, whatever language it is in', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          await events(recoveryState.PRIME, [openTurn('limited-turn-ko')]);
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: 'limited-turn-ko',
            recoverable: false, blocking: true,
            text: '요청이 너무 많습니다 요청을 너무 빠르게 보내고 있습니다. 데이터를 보호하기 위해 대화에 대한 액세스가 일시적으로 제한되었습니다. 몇 분 후 다시 시도해 주세요.' }]);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(180_000);
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it.each(['goal', 'loop'] as const)('preserves the existing %s silence deadline after a provider access limit', async mode => {
        vi.useFakeTimers();
        try {
          await pair();
          const { setGoalSwitchNow } = await import("../../../../../backend/domains/automation/goal.js");
          await setGoalSwitchNow(recoveryState.PRIME, mode, true, true);
          await events(recoveryState.PRIME, [{ kind: 'model_selection', time: Date.now(), model: 'GPT-5.6 Sol', reasoningEffort: 'high' }, openTurn('limited-goal')]);
          await attributed(recoveryState.PRIME, false, Date.now());
          const deadline = Date.now() + CHAT_SILENCE_MS;
          const notice = () => events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: 'limited-goal',
            recoverable: false, blocking: true, text: 'provider access limit' }]);
          await notice();
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS - 1);
          await notice(); // Re-rendering cannot renew the original deadline.
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(2);
          expect(Date.now()).toBe(deadline + 1);
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          expect(repair).toMatchObject({ conversationId: recoveryState.PRIME, reason: 'silence' });
          await vi.advanceTimersByTimeAsync(31_000);
          await notice(); // A diagnostic cannot revoke custody of the handed repair.
          expect(await maintenance(repair!.token)).toBeNull();
          await vi.advanceTimersByTimeAsync(31_000);
          await notice();
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it('renews Goal silence for genuine work beside a provider access limit', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          const { setGoalSwitchNow } = await import("../../../../../backend/domains/automation/goal.js");
          await setGoalSwitchNow(recoveryState.PRIME, 'loop', true, true);
          await events(recoveryState.PRIME, [{ kind: 'model_selection', time: Date.now(), model: 'GPT-5.6 Sol', reasoningEffort: 'high' }, openTurn('limited-work')]);
          await attributed(recoveryState.PRIME, false, Date.now());
          await vi.advanceTimersByTimeAsync(60_000);
          await events(recoveryState.PRIME, [
            { kind: 'chat_error', time: Date.now(), turnId: 'limited-work', recoverable: false, blocking: true, text: 'provider access limit' },
            { kind: 'assistant_message', time: Date.now(), turnId: 'limited-work', messageId: 'new-work', text: 'Continuing the checks.', state: 'streaming', activeNow: true }
          ]);
          await vi.advanceTimersByTimeAsync(60_001);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(60_000);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toMatchObject({ conversationId: recoveryState.PRIME, reason: 'silence' });
        } finally { vi.useRealTimers(); }
      });

  it.each([false, true])('retires a %s handed silence repair when completion accompanies a provider access limit', async handed => {
        vi.useFakeTimers();
        try {
          await pair();
          const { setGoalSwitchNow } = await import("../../../../../backend/domains/automation/goal.js");
          await setGoalSwitchNow(recoveryState.PRIME, 'loop', true, true);
          await events(recoveryState.PRIME, [{ kind: 'model_selection', time: Date.now(), model: 'GPT-5.6 Sol', reasoningEffort: 'high' }, openTurn('limited-completed')]);
          await attributed(recoveryState.PRIME, false, Date.now());
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS + 1);
          await sweepStaleSwarm(Date.now());
          const repair = handed ? await maintenance() : null;
          if (handed) expect(repair).toMatchObject({ conversationId: recoveryState.PRIME, reason: 'silence' });
          await events(recoveryState.PRIME, [
            { kind: 'chat_error', time: Date.now(), turnId: 'limited-completed', recoverable: false, blocking: true, text: 'provider access limit' },
            endTurn('limited-completed', 'completed'),
            { kind: 'assistant_message', time: Date.now(), turnId: 'limited-completed', messageId: 'completed-answer', text: 'The checks are complete.', state: 'final', final: true }
          ]);
          expect(await maintenance()).toBeNull();
          if (repair) expect(await maintenance(repair.token)).toBeNull();
          await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS + 1);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it.each(['off', 'wrong-turn', 'no-grant'] as const)('does not create Goal recovery authority from a provider access limit (%s)', async scenario => {
        vi.useFakeTimers();
        try {
          await pair();
          const { setGoalSwitchNow } = await import("../../../../../backend/domains/automation/goal.js");
          await setGoalSwitchNow(recoveryState.PRIME, 'loop', true, true);
          if (scenario !== 'no-grant') {
            await events(recoveryState.PRIME, [{ kind: 'model_selection', time: Date.now(), model: 'GPT-5.6 Sol', reasoningEffort: 'high' }, openTurn('limited-negative')]);
          }
          if (scenario === 'off') await setGoalSwitchNow(recoveryState.PRIME, 'loop', false);
          await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now(), turnId: scenario === 'wrong-turn' ? 'different-turn' : 'limited-negative',
            recoverable: false, blocking: true, text: 'provider access limit' }]);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(PRO_SILENCE_MS + 1);
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); }
      });

  it.each([false, undefined])('does not spend recovery on an informational alert (recoverable: %s)', async recoverable => {
        await pair();
        // Older loaded extension documents queued this toast before New Chat had an id.
        await events(recoveryState.PRIME, [{ kind: 'chat_error', time: Date.now() - 90_000,
          text: 'Actions refreshed.', recoverable }]);
        expect(await maintenance()).toBeNull();
        await events(recoveryState.PRIME, [openTurn('real-failure'), { kind: 'chat_error', time: Date.now(),
          text: 'Message delivery timed out. Please try again.', recoverable: true }]);
        expect((await maintenance())?.reason).toBe('assistant-error');
      });
});
