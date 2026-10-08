import { randomUUID } from "node:crypto";
import { agentInfoForOwnedConversation, beforeEach, CHAT_SILENCE_MS, describe, expect, findSessionByConversation, getConfig, getLog, getSession, GOAL_QUIET_MS, it, liveConversations, pair, PRO_SILENCE_MS, readEvents, recordFinalForTest, recordToolCall, redeem, request, saveConfig, sessionControlsFor, sessionStoreModule, spawn, sweepStaleSwarm, vi, writeDurableNow } from "../../../test-context.js";
import { attributed, endTurn, events, maintenance, openTurn, reopened } from "../recovery-fixtures.js";
import { recoveryState, resetRecoveryFixture } from "../recovery-fixtures.js";

describe("unattributed activity recovery: continuing activity and worker state", () => {
  beforeEach(resetRecoveryFixture);

  it('says why silence recovery waits on a running call of unknown chat, and recovers once it ends (#1086)', async () => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true } });
        vi.useFakeTimers();
        try {
          await pair();
          const chat = randomUUID(), turnId = 'waits-on-unknown-call';
          await events(chat, [
            { kind: 'user_message', messageId: 'question', text: 'Review the changes', time: Date.now(), authoredNow: true },
            { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() },
            openTurn(turnId)
          ]);
          await attributed(chat, false, Date.now());
          const { trackInFlight, emptyEvidence } = await import("../../../../../backend/infrastructure/tool-gateway/protocol/call-context.js");
          // Another chat's call that no page has claimed yet: it counts as possibly this chat's work.
          await trackInFlight({ startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
            caller: { conversationId: null, requestId: 'unknown-chat-call', transportKey: null } }, async () => {
            // Within the hold for calls of no known chat, every pass waits.
            for (let pass = 0; pass < 2; pass++) {
              await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
              await sweepStaleSwarm(Date.now());
              expect(await maintenance()).toBeNull();
            }
          });
          const why = getLog().filter(entry => entry.message.includes(`silence recovery for ${chat}`)).map(entry => entry.message);
          expect(why).toEqual([expect.stringContaining('a tool call whose chat is not known yet is running')]);
          // The call ended: the next pass recovers the chat.
          await vi.advanceTimersByTimeAsync(GOAL_QUIET_MS);
          await sweepStaleSwarm(Date.now());
          expect(await maintenance()).toMatchObject({ conversationId: chat, reason: 'silence' });
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });

  it('lets calls of no known chat hold a silent chat only for a while, then recovers it anyway (#1086)', async () => {
        const input = await import("../../../../../backend/domains/sessions/input/input.js");
        const { recoveryHeldByCalls, recoveryInputAllowed, sessionInputActivity } = await import("../../../../../backend/domains/browser/bridge.js");
        // The app's own wiring (ipc.ts): the automatic Continue asks the bridge whether it is allowed.
        input.configureInputDelivery({ recoveryAllowed: recoveryInputAllowed, callsHoldRecovery: recoveryHeldByCalls,
          activity: sessionInputActivity, applyAutomation: async () => {}, changed: () => {} });
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true } });
        vi.useFakeTimers();
        try {
          await pair();
          const chat = randomUUID(), turnId = 'held-by-another-chat';
          await events(chat, [
            { kind: 'user_message', messageId: 'question', text: 'Review the changes', time: Date.now(), authoredNow: true },
            { kind: 'model_selection', model: 'GPT-5.6 Sol', reasoningEffort: 'high', time: Date.now() },
            openTurn(turnId)
          ]);
          await attributed(chat, false, Date.now());
          const { trackInFlight, emptyEvidence } = await import("../../../../../backend/infrastructure/tool-gateway/protocol/call-context.js");
          // Another chat keeps a call of no proven chat running the whole time (a worker polling every 30 s did, on 2026-10-05): it can no longer keep this chat waiting forever.
          await trackInFlight({ startedAt: Date.now(), transportKey: null, agent: null, outcome: null, evidence: emptyEvidence(),
            caller: { conversationId: null, requestId: 'never-claimed', transportKey: null } }, async () => {
            await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
            await sweepStaleSwarm(Date.now());
            expect(await maintenance()).toBeNull();
            let repair = null;
            for (let pass = 0; pass < 6 && !repair; pass++) {
              await vi.advanceTimersByTimeAsync(GOAL_QUIET_MS);
              await sweepStaleSwarm(Date.now());
              repair = await maintenance();
            }
            expect(repair).toMatchObject({ conversationId: chat, reason: 'silence' });
            // The reload changed nothing and the other chat's call still runs: the one automatic Continue is filed anyway, which is what never came in the reported run.
            await maintenance(repair!.token, 'reloaded');
            const session = (await findSessionByConversation(chat))!;
            let continues: Awaited<ReturnType<typeof input.listInputs>> = [];
            for (let pass = 0; pass < 6 && !continues.length; pass++) {
              await vi.advanceTimersByTimeAsync(GOAL_QUIET_MS);
              await sweepStaleSwarm(Date.now());
              continues = (await input.listInputs()).filter(row => row.sessionId === session.id && row.recovery);
            }
            expect(continues).toHaveLength(1);
          });
          const why = getLog().filter(entry => entry.message.includes(`silence recovery for ${chat}`)).map(entry => entry.message);
          expect(why.slice(0, 2)).toEqual([
            expect.stringContaining('a tool call whose chat is not known yet is running'),
            expect.stringContaining('going ahead: tool calls whose chat is not known have held it for 3 minutes')
          ]);
        } finally {
          // This suite runs without the app's delivery hooks; leave none behind for the next test.
          input.configureInputDelivery(null as never);
          await writeDurableNow('session-input', []); input.resetInputForTests(); vi.useRealTimers(); await saveConfig(previous);
        }
      });

  it.each(['normal', 'pro'] as const)('keeps the %s silence countdown and reload valid across same-turn corrections', async model => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true } });
        vi.useFakeTimers();
        try {
          await pair();
          const chat = randomUUID(), turnId = `corrected-${model}`;
          await events(chat, [
            { kind: 'user_message', messageId: 'question', text: 'Review the changes', time: Date.now(), authoredNow: true },
            { kind: 'model_selection', model: model === 'pro' ? 'gpt-6-pro' : 'GPT-5.6 Sol', reasoningEffort: model === 'pro' ? 'pro' : 'high', time: Date.now() },
            openTurn(turnId)
          ]);
          await attributed(chat, false, Date.now());
          const session = (await findSessionByConversation(chat))!;
          await vi.advanceTimersByTimeAsync(10_000);
          // The app records instructions delivered in MCP responses with inputId and their existing turn id. They are authored rows, but not a new generation.
          for (let index = 0; index < 3; index++) await sessionStoreModule.appendEvent(session.id, {
            kind: 'user_message', source: 'app', time: Date.now(), turnId,
            inputId: `correction-${index}`, messageId: `correction-${index}`,
            message: { text: 'Also inspect the recovery boundary.', truncated: false, chars: 35 }
          });
          await attributed(chat, false, Date.now());
          const window = model === 'pro' ? PRO_SILENCE_MS : CHAT_SILENCE_MS;
          const deadline = Date.now() + window, visibleAt = deadline - (model === 'pro' ? 300_000 : 30_000);
          expect((await sessionControlsFor(session.id)).recovery).toEqual([{ kind: 'silence', deadline, visibleAt }]);
          await vi.advanceTimersByTimeAsync(visibleAt - Date.now());
          expect((await sessionControlsFor(session.id)).recovery).toEqual([{ kind: 'silence', deadline, visibleAt }]);
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(deadline - Date.now());
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          expect(repair).toMatchObject({ conversationId: chat, reason: 'silence' });
          expect((await request('POST', '/repairs/claim', { body: { token: repair!.token } })).body.allowed).toBe(true);
          // An acknowledged claim retains custody rather than buying another reload.
          expect(await maintenance()).toBeNull();
          await maintenance(repair!.token, 'reloaded');
          expect((await readEvents(session.id, { kinds: ['progress'] })).some(event =>
            event.kind === 'progress' && event.message.text.includes('Reloaded chat'))).toBe(true);
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });

  it.each(['new-question', 'foreign-correction', 'stopped'] as const)('retires silence recovery at a %s boundary instead of repeatedly queuing it', async boundary => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true } });
        vi.useFakeTimers();
        try {
          await pair();
          const chat = randomUUID(), turnId = 'retired-correction-source';
          await events(chat, [openTurn(turnId)]);
          await attributed(chat, false, Date.now());
          const session = (await findSessionByConversation(chat))!;
          await sessionStoreModule.appendEvent(session.id, {
            kind: 'user_message', source: 'app', time: Date.now(), turnId,
            inputId: 'valid-correction', messageId: 'valid-correction',
            message: { text: 'Inspect the same task', truncated: false, chars: 21 }
          });
          if (boundary === 'stopped') await events(chat, [endTurn(turnId, 'stopped')]);
          else await sessionStoreModule.appendEvent(session.id, {
            kind: 'user_message', source: boundary === 'new-question' ? 'extension' : 'app', time: Date.now(),
            turnId: boundary === 'new-question' ? turnId : 'different-turn', messageId: 'next-question',
            ...(boundary === 'foreign-correction' ? { inputId: 'other-turn-input' } : {}),
            message: { text: 'A different task', truncated: false, chars: 16 }
          });
          for (let pass = 0; pass < 3; pass++) {
            await vi.advanceTimersByTimeAsync(CHAT_SILENCE_MS);
            await sweepStaleSwarm(Date.now());
            expect(await maintenance()).toBeNull();
            expect((await sessionControlsFor(session.id)).recovery).toEqual([]);
          }
          expect(getLog().filter(entry => entry.message.includes('asking the browser to reload') && entry.message.includes(chat))).toEqual([]);
          // It says why, once, however often the sweep passes (#1086: these exits used to be silent).
          const why = getLog().filter(entry => entry.message.includes(`silence recovery for ${chat}`)).map(entry => entry.message);
          expect(why).toEqual([expect.stringContaining('spent: the silent work is no longer this chat\'s current turn')]);
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });

  it('keeps a manually closed worker inactive through maintenance and late tool results', async () => {
        vi.useFakeTimers();
        try {
          await pair();
          spawn({ workers: [{ task: 'audit' }], caller: { conversationId: recoveryState.PRIME } });
          const bootstrap = await redeem();
          await request('POST', '/commands/ack', {
            body: { id: bootstrap.id, status: 'sent', conversationId: recoveryState.WORKER, agent: 'worker-1' }
          });
          await events(recoveryState.WORKER, [openTurn('manually-closed-worker')]);
          await attributed(recoveryState.WORKER, false, Date.now());
          const session = await findSessionByConversation(recoveryState.WORKER);
          const [call] = await readEvents(session!.id, { kinds: ['tool_call'] });
          expect(call?.kind).toBe('tool_call');
          await request('POST', '/closed', { body: { conversationId: recoveryState.WORKER, manual: true } });
          expect((await getSession(session!.id))?.browserRecoveryDismissedAt).toBe(Date.now());
          expect(await maintenance()).toBeNull();
          await vi.advanceTimersByTimeAsync(30_000);
          // The server keeps using its already-proven request, without any page observation.
          await recordToolCall({ tool: 'read', args: { paths: ['/project/worker.ts'] },
            content: [{ type: 'text', text: 'ok' }], outcome: 'ok', durationMs: 1,
            startedAt: Date.now(), requestId: call!.kind === 'tool_call' ? call!.call.requestId! : '' });
          expect(liveConversations().some(row => row.conversationId === recoveryState.WORKER)).toBe(false);
          expect((await sessionControlsFor(session!.id)).activeTurnId).toBeNull();
          for (let minute = 0; minute < 12; minute++) {
            await vi.advanceTimersByTimeAsync(60_000);
            await sweepStaleSwarm(Date.now());
            expect(await maintenance()).toBeNull();
            expect((await sessionControlsFor(session!.id)).recovery).toEqual([]);
          }
          expect(agentInfoForOwnedConversation(recoveryState.WORKER)?.state).toBe('sleeping');
          expect((await getSession(session!.id))?.browserRecoveryDismissedAt).toBeTruthy();
          // Tool history remains attributed; only an observed browser return clears dismissal.
          await request('GET', `/activity?conversationId=${recoveryState.WORKER}`);
          expect((await getSession(session!.id))?.browserRecoveryDismissedAt).toBeUndefined();
        } finally { vi.useRealTimers(); }
      });

  it.each(['normal', 'pro'] as const)('shows fresh MCP activity in a closed %s chat without restoring browser authority', async model => {
        const previous = getConfig();
        await saveConfig({ ...previous, ui: { ...previous.ui, autoContinue: true },
          multiAgent: { ...previous.multiAgent, recoverAgentTabs: false } });
        vi.useFakeTimers();
        try {
          await pair();
          const turnId = `closed-${model}`;
          const requestId = `wfr_closed_${model}_${++recoveryState.requests}`;
          const call = () => recordToolCall({ tool: 'read', args: { paths: ['/project/a.ts'] },
            content: [{ type: 'text' as const, text: 'ok' }], outcome: 'ok' as const,
            durationMs: 1, startedAt: Date.now(), requestId });
          await events(recoveryState.OTHER, [
            { kind: 'user_message', messageId: 'closed-question', text: 'Keep working', time: Date.now(), authoredNow: true },
            { kind: 'model_selection', model: model === 'pro' ? 'gpt-6-pro' : 'GPT-5.6 Sol', reasoningEffort: model === 'pro' ? 'pro' : 'high', time: Date.now() },
            openTurn(turnId),
            { kind: 'tool_evidence', time: Date.now(), turnId, calls: [{ messageId: 'closed-call', tool: 'read', order: 0, answered: false, requestId }] }
          ]);
          await call();
          const session = (await findSessionByConversation(recoveryState.OTHER))!;
          const { sessionActivityExpiresAt } = await import("../../../../../backend/domains/browser/bridge.js");
          const { sessionWorkingAt } = await import("../../../../../contracts/sessions/activity-state.js");
          const assertInactive = async (working = false) => {
            const summary = (await getSession(session.id))!;
            expect(sessionWorkingAt({ ...summary, activityExpiresAt: sessionActivityExpiresAt(summary) }, Date.now())).toBe(working);
            expect(await sessionControlsFor(session.id)).toMatchObject({ activeTurnId: null, canInject: false, recovery: [] });
          };
          for (let cycle = 0; cycle < 2; cycle++) {
            await request('POST', '/closed', { body: { conversationId: recoveryState.OTHER, manual: true } });
            await assertInactive();
            expect(await maintenance()).toBeNull();
            await vi.advanceTimersByTimeAsync(30_000);
            await call();
            await assertInactive(true);
            // A normal chat's display lasts three minutes, even though its reload clock is two. A closed page has no reload/Continue authority at either boundary.
            await vi.advanceTimersByTimeAsync(model === 'pro' ? 8 * 60_000 : 150_000);
            await sweepStaleSwarm(Date.now());
            await assertInactive(true);
            // Neither this exact call nor reading app controls pretends that a tab is open.
            expect(liveConversations().some(row => row.conversationId === recoveryState.OTHER)).toBe(false);
            if (cycle === 0) {
              await request('GET', `/activity?conversationId=${recoveryState.OTHER}`);
              await events(recoveryState.PRIME, [{ kind: 'user_message', messageId: 'other-tab', text: 'Unrelated chat', time: Date.now() }]);
            }
          }
          const window = model === 'pro' ? PRO_SILENCE_MS : CHAT_SILENCE_MS;
          await vi.advanceTimersByTimeAsync(window + 60_000);
          await sweepStaleSwarm(Date.now());
          await assertInactive();
          expect(await maintenance()).toBeNull();
          expect(reopened(recoveryState.OTHER)).toEqual([]);
          // Returning to the page re-enables recovery of this same unfinished source. It must work without another tool call or a fabricated new turn_start.
          await request('GET', `/activity?conversationId=${recoveryState.OTHER}`);
          expect((await getSession(session.id))?.browserRecoveryDismissedAt).toBeUndefined();
          await sweepStaleSwarm(Date.now());
          const repair = await maintenance();
          expect(repair).toMatchObject({ conversationId: recoveryState.OTHER, reason: 'silence' });
          expect((await request('POST', '/repairs/claim', { body: { token: repair!.token } })).body.allowed).toBe(true);
          await maintenance(repair!.token, 'reopened');
          // The restored page can discover a real final and retire this source's activity. Outbox/Goal pickup is exercised with the production hooks in input integration.
          await request('GET', `/activity?conversationId=${recoveryState.OTHER}`);
          await recordFinalForTest(recoveryState.OTHER, turnId);
          await events(recoveryState.OTHER, [endTurn(turnId, 'completed')]);
          expect((await sessionControlsFor(session.id)).activeTurnId).toBeNull();
          expect(await maintenance()).toBeNull();
        } finally { vi.useRealTimers(); await saveConfig(previous); }
      });
});
